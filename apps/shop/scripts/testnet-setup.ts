// Creates the testnet accounts behind /shop and /bounties, skipping any step already done:
// publishes the contract's code hash on our factory, deploys the community DAO (the same
// Sputnik v3.2 code as mainnet's sputnik-dao.near, left with no keys), creates the shop and
// the bounty account from the factory, adds their agents, has the DAO fund the bounties and
// posts the first ones.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Account,
  actions,
  getTransactionLastResult,
  JsonRpcProvider,
  KeyPair,
  type KeyPairString,
} from "near-api-js";

const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const ROOT = join(import.meta.dirname, "../../..");
const CREDS = join(homedir(), ".near-credentials/testnet");

const FACTORY = "factory.ps-spike-1028.testnet";
const ADMIN = "ps-spike-1028.testnet";
const COUNCIL = [ADMIN, "ps-funder-1101.testnet"];
const DAO = "ps-community-1107.testnet";
const SHOP = `shop.${FACTORY}`;
const BOUNTIES = `bounties.${FACTORY}`;
const MPC = "v1.signer-prod.testnet";
const VERSION = "0.2.0-dev.1";

const TGAS = 10n ** 12n;
const N = (near: number) => (BigInt(Math.round(near * 1_000)) * 10n ** 21n).toString();
const provider = new JsonRpcProvider({ url: RPC });

function signer(accountId: string): Account {
  const file = join(CREDS, `${accountId}.json`);
  if (!existsSync(file)) throw new Error(`no key for ${accountId} in ${CREDS}`);
  const key = JSON.parse(readFileSync(file, "utf8")).private_key as KeyPairString;
  return new Account(accountId, provider, key);
}

async function rpc<T>(params: Record<string, unknown>): Promise<T | undefined> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "query",
      params: { finality: "final", ...params },
    }),
  });
  const body = (await res.json()) as { result?: T & { error?: string } };
  return body.result && !body.result.error ? body.result : undefined;
}

const codeHashOf = async (id: string) =>
  (await rpc<{ code_hash: string }>({ request_type: "view_account", account_id: id }))?.code_hash;

async function view<T>(
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

async function call(
  from: Account,
  receiverId: string,
  method: string,
  args: object | Uint8Array,
  deposit = 0n,
  tgas = 100n,
) {
  const res = await from.signAndSendTransaction({
    receiverId,
    actions: [actions.functionCall(method, args, tgas * TGAS, deposit)],
  });
  const hash = (res as unknown as { transaction: { hash: string } }).transaction.hash;
  console.log(`  ${from.accountId} → ${receiverId}.${method}: ${hash}`);
  return getTransactionLastResult(res as never);
}

const base58 = (bytes: Uint8Array) => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = A[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
};

const borshBytes = (b: Uint8Array) => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};

/** Votes a DAO proposal through with every council member until it's no longer in progress. */
async function daoDo(description: string, kind: Record<string, unknown>) {
  const proposer = signer(COUNCIL[1] as string);
  const id = (await call(
    proposer,
    DAO,
    "add_proposal",
    { proposal: { description, kind } },
    10n ** 24n,
  )) as number;
  for (const member of COUNCIL) {
    const p = await view<{ status: string }>(DAO, "get_proposal", { id });
    if (p.status !== "InProgress") break;
    await call(
      signer(member),
      DAO,
      "act_proposal",
      { id, action: "VoteApprove", proposal: kind },
      0n,
      300n,
    );
  }
  const p = await view<{ status: string }>(DAO, "get_proposal", { id });
  console.log(`  proposal ${id} "${description}": ${p.status}`);
  if (p.status !== "Approved") throw new Error(`proposal ${id} ended ${p.status}`);
}

async function addAgent(account: string, viaDao: boolean) {
  const file = join(CREDS, `${account}.json`);
  if (existsSync(file)) return console.log(`agent key for ${account} already saved`);
  const key = KeyPair.fromRandom("ed25519");
  const args = { public_key: key.getPublicKey().toString(), allowance: N(1) };
  if (viaDao) {
    await daoDo(`Add the bounty agent's key to ${account}`, {
      FunctionCall: {
        receiver_id: account,
        actions: [
          {
            method_name: "add_agent",
            args: Buffer.from(JSON.stringify(args)).toString("base64"),
            deposit: "1",
            gas: (100n * TGAS).toString(),
          },
        ],
      },
    });
  } else {
    await call(signer(ADMIN), account, "add_agent", args, 1n);
  }
  mkdirSync(CREDS, { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      account_id: account,
      public_key: args.public_key,
      private_key: key.toString(),
    }),
    { mode: 0o600 },
  );
  console.log(`agent key for ${account} saved to ${file}`);
}

async function create(name: string, creator: string, owner: string, ops: object[], code: Buffer) {
  const id = `${name}.${FACTORY}`;
  if (await codeHashOf(id)) return console.log(`${id} exists`);
  const newArgs = Buffer.from(JSON.stringify({ owner, mpc: MPC, intents: "intents.near", ops }));
  const args = Buffer.concat([
    borshBytes(Buffer.from(name)),
    borshBytes(code),
    borshBytes(newArgs),
  ]);
  await call(signer(creator), FACTORY, "create", args, BigInt(N(7)), 300n);
  console.log(`created ${id} (code ${await codeHashOf(id)})`);
}

const code = readFileSync(join(ROOT, "target/near/pursestrings/pursestrings.wasm"));
const hash = base58(createHash("sha256").update(code).digest());
console.log(`contract ${code.length} bytes, code hash ${hash}`);
if (await view<boolean>(FACTORY, "is_published", { code_hash: hash })) {
  console.log("already published");
} else {
  await call(signer(ADMIN), FACTORY, "publish", { code_hash: hash, version: VERSION }, 1n);
}

const daoCode = readFileSync(
  join(ROOT, "contracts/pursestrings/tests/fixtures/sputnikdao2-3.2.wasm"),
);
if ((await codeHashOf(DAO)) === base58(createHash("sha256").update(daoCode).digest())) {
  console.log(`${DAO} already runs Sputnik v3.2`);
} else {
  const dao = signer(DAO);
  const res = await dao.signAndSendTransaction({
    receiverId: DAO,
    actions: [
      actions.deployContract(daoCode),
      actions.functionCall(
        "new",
        {
          config: {
            name: "Pursestrings community",
            purpose: "Grows the scam list behind Check before you pay",
            metadata: "",
          },
          policy: COUNCIL,
        },
        100n * TGAS,
        0n,
      ),
    ],
  });
  console.log(
    `  deployed Sputnik v3.2 to ${DAO}: ${(res as unknown as { transaction: { hash: string } }).transaction.hash}`,
  );
}

await create(
  "shop",
  "ps-fund-1107a.testnet",
  ADMIN,
  [
    {
      SetAssetRule: {
        asset: "Near",
        per_tx_cap: N(0.2),
        windows: [{ period_s: 86_400, limit: N(0.5) }],
        cosign_above: N(0.1),
        risk_check_above: null,
      },
    },
    { SetPriceFloor: { asset: "Near", min: N(0.05) } },
    {
      SetSplit: {
        shares: [
          { account: ADMIN, bps: 7_000 },
          { account: DAO, bps: 2_000 },
        ],
      },
    },
    { SetRefundLimit: { asset: "Near", window: { period_s: 86_400, limit: N(0.3) } } },
    { SetVelocity: { velocity: { max: 20, period_s: 3_600 } } },
    { SetFeeBudget: { period_s: 86_400, limit: "1000" } },
    { SetPendingTtl: { seconds: 1_800 } },
    { SetDeliveryWindow: { seconds: 600 } },
    { SetTimelock: { seconds: 3_600 } },
  ],
  code,
);
await addAgent(SHOP, false);

await create(
  "bounties",
  "ps-fund-1107b.testnet",
  DAO,
  [
    {
      SetAssetRule: {
        asset: "Near",
        per_tx_cap: N(1),
        windows: [{ period_s: 86_400, limit: N(3) }],
        cosign_above: null,
        risk_check_above: null,
      },
    },
    ...COUNCIL.map((account) => ({ AddCouncil: { account } })),
    {
      SetTrust: {
        asset: "Near",
        tiers: [
          { points: 0, auto_up_to: "0", council_up_to: N(0.3) },
          { points: 1, auto_up_to: N(0.1), council_up_to: N(0.5) },
          { points: 3, auto_up_to: N(0.3), council_up_to: N(1) },
        ],
      },
    },
    { SetVelocity: { velocity: { max: 20, period_s: 3_600 } } },
    { SetPendingTtl: { seconds: 86_400 } },
    { SetTimelock: { seconds: 3_600 } },
  ],
  code,
);
await addAgent(BOUNTIES, true);

const funded = await rpc<{ amount: string }>({
  request_type: "view_account",
  account_id: BOUNTIES,
});
if (BigInt(funded?.amount ?? "0") < BigInt(N(8))) {
  await daoDo("Fund the bounty budget", {
    Transfer: { token_id: "", receiver_id: BOUNTIES, amount: N(2), msg: null },
  });
}
// The first bounties, posted by a council member. Each paid one adds an address to the shop's
// scam list and a point to the claimant's record.
const BOUNTY_LIST: [string, number][] = [
  ["Report an account imitating a testnet name people pay: scam:<account> <evidence>", 0.05],
  [
    "Report an account imitating the shop, the DAO or the bounty board: scam:<account> <evidence>",
    0.05,
  ],
  ["Report a Base Sepolia address used for address poisoning: scam:<0x address> <tx link>", 0.1],
];
if ((await view<number>(BOUNTIES, "next_bounty_id")) === 0) {
  const council = signer(COUNCIL[1] as string);
  for (const [title, reward] of BOUNTY_LIST) {
    await call(
      council,
      BOUNTIES,
      "post_bounty",
      { title, asset: "Near", reward: N(reward) },
      1n,
      30n,
    );
  }
}

const keys = await rpc<{ keys: unknown[] }>({
  request_type: "view_access_key_list",
  account_id: DAO,
});
if (keys?.keys.length) {
  console.log(`${DAO} still has ${keys.keys.length} key(s); delete them once the setup is final`);
}

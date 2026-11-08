// Upgrades the bounty board to target/near/pursestrings/pursestrings.wasm the way its owner has to:
// the factory admin publishes the code hash, the DAO votes a Migrate proposal, the proposal waits
// out the board's timelock, then the code is delivered. Rerun after the timelock to finish.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actions } from "near-api-js";
import {
  ADMIN,
  BOUNTIES,
  base58,
  borshBytes,
  COUNCIL,
  call,
  codeHashOf,
  DAO,
  daoDo,
  FACTORY,
  N,
  ROOT,
  rpc,
  signer,
  TGAS,
  view,
} from "./testnet.ts";

const VERSION = process.argv[2] ?? "0.2.0-dev.2";
const STORAGE_PER_BYTE = 10n ** 19n;

type Proposal = { ops: { Migrate?: { code_hash: string } }[]; eta: number };

const code = readFileSync(join(ROOT, "target/near/pursestrings/pursestrings.wasm"));
const hash = base58(createHash("sha256").update(code).digest());
console.log(`contract ${code.length} bytes, code hash ${hash}`);
if ((await codeHashOf(BOUNTIES)) === hash) {
  console.log(`${BOUNTIES} already runs it`);
  process.exit(0);
}
if (!(await view<boolean>(FACTORY, "is_published", { code_hash: hash }))) {
  await call(signer(ADMIN), FACTORY, "publish", { code_hash: hash, version: VERSION }, 1n);
}

const queued = async () =>
  (await view<[number, Proposal][]>(BOUNTIES, "proposals")).find(
    ([, p]) => p.ops.length === 1 && p.ops[0]?.Migrate?.code_hash === hash,
  );
let migration = await queued();
if (!migration) {
  await daoDo(`Upgrade the bounty board to ${hash}`, {
    FunctionCall: {
      receiver_id: BOUNTIES,
      actions: [
        {
          method_name: "propose",
          args: Buffer.from(JSON.stringify({ ops: [{ Migrate: { code_hash: hash } }] })).toString(
            "base64",
          ),
          deposit: "1",
          gas: (100n * TGAS).toString(),
        },
      ],
    },
  });
  migration = await queued();
  if (!migration) throw new Error("the DAO's proposal didn't queue a migration");
}
const [id, { eta }] = migration;
const wait = eta - Math.floor(Date.now() / 1000);
if (wait > 0) {
  console.log(`migration ${id} is timelocked for ${Math.ceil(wait / 60)} more min; rerun then`);
  process.exit(0);
}

const idBytes = Buffer.alloc(8);
idBytes.writeBigUInt64LE(BigInt(id));
const args = Buffer.concat([idBytes, borshBytes(code)]);
try {
  await call(signer(COUNCIL[1] as string), BOUNTIES, "apply_migration", args, 1n, 300n);
} catch (e) {
  // Code from before anyone could deliver a migration only takes it from the owner, so the DAO
  // has to hold the wasm in a proposal, paying its storage.
  if (!String(e).includes("owner only")) throw e;
  console.log(
    "this board's code takes the migration from its owner only: delivering through the DAO",
  );
  const dao = await rpc<{ amount: string; storage_usage: number }>({
    request_type: "view_account",
    account_id: DAO,
  });
  if (!dao) throw new Error(`can't read ${DAO}`);
  const free = BigInt(dao.amount) - BigInt(dao.storage_usage) * STORAGE_PER_BYTE;
  const need = BigInt(code.length) * STORAGE_PER_BYTE + BigInt(N(0.5));
  let short = need - free;
  for (const from of ["ps-fund-1107a.testnet", "ps-fund-1107b.testnet"]) {
    if (short <= 0n) break;
    const amount = short < BigInt(N(1.5)) ? short : BigInt(N(1.5));
    short -= amount;
    const res = await signer(from).signAndSendTransaction({
      receiverId: DAO,
      actions: [actions.transfer(amount)],
    });
    const tx = (res as unknown as { transaction: { hash: string } }).transaction.hash;
    console.log(
      `  ${from} → ${DAO}: ${Number(amount / 10n ** 21n) / 1000} NEAR for storage (${tx})`,
    );
  }
  await daoDo(`Deliver the code for migration ${id} of the bounty board`, {
    FunctionCall: {
      receiver_id: BOUNTIES,
      actions: [
        {
          method_name: "apply_migration",
          args: args.toString("base64"),
          deposit: "1",
          gas: (180n * TGAS).toString(),
        },
      ],
    },
  });
}
const now = await codeHashOf(BOUNTIES);
console.log(`${BOUNTIES} code hash: ${now}`);
if (now !== hash) throw new Error("the migration didn't land");

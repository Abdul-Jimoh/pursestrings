// Upgrades a factory account to target/near/pursestrings/pursestrings.wasm the way its owner has
// to: the factory admin publishes the code hash, the owner (a wallet, or the DAO by a vote)
// proposes the Migrate, it waits out the account's timelock, then the code is delivered.
// Rerun after the timelock to finish. Usage: upgrade.ts <account> [version]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN,
  base58,
  borshBytes,
  COUNCIL,
  call,
  codeHashOf,
  DAO,
  daoDo,
  FACTORY,
  ROOT,
  rpc,
  signer,
  TGAS,
  view,
} from "./testnet.ts";

const ACCOUNT = process.argv[2];
if (!ACCOUNT) throw new Error("usage: upgrade.ts <account> [version]");
const VERSION = process.argv[3] ?? "0.2.0-dev.3";

type Proposal = { ops: { Migrate?: { code_hash: string } }[]; eta: number };

const code = readFileSync(join(ROOT, "target/near/pursestrings/pursestrings.wasm"));
const hash = base58(createHash("sha256").update(code).digest());
console.log(`contract ${code.length} bytes, code hash ${hash}`);
if ((await codeHashOf(ACCOUNT)) === hash) {
  console.log(`${ACCOUNT} already runs it`);
  process.exit(0);
}
if (!(await view<boolean>(FACTORY, "is_published", { code_hash: hash }))) {
  await call(signer(ADMIN), FACTORY, "publish", { code_hash: hash, version: VERSION }, 1n);
}
const owner = await view<string>(ACCOUNT, "owner");

const queued = async () =>
  (await view<[number, Proposal][]>(ACCOUNT, "proposals")).find(
    ([, p]) => p.ops.length === 1 && p.ops[0]?.Migrate?.code_hash === hash,
  );
let migration = await queued();
// Orders paid and shares left unpaid under code that didn't track held NEAR may stay
// unprotected after the upgrade (`migrate` only recounts the newest orders), so a shop upgrades
// with none open, and with no open quote that could be paid under the old code meanwhile.
const open: number[] = [];
const quoted: number[] = [];
const nowS = Math.floor(Date.now() / 1000);
for (let before = await view<number>(ACCOUNT, "next_order_id"); before > 0; before -= 100) {
  const page = await view<[number, { status: string; expires_at: number }][]>(
    ACCOUNT,
    "recent_orders",
    {
      before,
      limit: 100,
    },
  );
  open.push(...page.filter(([, o]) => o.status === "Paid").map(([id]) => id));
  quoted.push(
    ...page.filter(([, o]) => o.status === "Quoted" && o.expires_at > nowS).map(([id]) => id),
  );
}
const split = (await view<{ split: { account: string }[] }>(ACCOUNT, "policy")).split;
const unpaid: string[] = [];
for (const { account } of split) {
  const owed = await view<string>(ACCOUNT, "unpaid", { account, asset: "Near" });
  if (owed !== "0") unpaid.push(`${account} (${owed} yocto)`);
}
if ((open.length || unpaid.length || quoted.length) && process.env.ALLOW_OPEN_ORDERS !== "1")
  throw new Error(
    `deliver or refund paid orders [${open.join(", ")}], retry unpaid shares [${unpaid.join(", ")}] and let quotes [${quoted.join(", ")}] expire first`,
  );
// The new code sets aside every agent key's gas allowance and, for a shop, its free quote slots'
// storage; below that, payments and refunds after delivery are refused until it's topped up.
const acct = await rpc<{ amount: string; storage_usage: number }>({
  request_type: "view_account",
  account_id: ACCOUNT,
});
const BYTE = 10n ** 19n;
const allowances = (await view<[string, { allowance: string }][]>(ACCOUNT, "agents")).reduce(
  (sum, [, a]) => sum + BigInt(a.allowance),
  0n,
);
const policy = await view<{ floors: { asset: unknown }[] }>(ACCOUNT, "policy");
const sells = policy.floors.some((f) => f.asset === "Near");
const reserves = allowances + (sells ? 64n * 1_000n * BYTE : 0n) + (1_000n + 1_500n) * BYTE;
const free = acct ? BigInt(acct.amount) - BigInt(acct.storage_usage) * BYTE : 0n;
if (free < reserves && process.env.ALLOW_LOW_BALANCE !== "1")
  throw new Error(
    `${ACCOUNT} has ${free} yocto free; the new code sets aside ${reserves} (agent gas, quote slots, one order and one request). Top it up or revoke unused agent keys first`,
  );
if (!migration) {
  const args = { ops: [{ Migrate: { code_hash: hash } }] };
  if (owner === DAO) {
    await daoDo(`Upgrade ${ACCOUNT} to ${hash}`, {
      FunctionCall: {
        receiver_id: ACCOUNT,
        actions: [
          {
            method_name: "propose",
            args: Buffer.from(JSON.stringify(args)).toString("base64"),
            deposit: "1",
            gas: (100n * TGAS).toString(),
          },
        ],
      },
    });
  } else {
    await call(signer(owner), ACCOUNT, "propose", args, 1n);
  }
  // Views read final state, a few seconds behind the transaction.
  for (let i = 0; i < 10 && !migration; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    migration = await queued();
  }
  if (!migration) throw new Error("the owner's proposal didn't queue a migration");
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
// Code from before c971ec6 takes the migration from its owner only. A DAO owner can't send it:
// a vote that carries the wasm leaves too little of the 300 Tgas for the call (build log, Nov 8).
const from = owner === DAO ? (COUNCIL[1] as string) : owner;
try {
  await call(signer(from), ACCOUNT, "apply_migration", args, 1n, 300n);
} catch (e) {
  if (owner === DAO && String(e).includes("owner only")) {
    throw new Error(`${ACCOUNT} runs code that takes a migration from its owner only, a DAO here`);
  }
  throw e;
}
let now = await codeHashOf(ACCOUNT);
for (let i = 0; i < 10 && now !== hash; i++) {
  await new Promise((r) => setTimeout(r, 2_000));
  now = await codeHashOf(ACCOUNT);
}
console.log(`${ACCOUNT} code hash: ${now}`);
if (now !== hash) throw new Error("the migration didn't land");

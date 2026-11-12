// The attack marathon on testnet: about a thousand attempts against the shop and the bounty
// board, from a fooled agent's key and from an outside account. Each one must be refused,
// either as a logged decision (a NEAR event) or as a failed transaction. Results go to
// apps/shop/data/marathon.jsonl, and a summary with sample transactions to the site.
// Usage: marathon.ts [count], or marathon.ts summarize to rebuild the summary from the log.
// MARATHON_RUN names the run (its log file); the summary records the shop's code hash.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Outcome, Pursestrings } from "@pursestrings/sdk";
import { KeyPair } from "near-api-js";
import { BOUNTIES, CREDS, N, ROOT, RPC, SHOP } from "./testnet.ts";

const TOTAL = Number(process.argv[2] ?? 1000);
const OWNER = "ps-spike-1028.testnet";
const BUYER = "ps-fund-1109a.testnet";
const ATTACKER = "ps-fund-1109b.testnet";
const FLOOR = BigInt(N(0.05));
const RUN = process.env.MARATHON_RUN ?? "marathon";
const OUT = join(ROOT, `apps/shop/data/${RUN}.jsonl`);
const SUMMARY = join(ROOT, "apps/web/public/marathon.json");

// What each outright rejection must say to count as refused. Anything else, such as a network
// error, is inconclusive. Logged decisions count only when the contract said Denied.
const EXPECT: Record<string, RegExp> = {
  "outsider pays a quote made for someone else": /quote is for another buyer|quote expired/,
  "buyer pays less than the quote": /less than the price|quote expired/,
  "outsider pays an order that doesn't exist": /unknown order/,
  "outsider lowers the floor": /owner only/,
  "outsider redirects the split": /owner only/,
  "outsider withdraws the shop's NEAR": /owner only/,
  "outsider delivers an order": /agents call through their access key/,
  "outsider approves a bounty payout": /council only/,
  "outsider posts a bounty": /owner or council only/,
  "outsider freezes the board": /owner or council only/,
  "agent key calls an owner method": /DepositWithFunctionCall|MethodNameMismatch/,
  "owner withdraws NEAR held for buyers": /held for buyers or unpaid shares/,
  "buyer takes a payment back before the delivery deadline": /still has time to deliver/,
  "outsider takes back someone else's payment": /only the buyer/,
  "contributor claims a second bounty while holding one": /finish or give up your current claim/,
};

if (process.argv[2] === "summarize") {
  await summarize(
    readFileSync(OUT, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Result),
  );
  process.exit(0);
}

const keyOf = (id: string) =>
  JSON.parse(readFileSync(join(CREDS, `${id}.json`), "utf8")).private_key as string;

const shop = new Pursestrings(RPC, SHOP);
const board = new Pursestrings(RPC, BOUNTIES);

// A separate agent key for the marathon, so it never races the hosted shop for nonces.
const MARATHON_KEY = join(CREDS, `marathon.${SHOP}.json`);
const onChain = async (publicKey: string) => {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "query",
      params: {
        request_type: "view_access_key",
        finality: "final",
        account_id: SHOP,
        public_key: publicKey,
      },
    }),
  });
  const d = (await res.json()) as { error?: unknown; result?: { error?: unknown } };
  return d.result !== undefined && d.error === undefined && d.result.error === undefined;
};
if (
  existsSync(MARATHON_KEY) &&
  !(await onChain(
    KeyPair.fromString(keyOf(`marathon.${SHOP}`) as never)
      .getPublicKey()
      .toString(),
  ))
) {
  // The last run's key was revoked when it finished.
  unlinkSync(MARATHON_KEY);
}
if (!existsSync(MARATHON_KEY)) {
  const k = KeyPair.fromRandom("ed25519");
  const added = await shop
    .owned(OWNER, keyOf(OWNER))
    .addAgent(k.getPublicKey().toString(), BigInt(N(1)));
  if (!added.ok) throw new Error(`add_agent: ${added.error}`);
  writeFileSync(MARATHON_KEY, JSON.stringify({ private_key: k.toString() }), { mode: 0o600 });
  console.log(`marathon agent key added to ${SHOP}: ${added.txHash}`);
}
const fooled = shop.agent(keyOf(`marathon.${SHOP}`));
const boardAgent = board.agent(keyOf(BOUNTIES));
const buyer = shop.caller(BUYER, keyOf(BUYER));
const attacker = shop.caller(ATTACKER, keyOf(ATTACKER));
const boardAttacker = board.caller(ATTACKER, keyOf(ATTACKER));
const owner = shop.owned(OWNER, keyOf(OWNER));

type How = "event" | "failed" | "protocol";
interface Result {
  n: number;
  at: number;
  kind: string;
  refused: boolean;
  how: How;
  why: string;
  tx: string | null;
}

/** A call whose refusal is a logged decision: refused only if the contract said Denied. */
async function decided(o: Outcome<unknown>): Promise<Omit<Result, "n" | "at" | "kind">> {
  const v = o.value as Record<string, unknown> | string | undefined;
  if (v && typeof v === "object" && "Denied" in v) {
    return { refused: true, how: "event", why: JSON.stringify(v.Denied), tx: o.txHash };
  }
  return { refused: false, how: "event", why: JSON.stringify(v ?? o.error), tx: o.txHash };
}

/** A call the contract or the protocol must reject outright. */
async function rejected(p: Promise<Outcome<unknown>>): Promise<Omit<Result, "n" | "at" | "kind">> {
  try {
    const o = await p;
    return o.ok
      ? { refused: false, how: "failed", why: "succeeded", tx: o.txHash }
      : { refused: true, how: "failed", why: panic(o.error ?? ""), tx: o.txHash };
  } catch (e) {
    return { refused: true, how: "protocol", why: String(e).slice(0, 160), tx: null };
  }
}

const panic = (e: string) => (/panicked: ([^"\\]+)/.exec(e)?.[1] ?? e).slice(0, 160);
const rand = (n: number) => Math.floor(Math.random() * n);
const below = (max: bigint) => (BigInt(rand(1_000_000) + 1) * max) / 1_000_001n;

// Setup: one quote left open for the buyer, and one order the buyer paid and got delivered.
const open = await fooled.quote(BUYER, "Near", FLOOR + BigInt(N(0.03)), "check:marathon.testnet");
if (!open.value || !("Quoted" in open.value)) throw new Error(`quote: ${JSON.stringify(open)}`);
const openId = open.value.Quoted.order_id;
const sale = await fooled.quote(BUYER, "Near", FLOOR, "check:ps-cornmunity-1107.testnet");
if (!sale.value || !("Quoted" in sale.value)) throw new Error(`quote: ${JSON.stringify(sale)}`);
const soldId = sale.value.Quoted.order_id;
const paid = await buyer.payNear(soldId, FLOOR);
if (!paid.ok) throw new Error(`pay: ${paid.error}`);
for (let i = 0; i < 30 && (await shop.order(soldId))?.status !== "Delivered"; i++) {
  await new Promise((r) => setTimeout(r, 2_000));
}
if ((await shop.order(soldId))?.status !== "Delivered") {
  await fooled.deliver(soldId, "marathon setup");
}
console.log(`setup: open quote ${openId}, delivered order ${soldId} (paid ${paid.txHash})`);

// A paid order the hosted worker never delivers (it only delivers checks), so the buyer's NEAR
// stays held. Once its delivery window closes the buyer may take it back, so a fresh one replaces
// it before then, and the old one is reclaimed by the buyer as the contract allows.
const HELD_PRICE = FLOOR + BigInt(N(0.01));
let held = { id: -1, paidAt: 0 };
const stale: number[] = [];
async function heldOrder(): Promise<number> {
  if (held.id >= 0 && Date.now() - held.paidAt < 6 * 60_000) return held.id;
  if (held.id >= 0) stale.push(held.id);
  const q = await fooled.quote(BUYER, "Near", HELD_PRICE, "marathon:held");
  if (!q.value || !("Quoted" in q.value)) throw new Error(`held quote: ${JSON.stringify(q)}`);
  const p = await buyer.payNear(q.value.Quoted.order_id, HELD_PRICE);
  if (!p.ok) throw new Error(`held pay: ${p.error}`);
  held = { id: q.value.Quoted.order_id, paidAt: Date.now() };
  console.log(`held order ${held.id} paid (${p.txHash})`);
  for (const id of stale.splice(0)) await reclaimWhenLate(id);
  return held.id;
}
async function reclaimWhenLate(id: number) {
  const o = await shop.order(id);
  if (o?.status !== "Paid") return;
  const wait = (o.deliver_by ?? 0) * 1000 - Date.now();
  if (wait > 0) {
    stale.push(id);
    return;
  }
  const r = await buyer.reclaim(id);
  console.log(`buyer reclaimed late order ${id}: ${r.ok ? r.txHash : r.error}`);
}
const shopBalance = async () => {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: SHOP },
    }),
  });
  return BigInt(((await res.json()) as { result: { amount: string } }).result.amount);
};
await heldOrder();

const attacks: [string, number, () => Promise<Omit<Result, "n" | "at" | "kind">>][] = [
  [
    "agent quotes under the floor",
    28,
    async () => decided(await fooled.quote(BUYER, "Near", below(FLOOR), "check:x.testnet")),
  ],
  [
    "agent refunds an order nobody paid",
    6,
    async () => decided(await fooled.refund(openId, below(FLOOR * 2n), "goodwill")),
  ],
  [
    "agent refunds more than the shop kept",
    10,
    async () => {
      const held = BigInt((await shop.order(soldId))?.held ?? "0");
      return decided(await fooled.refund(soldId, held + 1n + below(FLOOR), "the buyer is upset"));
    },
  ],
  [
    "agent pays someone off the allowlist",
    10,
    async () =>
      decided(
        await fooled.requestSpend({
          asset: "Near",
          amount: below(BigInt(N(0.2))).toString(),
          dest: { Near: { account: ATTACKER } },
          purpose: "urgent invoice",
          idempotency_key: `marathon-${Date.now()}-${rand(1e9)}`,
        }),
      ),
  ],
  [
    "bounty agent pays someone other than the claimant",
    10,
    async () =>
      decided(
        await boardAgent.requestSpend({
          asset: "Near",
          amount: below(BigInt(N(0.1))).toString(),
          dest: { Near: { account: ATTACKER } },
          purpose: "bounty",
          idempotency_key: `marathon-${Date.now()}-${rand(1e9)}`,
          // Not bounty 6: the attacker really holds that claim, so paying it isn't this attack.
          bounty: [0, 1, 2, 3, 4, 5, 7][rand(7)] as number,
        }),
      ),
  ],
  [
    "outsider pays a quote made for someone else",
    6,
    () => rejected(attacker.payNear(openId, FLOOR + BigInt(N(0.03)))),
  ],
  ["buyer pays less than the quote", 4, () => rejected(buyer.payNear(openId, below(FLOOR)))],
  [
    "outsider pays an order that doesn't exist",
    3,
    () => rejected(attacker.payNear(100_000 + rand(1e6), FLOOR)),
  ],
  [
    "outsider lowers the floor",
    4,
    () =>
      rejected(
        attacker.call(
          "propose",
          { ops: [{ SetPriceFloor: { asset: "Near", min: "1" } }] },
          { deposit: 1n },
        ),
      ),
  ],
  [
    "outsider redirects the split",
    4,
    () =>
      rejected(
        attacker.call(
          "propose",
          { ops: [{ SetSplit: { shares: [{ account: ATTACKER, bps: 10_000 }] } }] },
          { deposit: 1n },
        ),
      ),
  ],
  [
    "outsider withdraws the shop's NEAR",
    3,
    () => rejected(attacker.call("withdraw", { asset: "Near", amount: N(0.1) }, { deposit: 1n })),
  ],
  [
    "outsider delivers an order",
    2,
    () => rejected(attacker.call("deliver", { order_id: openId, receipt: "fake" })),
  ],
  ["outsider approves a bounty payout", 3, () => rejected(boardAttacker.councilApprove(rand(20)))],
  [
    "outsider posts a bounty",
    2,
    () => rejected(boardAttacker.postBounty("free money", "Near", BigInt(N(1)))),
  ],
  ["outsider freezes the board", 2, () => rejected(boardAttacker.freeze())],
  [
    "agent key calls an owner method",
    3,
    () => rejected(fooled.call("withdraw", { asset: "Near", amount: N(0.1) }, { deposit: 1n })),
  ],
  [
    "agent refunds part of a paid, undelivered order",
    8,
    async () =>
      decided(await fooled.refund(await heldOrder(), below(HELD_PRICE), "partial goodwill")),
  ],
  [
    // Asks for everything the account holds: more than is free, whatever lands meanwhile.
    "owner withdraws NEAR held for buyers",
    6,
    async () => {
      await heldOrder();
      return rejected(owner.withdraw("Near", await shopBalance()));
    },
  ],
  [
    "buyer takes a payment back before the delivery deadline",
    5,
    async () => rejected(buyer.reclaim(await heldOrder())),
  ],
  [
    "outsider takes back someone else's payment",
    5,
    async () => rejected(attacker.reclaim(await heldOrder())),
  ],
  [
    "contributor claims a second bounty while holding one",
    4,
    () => rejected(boardAttacker.claimBounty(8)),
  ],
  [
    "bounty agent pays a claimant more than the reward",
    6,
    async () => {
      const b = await board.view<{ reward: string; claimant: string | null } | null>("bounty", {
        id: 6,
      });
      return decided(
        await boardAgent.requestSpend({
          asset: "Near",
          amount: (BigInt(b?.reward ?? "0") + 1n + below(BigInt(N(0.1)))).toString(),
          dest: { Near: { account: b?.claimant ?? ATTACKER } },
          purpose: "bounty",
          idempotency_key: `marathon-${Date.now()}-${rand(1e9)}`,
          bounty: 6,
        }),
      );
    },
  ],
];

const weight = attacks.reduce((a, [, w]) => a + w, 0);
const pickAttack = () => {
  let r = rand(weight);
  for (const a of attacks) {
    r -= a[1];
    if (r < 0) return a;
  }
  return attacks[0] as (typeof attacks)[number];
};

mkdirSync(join(ROOT, "apps/shop/data"), { recursive: true });
const done = existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).length : 0;
const results: Result[] = existsSync(OUT)
  ? readFileSync(OUT, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Result)
  : [];
for (let n = done; n < TOTAL; n++) {
  const [kind, , run] = pickAttack();
  const r: Result = { n, at: Date.now(), kind, ...(await run()) };
  appendFileSync(OUT, `${JSON.stringify(r)}\n`);
  results.push(r);
  if (!r.refused) console.log(`NOT REFUSED #${n} ${kind}: ${r.why} ${r.tx}`);
  if (n % 50 === 0) console.log(`${n}/${TOTAL}`);
}

await summarize(results);

// Tidy up: the buyer takes the last held payment back once it's late, and the key goes.
if (held.id >= 0) stale.push(held.id);
while (stale.length) {
  const id = stale.shift() as number;
  const o = await shop.order(id);
  const wait = (o?.deliver_by ?? 0) * 1000 - Date.now();
  if (o?.status === "Paid" && wait > 0) await new Promise((r) => setTimeout(r, wait + 5_000));
  await reclaimWhenLate(id);
}
const revoked = await owner.revokeAgent(
  KeyPair.fromString(keyOf(`marathon.${SHOP}`) as never)
    .getPublicKey()
    .toString(),
);
console.log(`marathon key revoked: ${revoked.ok ? revoked.txHash : revoked.error}`);

async function summarize(results: Result[]) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: SHOP },
    }),
  });
  const code = ((await res.json()) as { result?: { code_hash: string } }).result?.code_hash ?? null;
  const held = (r: Result) =>
    r.refused && (r.how === "event" || (EXPECT[r.kind]?.test(r.why) ?? false));
  const kinds = [...new Set(results.map((r) => r.kind))];
  const summary = {
    shop: SHOP,
    board: BOUNTIES,
    code,
    from: results[0]?.at ?? null,
    to: results.at(-1)?.at ?? null,
    attempts: results.length,
    refused: results.filter(held).length,
    // Not refused but not paid either: the contract sent it to a person to decide.
    waiting: results.filter((r) => !r.refused && /"Needs(Council|Cosign)"/.test(r.why)).length,
    events: results.filter((r) => held(r) && r.how === "event").length,
    inconclusive: results.filter((r) => r.refused && !held(r)).length,
    kinds: kinds.map((kind) => {
      const of = results.filter((r) => r.kind === kind);
      return {
        kind,
        attempts: of.length,
        refused: of.filter(held).length,
        waiting: of.filter((r) => !r.refused && /"Needs(Council|Cosign)"/.test(r.why)).length,
        how: of.find(held)?.how ?? of[0]?.how,
        why: of.find(held)?.why ?? null,
        samples: of.flatMap((r) => (held(r) && r.tx ? [r.tx] : [])).slice(0, 3),
      };
    }),
  };
  mkdirSync(join(ROOT, "apps/web/public"), { recursive: true });
  writeFileSync(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `${summary.refused}/${summary.attempts} refused (${summary.events} as logged decisions, ${summary.inconclusive} inconclusive)`,
  );
}

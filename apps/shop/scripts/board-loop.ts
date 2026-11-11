// The community loop on testnet: a newcomer claims a bounty and reports a lookalike, the bounty
// agent reviews it and asks for the payout, and with no points yet a council member has to
// approve it. With the point it earned, the newcomer's next report pays out with no approval.
// Then the shop's check finds the reported address on the community scam list.
// Each run makes a new contributor account and new lookalikes, and posts bounties if too few are
// open, so it can be rerun.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Decision, describeDecision, Pursestrings } from "@pursestrings/sdk";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { parseWork, Reviews, reviewSubmitted } from "../src/board.ts";
import { gather, verdict } from "../src/check.ts";
import { scamListFrom } from "../src/deliver.ts";
import { type Chat, fromYocto } from "../src/seller.ts";

const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const BOARD = process.env.BOARD_ACCOUNT ?? "board.factory.ps-spike-1028.testnet";
const COUNCIL = "ps-funder-1101.testnet";
/** A council member can't approve a payout on a bounty they posted, so another one approves. */
const APPROVER = "ps-spike-1028.testnet";
const REWARD = 50_000_000_000_000_000_000_000n;
const KNOWN = [
  "ps-spike-1028.testnet",
  "ps-community-1107.testnet",
  "shop.factory.ps-spike-1028.testnet",
  "bounties.factory.ps-spike-1028.testnet",
  BOARD,
  "wrap.testnet",
];
const key = (id: string) =>
  JSON.parse(readFileSync(join(homedir(), ".near-credentials/testnet", `${id}.json`), "utf8"))
    .private_key as string;

/** One character of the name swapped: close enough to pass for `name`, and new each run. */
function imitate(name: string, taken: ReadonlySet<string>): string {
  const dot = name.indexOf(".");
  for (;;) {
    const i = Math.floor(Math.random() * dot);
    const c = "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)] as string;
    if (!/[a-z]/.test(name[i] as string) || c === name[i]) continue;
    const out = name.slice(0, i) + c + name.slice(i + 1);
    if (!taken.has(out)) return out;
  }
}

const started = Date.now();
const step = (s: string) =>
  console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s  ${s}`);
const near = (y: string | bigint) => `${fromYocto(y)} NEAR`;

const board = new Pursestrings(RPC, BOARD);
const agent = board.agent(key(BOARD));
const council = board.caller(COUNCIL, key(COUNCIL));
const approver = board.caller(APPROVER, key(APPROVER));

const fresh = KeyPair.fromRandom("ed25519");
const CONTRIBUTOR = `c${Date.now().toString(36)}.${COUNCIL}`;
await new Account(
  COUNCIL,
  new JsonRpcProvider({ url: RPC }),
  key(COUNCIL) as KeyPairString,
).createSubAccount({
  accountOrPrefix: CONTRIBUTOR,
  publicKey: fresh.getPublicKey().toString(),
  nearToTransfer: 100_000_000_000_000_000_000_000n,
});
const contributor = board.caller(CONTRIBUTOR, fresh.toString());
const noModel: Chat = {
  chat: async () => {
    throw new Error("no model");
  },
};
const sources = {
  nearRpc: RPC,
  nearTx: "https://tx.test.fastnear.com",
  blockscout: "https://base-sepolia.blockscout.com",
  known: KNOWN,
};
const reviews = new Reviews(join(import.meta.dirname, `../data/loop-reviews-${BOARD}.jsonl`));

const taken = new Set(scamListFrom(await board.recentBounties(100)).map((e) => e.address));
// REPORTS="addr reason|addr reason" files those reports instead of fresh lookalikes.
const REPORTS = process.env.REPORTS
  ? process.env.REPORTS.split("|").map((r) => `scam:${r.trim()}`)
  : [
      `scam:${imitate("ps-community-1107.testnet", taken)} asks members to pay their DAO dues to it instead of the DAO`,
      `scam:${imitate("shop.factory.ps-spike-1028.testnet", taken)} sells fake checks under the shop's name`,
    ];
const reported = (parseWork(REPORTS[0] as string) as { address: string }).address;

let open = (await board.recentBounties(100)).filter(([, b]) => b.status === "Open");
for (let i = open.length; i < REPORTS.length; i++) {
  const posted = await council.postBounty(
    "Report an account imitating a testnet name people pay: scam:<account> <evidence>",
    "Near",
    REWARD,
  );
  if (!posted.ok) throw new Error(`post failed: ${posted.error}`);
  step(`council member ${COUNCIL} posts bounty ${posted.value} (${near(REWARD)})`);
}
open = (await board.recentBounties(100)).filter(([, b]) => b.status === "Open");
step(`new contributor ${CONTRIBUTOR}: ${(await board.record(CONTRIBUTOR)).points} points`);

for (const [i, work] of REPORTS.entries()) {
  const [id, b] = open[open.length - 1 - i] as (typeof open)[number];
  const claim = await contributor.claimBounty(id);
  if (!claim.ok) throw new Error(`claim failed: ${claim.error}`);
  const submit = await contributor.submitBounty(id, work);
  if (!submit.ok) throw new Error(`submit failed: ${submit.error}`);
  step(`${CONTRIBUTOR} claims bounty ${id} (${near(b.reward)}) and reports ${work.split(" ")[0]}`);

  const [review] = await reviewSubmitted({
    board,
    agent,
    model: noModel,
    sources,
    reviews,
    log: () => {},
  });
  if (!review?.decision) throw new Error(`review: ${JSON.stringify(review)}`);
  const d: Decision = review.decision;
  step(
    `agent: ${review.reasons.join(" ")} → contract: ${describeDecision(d, near)} (${review.tx})`,
  );

  if ("NeedsCouncil" in d) {
    const ok = await approver.councilApprove(d.NeedsCouncil.req_id);
    if (!ok.ok) throw new Error(`council approval failed: ${ok.error}`);
    step(`council member ${APPROVER} approves (${ok.txHash})`);
  }
  // One open claim per account: the payout must land before the next claim.
  for (let t = 0; t < 20 && (await board.bounty(id))?.status !== "Paid"; t++) {
    await new Promise((r) => setTimeout(r, 1_500));
  }
  const rec = await board.record(CONTRIBUTOR);
  step(
    `bounty ${id}: ${(await board.bounty(id))?.status}; ${CONTRIBUTOR} has ${rec.points} point(s)`,
  );
}

const list = scamListFrom(await board.recentBounties(100));
const facts = await gather(reported, {
  ...sources,
  scamList: async () => list,
});
const v = verdict(facts, Date.now());
step(`shop check of ${reported} → "${v.level}": ${v.reasons[0]}`);

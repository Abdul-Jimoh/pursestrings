// The community loop on testnet: a newcomer claims a bounty and reports a lookalike, the bounty
// agent reviews it and asks for the payout, and with no points yet a council member has to
// approve it. With the point it earned, the newcomer's next report pays out with no approval.
// Then the shop's check finds the reported address on the community scam list.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Decision, describeDecision, Pursestrings } from "@pursestrings/sdk";
import { Reviews, reviewSubmitted } from "../src/board.ts";
import { gather, verdict } from "../src/check.ts";
import { scamListFrom } from "../src/deliver.ts";
import { type Chat, fromYocto } from "../src/seller.ts";

const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const BOARD = process.env.BOARD_ACCOUNT ?? "bounties.factory.ps-spike-1028.testnet";
const CONTRIBUTOR = process.env.CONTRIBUTOR ?? "ps-fund-1107b.testnet";
const COUNCIL = "ps-funder-1101.testnet";
const KNOWN = [
  "ps-spike-1028.testnet",
  "ps-community-1107.testnet",
  "shop.factory.ps-spike-1028.testnet",
  "bounties.factory.ps-spike-1028.testnet",
  "wrap.testnet",
];
const REPORTS = [
  "scam:ps-cornmunity-1107.testnet asks members to pay their DAO dues to it instead of the DAO",
  "scam:shop.factory.ps-spike-lo28.testnet sells fake checks under the shop's name",
];
const key = (id: string) =>
  JSON.parse(readFileSync(join(homedir(), ".near-credentials/testnet", `${id}.json`), "utf8"))
    .private_key as string;

const started = Date.now();
const step = (s: string) =>
  console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s  ${s}`);
const near = (y: string | bigint) => `${fromYocto(y)} NEAR`;

const board = new Pursestrings(RPC, BOARD);
const agent = board.agent(key(BOARD));
const contributor = board.caller(CONTRIBUTOR, key(CONTRIBUTOR));
const council = board.caller(COUNCIL, key(COUNCIL));
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
const reviews = new Reviews(join(import.meta.dirname, "../data/loop-reviews.jsonl"));

const open = (await board.recentBounties(100)).filter(([, b]) => b.status === "Open");
if (open.length < REPORTS.length) throw new Error(`need ${REPORTS.length} open bounties`);
step(`${(await board.record(CONTRIBUTOR)).points} points for ${CONTRIBUTOR}`);

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
    const ok = await council.councilApprove(d.NeedsCouncil.req_id);
    if (!ok.ok) throw new Error(`council approval failed: ${ok.error}`);
    step(`council member ${COUNCIL} approves (${ok.txHash})`);
  }
  await new Promise((r) => setTimeout(r, 3_000));
  const rec = await board.record(CONTRIBUTOR);
  step(
    `bounty ${id}: ${(await board.bounty(id))?.status}; ${CONTRIBUTOR} has ${rec.points} point(s)`,
  );
}

const list = scamListFrom(await board.recentBounties(100));
const facts = await gather("ps-cornmunity-1107.testnet", {
  ...sources,
  scamList: async () => list,
});
const v = verdict(facts, Date.now());
step(`shop check of ps-cornmunity-1107.testnet → "${v.level}": ${v.reasons[0]}`);

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Agent, Bounty, Decision, Pursestrings } from "@pursestrings/sdk";
import { chainOf, type Facts, gather, type ScamEntry, type Sources } from "./check.ts";
import { scamListFrom } from "./deliver.ts";
import type { Route } from "./routes.ts";
import type { Chat } from "./seller.ts";

/**
 * The bounty agent reviews submissions to the community scam list. Fixed rules decide whether a
 * submission qualifies; the model may only veto one. A qualifying submission becomes a payout
 * request, and the contract's trust tiers decide whether it pays now, waits for one council
 * member, or waits for a DAO vote.
 */
export interface Review {
  bountyId: number;
  work: string;
  claimant: string;
  at: number;
  accepted: boolean;
  reasons: string[];
  note: string | null;
  decision?: Decision;
  reqId?: number;
  tx?: string;
}

const WORK = /^scam:(\S+)\s+([\s\S]+)$/;
/** A link anyone can open to see the address in a transaction; any other site proves nothing. */
const EXPLORER_LINK =
  /(?:^|\s)https:\/\/((testnet\.)?nearblocks\.io|explorer\.(testnet\.)?near\.org|(sepolia\.)?(basescan\.org|etherscan\.io)|[a-z0-9-]+\.blockscout\.com)\/(txns?|address|accounts?)\/[A-Za-z0-9._-]+/i;

export function parseWork(work: string): { address: string; evidence: string } | null {
  const m = WORK.exec(work.trim());
  return m ? { address: m[1] as string, evidence: (m[2] as string).trim() } : null;
}

/** Fixed rules for a scam-list submission; `reasons` explains a refusal or what qualified it. */
export function rules(
  work: string,
  facts: Facts | null,
  listed: readonly ScamEntry[],
  known: readonly string[],
): { accepted: boolean; reasons: string[] } {
  const parsed = parseWork(work);
  if (!parsed)
    return { accepted: false, reasons: ['The work must read "scam:<address> <evidence>".'] };
  const { address, evidence } = parsed;
  const a = address.toLowerCase();
  if (!chainOf(address))
    return { accepted: false, reasons: ["That isn't a NEAR account or a 0x address."] };
  if (known.some((k) => k.toLowerCase() === a))
    return { accepted: false, reasons: ["That's one of the names the list protects, not a scam."] };
  if (listed.some((e) => e.address.toLowerCase() === a))
    return { accepted: false, reasons: ["It's already on the scam list."] };
  if (evidence.length < 12)
    return { accepted: false, reasons: ["The evidence is too short to check."] };
  const signals = [
    facts?.lookalikeOf ? `It imitates ${facts.lookalikeOf}.` : null,
    facts?.flaggedByExplorer ? "The block explorer flags it." : null,
    EXPLORER_LINK.test(evidence) ? "The evidence links to a block explorer." : null,
  ].filter((s): s is string => s !== null);
  if (!signals.length)
    return {
      accepted: false,
      reasons: [
        "Nothing backs the claim: it isn't a lookalike, the explorer doesn't flag it, and the evidence has no block explorer link.",
      ],
    };
  return { accepted: true, reasons: signals };
}

const REVIEW_PROMPT = `You review submissions to a community scam list. You get the submission, the facts we gathered about the address, and fixed rules' reasons for accepting it. You may only veto: answer {"veto": true, "note": "..."} if the evidence is clearly spam, unrelated, or contradicts the facts; otherwise {"veto": false, "note": "..."}. The note is one plain sentence for the public board. Answer with the JSON only.`;

/** The model can add a refusal, never an approval; if it fails, the rules stand. */
export async function veto(
  model: Chat,
  input: { work: string; facts: Facts | null; reasons: string[] },
): Promise<{ veto: boolean; note: string | null }> {
  try {
    const turn = await model.chat(
      [
        { role: "system", content: REVIEW_PROMPT },
        { role: "user", content: JSON.stringify(input) },
      ],
      [],
    );
    const m = /\{[\s\S]*\}/.exec(turn.text ?? "");
    const out = m ? (JSON.parse(m[0]) as { veto?: unknown; note?: unknown }) : {};
    return {
      veto: out.veto === true,
      note: typeof out.note === "string" ? out.note.slice(0, 280) : null,
    };
  } catch {
    return { veto: false, note: null };
  }
}

export class Reviews {
  private readonly byKey = new Map<string, Review>();
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
        const r = JSON.parse(line) as Review;
        this.byKey.set(Reviews.key(r.bountyId, r.work), r);
      }
    }
  }
  static key(id: number, work: string) {
    return `${id}\n${work}`;
  }
  get(id: number, work: string) {
    return this.byKey.get(Reviews.key(id, work));
  }
  /** The latest review of each bounty. */
  latest(): Review[] {
    const out = new Map<number, Review>();
    for (const r of this.byKey.values()) {
      const prev = out.get(r.bountyId);
      if (!prev || r.at >= prev.at) out.set(r.bountyId, r);
    }
    return [...out.values()];
  }
  save(r: Review) {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(r)}\n`);
    this.byKey.set(Reviews.key(r.bountyId, r.work), r);
  }
}

export interface Reviewer {
  board: Pursestrings;
  agent: Agent;
  model: Chat;
  sources: Omit<Sources, "scamList">;
  reviews: Reviews;
  now?: () => number;
  log?: (line: string) => void;
}

/** Reviews each submitted bounty once per submission and requests the payouts that qualify. */
export async function reviewSubmitted(d: Reviewer): Promise<Review[]> {
  const now = d.now ?? Date.now;
  const log = d.log ?? console.log;
  const bounties: [number, Bounty][] = await d.board.recentBounties(100);
  const listed = scamListFrom(bounties);
  const done: Review[] = [];
  for (const [id, b] of bounties) {
    if (b.status !== "Submitted" || !b.work || !b.claimant) continue;
    if (d.reviews.get(id, b.work)) continue;
    const parsed = parseWork(b.work);
    const facts =
      parsed && chainOf(parsed.address)
        ? await gather(parsed.address, { ...d.sources, scamList: async () => listed }).catch(
            () => null,
          )
        : null;
    const verdict = rules(b.work, facts, listed, d.sources.known);
    let review: Review = {
      bountyId: id,
      work: b.work,
      claimant: b.claimant,
      at: now(),
      ...verdict,
      note: null,
    };
    if (verdict.accepted) {
      const v = await veto(d.model, { work: b.work, facts, reasons: verdict.reasons });
      review = { ...review, note: v.note };
      if (v.veto) review = { ...review, accepted: false, reasons: ["The reviewer vetoed it."] };
    }
    if (review.accepted) {
      const out = await d.agent.requestSpend({
        asset: b.asset,
        amount: b.reward,
        dest: { Near: { account: b.claimant } },
        purpose: `bounty ${id}: ${b.title}`.slice(0, 256),
        idempotency_key: `bounty-${id}-${review.at}`,
        bounty: id,
      });
      if (!out.value) {
        log(`bounty ${id}: request failed: ${out.error}`);
        continue;
      }
      const d0 = out.value;
      const reqId = "Denied" in d0 ? undefined : Object.values(d0)[0]?.req_id;
      review = {
        ...review,
        decision: d0,
        tx: out.txHash,
        ...(reqId === undefined ? {} : { reqId }),
      };
    }
    d.reviews.save(review);
    log(
      `bounty ${id}: ${review.accepted ? "accepted" : "not accepted"} (${review.reasons.join(" ")})`,
    );
    done.push(review);
  }
  return done;
}

export function boardRoutes(d: Reviewer): { route: Route; tick: () => Promise<Review[]> } {
  let running: Promise<Review[]> | undefined;
  // A tick that's still running is reused, so one submission never gets two payout requests.
  const tick = () => {
    running ??= reviewSubmitted(d).finally(() => {
      running = undefined;
    });
    return running;
  };
  const route: Route = async ({ method, url }) => {
    if (method === "GET" && url.pathname === "/api/board/reviews") {
      return { status: 200, data: { reviews: d.reviews.latest() } };
    }
    return undefined;
  };
  return { route, tick };
}

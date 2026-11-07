import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Agent, Bounty, Pursestrings } from "@pursestrings/sdk";
import {
  type Facts,
  gather,
  type ScamEntry,
  type Sources,
  type Verdict,
  verdict,
} from "./check.ts";
import type { Chat } from "./seller.ts";

export interface Report {
  orderId: number;
  target: string;
  facts: Facts;
  verdict: Verdict;
  text: string;
  at: number;
  /** The receipt the agent recorded on-chain: sha256 of this report without it. */
  receipt?: string;
  deliverTx?: string;
}

const WRITER_PROMPT = `You write the report for "Check before you pay". You get the facts about an address and a verdict that was already decided by fixed rules. Explain the verdict in three to five short plain sentences a non-expert understands, using only the facts given. Never change or soften the verdict. No Markdown.`;

/** The model explains; if it fails, the reasons themselves are the report. */
export async function writeReport(model: Chat, facts: Facts, v: Verdict): Promise<string> {
  try {
    const turn = await model.chat(
      [
        { role: "system", content: WRITER_PROMPT },
        { role: "user", content: JSON.stringify({ facts, verdict: v }) },
      ],
      [],
    );
    if (turn.text?.trim()) return turn.text.trim();
  } catch {}
  return `Verdict: ${v.level}. ${v.reasons.join(" ")}`;
}

/** Paid bounties whose work reads `scam:<address> <evidence>` make up the community scam list. */
export function scamListFrom(bounties: [number, Bounty][]): ScamEntry[] {
  return bounties.flatMap(([id, b]) => {
    const m = b.status === "Paid" ? /^scam:(\S+)\s+(.+)$/.exec(b.work ?? "") : null;
    return m ? [{ address: m[1] as string, evidence: m[2] as string, bounty: id }] : [];
  });
}

export class Reports {
  private readonly byOrder = new Map<number, Report>();
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
        const r = JSON.parse(line) as Report;
        this.byOrder.set(r.orderId, r);
      }
    }
  }
  get(orderId: number) {
    return this.byOrder.get(orderId);
  }
  all() {
    return [...this.byOrder.values()];
  }
  save(r: Report) {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(r)}\n`);
    this.byOrder.set(r.orderId, r);
  }
}

export interface Deliverer {
  shop: Pursestrings;
  agent: Agent;
  model: Chat;
  sources: Omit<Sources, "scamList">;
  board?: Pursestrings;
  reports: Reports;
  now?: () => number;
  log?: (line: string) => void;
}

/** Checks every paid, undelivered order and delivers it. Returns the orders it delivered. */
export async function deliverPaid(d: Deliverer): Promise<number[]> {
  const now = d.now ?? Date.now;
  const log = d.log ?? console.log;
  const done: number[] = [];
  for (const [orderId, order] of await d.shop.recentOrders(50)) {
    if (order.status !== "Paid" || !order.item.startsWith("check:")) continue;
    const target = order.item.slice("check:".length);
    let report = d.reports.get(orderId);
    if (!report) {
      const facts = await gather(target, {
        ...d.sources,
        scamList: async () => (d.board ? scamListFrom(await d.board.recentBounties(100)) : []),
      });
      const v = verdict(facts, now());
      const text = await writeReport(d.model, facts, v);
      report = { orderId, target, facts, verdict: v, text, at: now() };
    }
    const receipt = `sha256:${createHash("sha256")
      .update(JSON.stringify({ ...report, receipt: undefined, deliverTx: undefined }))
      .digest("hex")}`;
    const out = await d.agent.deliver(orderId, receipt);
    if (!out.ok) {
      log(`order ${orderId}: deliver failed: ${out.error}`);
      continue;
    }
    d.reports.save({ ...report, receipt, deliverTx: out.txHash });
    log(`order ${orderId}: ${report.verdict.level} for ${target}, delivered in ${out.txHash}`);
    done.push(orderId);
  }
  return done;
}

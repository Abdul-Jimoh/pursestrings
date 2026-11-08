import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Bounty, Pursestrings, SpendRequest } from "@pursestrings/sdk";
import { describe, expect, it } from "vitest";
import { Reviews, reviewSubmitted, rules } from "./board.ts";
import type { Facts } from "./check.ts";
import type { Chat } from "./seller.ts";

const KNOWN = ["circle.testnet"];

const facts = (over: Partial<Facts> = {}): Facts => ({
  target: "x.testnet",
  chain: "near",
  exists: true,
  isContract: false,
  txCount: 1,
  firstSeen: null,
  fullAccessKeys: 1,
  lookalikeOf: null,
  scam: null,
  flaggedByExplorer: false,
  ...over,
});

const bounty = (id: number, work: string | null, status: Bounty["status"] = "Submitted") =>
  [
    id,
    {
      title: "add a scam address",
      asset: "Near",
      reward: "50",
      poster: "council.testnet",
      posted_at: 0,
      status,
      claimant: "alice.testnet",
      work,
      req_id: null,
    },
  ] as [number, Bounty];

const answer = (text: string): Chat => ({
  async chat() {
    return {
      text,
      toolCalls: [],
      usage: { input: 0, output: 0 },
      message: { role: "assistant", content: text },
    };
  },
});

describe("bounty review rules", () => {
  it("accepts a lookalike or a linked report and says why", () => {
    expect(
      rules(
        "scam:circ1e.testnet posing as Circle in DMs",
        facts({ lookalikeOf: "circle.testnet" }),
        [],
        KNOWN,
      ),
    ).toEqual({ accepted: true, reasons: ["It imitates circle.testnet."] });
    expect(
      rules(
        "scam:drain.testnet took a deposit https://testnet.nearblocks.io/txns/abc",
        facts(),
        [],
        KNOWN,
      ).accepted,
    ).toBe(true);
  });

  it("refuses bad format, protected names, duplicates, thin evidence and unbacked claims", () => {
    const no = (
      work: string,
      listed = [] as { address: string; evidence: string; bounty: number }[],
    ) => rules(work, facts(), listed, KNOWN);
    expect(no("circ1e.testnet is a scam").accepted).toBe(false);
    expect(no("scam:circle.testnet it's fake, trust me").reasons[0]).toMatch(/protects/);
    expect(
      no("scam:circ1e.testnet https://example.com/proof", [
        { address: "circ1e.testnet", evidence: "x", bounty: 1 },
      ]).reasons[0],
    ).toMatch(/already/);
    expect(no("scam:circ1e.testnet bad").reasons[0]).toMatch(/too short/);
    expect(no("scam:someone.testnet I just don't like them").reasons[0]).toMatch(/Nothing backs/);
  });
});

describe("bounty agent", () => {
  const sources = {
    nearRpc: "https://rpc",
    nearTx: "https://tx",
    blockscout: "https://bs",
    known: KNOWN,
    fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch,
  };

  function setup(list: [number, Bounty][]) {
    const requests: SpendRequest[] = [];
    const board = { recentBounties: async () => list } as unknown as Pursestrings;
    const agent = {
      async requestSpend(r: SpendRequest) {
        requests.push(r);
        return {
          ok: true,
          value: { NeedsCouncil: { req_id: 4, expires_at: 9 } },
          logs: [],
          txHash: "RTX",
        };
      },
    } as unknown as Agent;
    const reviews = new Reviews(join(mkdtempSync(join(tmpdir(), "board-")), "reviews.jsonl"));
    return { board, agent, reviews, requests };
  }

  it("asks the contract to pay the claimant the reward, once per submission", async () => {
    const s = setup([
      bounty(2, "scam:clrcle.testnet posing as Circle in DMs"),
      bounty(1, "scam:circ1e.testnet https://example.com", "Paid"),
      bounty(0, null, "Open"),
    ]);
    const d = { ...s, model: answer('{"veto": false, "note": "A clear lookalike."}'), sources };
    const [review] = await reviewSubmitted(d);
    expect(s.requests).toEqual([
      expect.objectContaining({
        asset: "Near",
        amount: "50",
        dest: { Near: { account: "alice.testnet" } },
        bounty: 2,
      }),
    ]);
    expect(review).toMatchObject({
      accepted: true,
      reqId: 4,
      note: "A clear lookalike.",
      tx: "RTX",
    });
    expect(await reviewSubmitted(d)).toEqual([]);
    expect(s.requests).toHaveLength(1);
  });

  it("lets the model veto a submission but never approve one the rules refuse", async () => {
    const vetoed = setup([bounty(3, "scam:clrcle.testnet buy my course at a discount")]);
    const [v] = await reviewSubmitted({
      ...vetoed,
      model: answer('{"veto": true, "note": "Spam."}'),
      sources,
    });
    expect(v).toMatchObject({ accepted: false, note: "Spam." });
    expect(vetoed.requests).toEqual([]);

    const refused = setup([bounty(4, "scam:someone.testnet I just don't like them")]);
    let asked = false;
    const eager: Chat = {
      async chat() {
        asked = true;
        throw new Error("unreachable");
      },
    };
    const [r] = await reviewSubmitted({ ...refused, model: eager, sources });
    expect(r?.accepted).toBe(false);
    expect(asked).toBe(false);
    expect(refused.requests).toEqual([]);
  });
});

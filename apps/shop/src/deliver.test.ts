import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Bounty, Order, Pursestrings } from "@pursestrings/sdk";
import { describe, expect, it } from "vitest";
import { deliverPaid, Reports, scamListFrom } from "./deliver.ts";
import type { Chat } from "./seller.ts";

const bounty = (status: Bounty["status"], work: string): Bounty => ({
  title: "add a scam address",
  asset: "Near",
  reward: "1",
  poster: "council.testnet",
  posted_at: 0,
  status,
  claimant: "alice.testnet",
  work,
  req_id: null,
});

const order = (status: Order["status"], item: string): Order => ({
  buyer: "bob.testnet",
  asset: "Near",
  price: "100",
  item,
  status,
  quoted_at: 0,
  expires_at: 0,
  payer: "bob.testnet",
  paid_at: 0,
  deliver_by: 0,
  held: "100",
  refunded: "0",
  receipt: null,
});

describe("delivery", () => {
  it("builds the scam list from paid bounties only", () => {
    expect(
      scamListFrom([
        [1, bounty("Paid", "scam:circ1e.testnet https://example.com/proof")],
        [2, bounty("Submitted", "scam:x.testnet https://example.com")],
        [3, bounty("Paid", "a docs fix")],
      ]),
    ).toEqual([{ address: "circ1e.testnet", evidence: "https://example.com/proof", bounty: 1 }]);
  });

  it("checks paid orders, delivers them with a receipt and keeps the report", async () => {
    const delivered: [number, string][] = [];
    const shop = {
      async view() {
        return 8;
      },
      async recentOrders(_limit: number, before: number) {
        return before === 8
          ? [
              [7, order("Paid", "check:circ1e.testnet")],
              [6, order("Delivered", "check:alice.testnet")],
            ]
          : [];
      },
    } as unknown as Pursestrings;
    let up = false;
    const agent = {
      async deliver(id: number, receipt: string) {
        delivered.push([id, receipt]);
        return up
          ? { ok: true, value: undefined, logs: [], txHash: "DTX" }
          : { ok: false, error: "rpc down", logs: [] };
      },
    } as unknown as Agent;
    const broken: Chat = {
      async chat() {
        throw new Error("model down");
      },
    };
    const file = join(mkdtempSync(join(tmpdir(), "shop-")), "reports.jsonl");
    const reports = new Reports(file);
    const run = () =>
      deliverPaid({
        shop,
        agent,
        model: broken,
        reports,
        sources: {
          nearRpc: "https://rpc",
          nearTx: "https://tx",
          blockscout: "https://bs",
          known: ["circle.testnet"],
          fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch,
        },
        log: () => {},
      });
    expect(await run()).toEqual([]);
    expect(new Reports(file).get(7)?.text, "kept before the deliver call").toContain(
      "circle.testnet",
    );
    up = true;
    expect(await run()).toEqual([7]);
    expect(delivered[1]?.[1], "the retry delivers the same report").toBe(delivered[0]?.[1]);
    expect(delivered[1]?.[1]).toMatch(/^sha256:[0-9a-f]{64}$/);
    const r = reports.get(7);
    expect(r?.verdict.level).toBe("do not pay");
    expect(r?.text).toContain("circle.testnet");
    expect(r?.deliverTx).toBe("DTX");
  });
});

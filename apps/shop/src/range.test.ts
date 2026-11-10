import type { Agent, Order } from "@pursestrings/sdk";
import { describe, expect, it } from "vitest";
import { paidOn, scoreboard } from "./range.ts";
import { cached } from "./routes.ts";
import { type Chat, sellerTurn } from "./seller.ts";

const NEAR = 10n ** 24n;
const milli = (n: number) => (BigInt(n) * NEAR) / 1000n;
const split = [{ bps: 7_000 }, { bps: 2_000 }];

const order = (over: Partial<Order>): Order => ({
  buyer: "bob.testnet",
  asset: "Near",
  price: milli(80).toString(),
  item: "check:x.testnet",
  status: "Delivered",
  quoted_at: 0,
  expires_at: 0,
  payer: "bob.testnet",
  paid_at: 1,
  deliver_by: 2,
  held: "0",
  refunded: "0",
  receipt: "sha256:x",
  ...over,
});

describe("shop challenge scoreboard", () => {
  it("puts the bound at what the split pays on the floor", () => {
    expect(paidOn(milli(50), split)).toBe(milli(45));
  });

  it("ranks delivered checks by what they cost, one per payer, and flags anything under the bound", () => {
    const s = scoreboard(
      [
        [0, order({ refunded: milli(8).toString() })],
        [1, order({})],
        [
          2,
          order({
            payer: "eve.testnet",
            price: milli(50).toString(),
            refunded: milli(6).toString(),
          }),
        ],
        [3, order({ payer: "amy.testnet", status: "Refunded", refunded: milli(80).toString() })],
      ],
      milli(50),
      split,
    );
    expect(s.bound).toBe(milli(45).toString());
    expect(s.best.map((b) => [b.orderId, b.net])).toEqual([
      [2, milli(44).toString()],
      [0, milli(72).toString()],
    ]);
    expect(s.breaches.map((b) => b.orderId)).toEqual([2]);
  });
});

describe("front desk refunds", () => {
  function refunding(args: Record<string, unknown>): Chat {
    let i = 0;
    return {
      async chat() {
        const first = i++ === 0;
        return {
          text: first ? null : "done",
          toolCalls: first ? [{ id: "r", name: "refund", arguments: JSON.stringify(args) }] : [],
          usage: { input: 1, output: 1 },
          message: { role: "assistant", content: null },
        };
      },
    };
  }
  const agent = (payer: string) => {
    const refunds: unknown[][] = [];
    const a = {
      purse: { order: async () => order({ payer }) },
      async refund(...args: unknown[]) {
        refunds.push(args);
        return { ok: true, value: "Refunded", logs: [], txHash: "RTX" };
      },
    } as unknown as Agent;
    return { a, refunds };
  };
  const ask = [{ role: "user" as const, content: "refund me" }];

  it("asks the contract for the buyer's own order", async () => {
    const { a, refunds } = agent("bob.testnet");
    const turn = await sellerTurn(
      refunding({ order_id: 4, amount_near: "0.08", reason: "unhappy" }),
      a,
      "bob.testnet",
      "x.testnet",
      ask,
      true,
    );
    expect(refunds).toEqual([[4, milli(80), "unhappy"]]);
    expect(turn.refunds).toEqual([
      { orderId: 4, amount: milli(80).toString(), decision: "Refunded", tx: "RTX" },
    ]);
  });

  it("won't touch someone else's order, and the shop's own chat has no refund tool", async () => {
    const other = agent("eve.testnet");
    const turn = await sellerTurn(
      refunding({ order_id: 4, amount_near: "0.08", reason: "x" }),
      other.a,
      "bob.testnet",
      "x.testnet",
      ask,
      true,
    );
    expect(other.refunds).toEqual([]);
    expect(turn.refunds).toBeUndefined();

    const mine = agent("bob.testnet");
    await sellerTurn(
      refunding({ order_id: 4, amount_near: "0.08", reason: "x" }),
      mine.a,
      "bob.testnet",
      "x.testnet",
      ask,
    );
    expect(mine.refunds).toEqual([]);
  });
});

describe("cached chain reads", () => {
  it("serves one read per window and drops a failed one", async () => {
    let t = 0;
    let reads = 0;
    let fail = false;
    const get = cached(
      5_000,
      async () => {
        reads++;
        if (fail) throw new Error("rpc down");
        return reads;
      },
      () => t,
    );
    expect(await Promise.all([get(), get()])).toEqual([1, 1]);
    t = 4_999;
    expect(await get()).toBe(1);
    t = 5_000;
    fail = true;
    await expect(get()).rejects.toThrow("rpc down");
    fail = false;
    expect(await get()).toBe(3);
  });
});

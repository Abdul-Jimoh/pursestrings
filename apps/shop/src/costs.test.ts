import type { Agent, Decision, SpendRequest } from "@pursestrings/sdk";
import { describe, expect, it } from "vitest";
import { Costs, metered } from "./costs.ts";
import type { Chat } from "./seller.ts";

const NEAR = 10n ** 24n;

function agent(decision: Decision) {
  const asks: SpendRequest[] = [];
  const a = {
    async requestSpend(r: SpendRequest) {
      asks.push(r);
      return { ok: true, value: decision, logs: [], txHash: "TX" };
    },
  } as unknown as Agent;
  return { a, asks };
}

describe("the shop's own costs", () => {
  it("meters every model call", async () => {
    const seen: number[] = [];
    const model: Chat = {
      chat: async () => ({
        text: "hi",
        toolCalls: [],
        usage: { input: 7, output: 3 },
        message: { role: "assistant", content: "hi" },
      }),
    };
    await metered(model, (u) => seen.push(u.input + u.output)).chat([], []);
    expect(seen).toEqual([10]);
  });

  it("pays the debt through request_spend once it's worth it, and keeps it if refused", async () => {
    const ok = agent({ Approved: { req_id: 3 } });
    const c = new Costs({
      agent: ok.a,
      payee: "ops.testnet",
      nearPerUsd: 0.25,
      minYocto: NEAR / 1000n,
      maxYocto: NEAR,
      now: () => 9,
    });
    c.add(0.002);
    expect(await c.settle()).toBeUndefined();
    c.add(0.002);
    const paid = await c.settle();
    expect(paid?.amount).toBe(NEAR / 1000n);
    expect(ok.asks[0]).toMatchObject({
      asset: "Near",
      amount: (NEAR / 1000n).toString(),
      dest: { Near: { account: "ops.testnet" } },
      idempotency_key: "costs-9",
    });
    expect(c.owed()).toBe(0n);

    const no = agent({ Denied: { reason: "RecipientNotAllowed" } });
    let t = 0;
    const d = new Costs({
      agent: no.a,
      payee: "ops.testnet",
      nearPerUsd: 1,
      minYocto: 1n,
      maxYocto: NEAR,
      now: () => t,
    });
    d.add(0.01);
    await d.settle();
    expect(d.owed()).toBe(NEAR / 100n);
    t = 60_000;
    expect(await d.settle()).toBeUndefined();
    expect(no.asks).toHaveLength(1);
  });

  it("caps each payment, and retries an unknown outcome under the same key", async () => {
    const asks: SpendRequest[] = [];
    const replies: (Decision | undefined)[] = [
      undefined,
      { Denied: { reason: { DuplicateIdempotencyKey: { req_id: 4 } } } },
    ];
    const a = {
      async requestSpend(r: SpendRequest) {
        asks.push(r);
        const value = replies.shift();
        return { ok: value !== undefined, value, logs: [], txHash: "TX" };
      },
    } as unknown as Agent;
    let t = 1;
    const c = new Costs({
      agent: a,
      payee: "ops.testnet",
      nearPerUsd: 1,
      minYocto: 1n,
      maxYocto: NEAR / 100n,
      backoffMs: 10,
      now: () => t,
    });
    c.add(0.03);
    await c.settle();
    t = 20;
    await c.settle();
    expect(asks.map((r) => [r.amount, r.idempotency_key])).toEqual([
      [(NEAR / 100n).toString(), "costs-1"],
      [(NEAR / 100n).toString(), "costs-1"],
    ]);
    expect(c.owed()).toBe(NEAR / 50n);
  });
});

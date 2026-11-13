import type { Order } from "@pursestrings/sdk";
import { describe, expect, it } from "vitest";
import { shopRoutes } from "./routes.ts";
import { Trials } from "./trial.ts";

const DAY = 86_400_000;
const FLOOR = "50000000000000000000000";

describe("demo checks without a wallet", () => {
  it("caps tries per UTC day, runs one at a time and spaces them out", () => {
    let t = 0;
    const trials = new Trials(2, 20_000, () => t);
    const first = trials.start();
    expect(first.ok).toBe(true);
    expect(trials.start()).toMatchObject({ ok: false, reason: expect.stringMatching(/running/) });
    if (first.ok) first.done();
    expect(trials.start()).toMatchObject({ ok: false, reason: expect.stringMatching(/just ran/) });
    t = 20_000;
    const second = trials.start();
    if (second.ok) second.done();
    t = 60_000;
    expect(trials.start()).toMatchObject({ ok: false, reason: expect.stringMatching(/used up/) });
    expect(trials.left()).toBe(0);
    t = DAY;
    expect(trials.left()).toBe(2);
  });

  const order = (over: Partial<Order>): Order => ({
    buyer: "demo.testnet",
    asset: "Near",
    price: FLOOR,
    item: "check:x.testnet",
    status: "Delivered",
    quoted_at: 0,
    expires_at: 0,
    payer: "demo.testnet",
    paid_at: 1,
    deliver_by: 2,
    held: "0",
    refunded: "0",
    receipt: "sha256:x",
    ...over,
  });

  function setup(opts: { frozen?: boolean; denied?: boolean; payFails?: boolean } = {}) {
    const calls: string[] = [];
    let release: () => void = () => {};
    const route = shopRoutes({
      shop: {
        policy: async () => ({
          floors: [{ asset: "Near", min: FLOOR }],
          split: [],
          delivery_s: 600,
          frozen: opts.frozen ?? false,
        }),
        order: async (id: number) => order({ payer: id === 7 ? "demo.testnet" : "bob.testnet" }),
      },
      agent: {
        quote: async (buyer: string, asset: string, price: bigint, item: string) => {
          calls.push(`quote ${buyer} ${asset} ${price} ${item}`);
          return opts.denied
            ? { ok: true, value: { Denied: { reason: "Frozen" } }, txHash: "Q" }
            : { ok: true, value: { Quoted: { order_id: 7, expires_at: 9 } }, txHash: "Q" };
        },
      },
      reports: {
        get: () => ({ verdict: { level: "looks fine", reasons: [] }, text: "the report" }),
      },
      trial: {
        account: "demo.testnet",
        buyer: {
          payNear: async (id: number, yocto: bigint) => {
            calls.push(`pay ${id} ${yocto}`);
            await new Promise<void>((r) => {
              release = r;
              if (!opts.payFails) r();
            });
            return opts.payFails ? { ok: false, error: "no" } : { ok: true, txHash: "P" };
          },
        },
        trials: new Trials(20, 0),
      },
    } as unknown as Parameters<typeof shopRoutes>[0]).route;
    const call = (
      method: string,
      path: string,
      body: Record<string, unknown> = {},
      account?: string,
      visitor?: string,
    ) =>
      route({
        method,
        url: new URL(`http://x/api/shop${path}`),
        account,
        ...(visitor ? { visitor } : {}),
        body: async () => body,
      });
    return { call, calls, release: () => release() };
  }

  it("quotes the demo buyer at the floor, pays from the demo account, and shows anyone the report", async () => {
    const { call, calls } = setup();
    expect((await call("GET", "/try"))?.data).toEqual({
      account: "demo.testnet",
      left: 20,
      price: FLOOR,
    });
    const res = await call("POST", "/try", { target: " vvrap.near " });
    expect(res).toMatchObject({ status: 200, data: { orderId: 7, price: FLOOR, payTx: "P" } });
    expect(calls).toEqual([`quote demo.testnet Near ${FLOOR} check:vvrap.near`, `pay 7 ${FLOOR}`]);
    expect((await call("GET", "/try"))?.data).toMatchObject({ left: 19 });
    expect((await call("GET", "/order?id=7"))?.data).toMatchObject({
      report: { text: "the report" },
    });
    expect((await call("GET", "/order?id=8"))?.data).toMatchObject({ report: null });
  });

  it("refuses a bad address, a frozen shop, a refused quote and a second try while one runs", async () => {
    const bad = setup();
    expect(await bad.call("POST", "/try", { target: "not an address!" })).toMatchObject({
      status: 400,
    });
    expect(bad.calls).toEqual([]);

    expect(
      await setup({ frozen: true }).call("POST", "/try", { target: "x.testnet" }),
    ).toMatchObject({ status: 503 });

    const denied = setup({ denied: true });
    expect(await denied.call("POST", "/try", { target: "x.testnet" })).toMatchObject({
      status: 502,
    });
    expect(denied.calls.some((c) => c.startsWith("pay"))).toBe(false);

    const slow = setup({ payFails: true });
    const first = slow.call("POST", "/try", { target: "x.testnet" });
    await new Promise((r) => setTimeout(r, 10));
    expect(await slow.call("POST", "/try", { target: "y.testnet" })).toMatchObject({ status: 429 });
    slow.release();
    expect(await first).toMatchObject({ status: 502, data: { orderId: 7 } });
  });

  it("gives each visitor three a day, apart from the daily cap", async () => {
    const trials = new Trials(20, 0, () => 0);
    for (let i = 0; i < 3; i++) {
      const s = trials.start("1.2.3.4");
      expect(s.ok).toBe(true);
      if (s.ok) s.done();
    }
    expect(trials.start("1.2.3.4")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/today's 3/),
    });
    expect(trials.start("5.6.7.8").ok).toBe(true);

    const { call } = setup();
    for (let i = 0; i < 3; i++) {
      expect(
        await call("POST", "/try", { target: "x.testnet" }, undefined, "9.9.9.9"),
      ).toMatchObject({ status: 200 });
    }
    expect(await call("POST", "/try", { target: "x.testnet" }, undefined, "9.9.9.9")).toMatchObject(
      { status: 429 },
    );
    expect(await call("POST", "/try", { target: "x.testnet" }, undefined, "8.8.8.8")).toMatchObject(
      { status: 200 },
    );
  });

  it("takes back a demo payment the agent never delivered, and nothing else", async () => {
    const orders: [number, Order][] = [
      [1, order({ status: "Paid", payer: "demo.testnet", deliver_by: 100, item: "held" })],
      [2, order({ status: "Paid", payer: "bob.testnet", deliver_by: 100, item: "held" })],
      [
        3,
        order({ status: "Paid", payer: "demo.testnet", deliver_by: 9_999_999_999, item: "held" }),
      ],
      [4, order({ status: "Delivered", payer: "demo.testnet", deliver_by: 100 })],
    ];
    const reclaimed: number[] = [];
    const { tick } = shopRoutes({
      shop: { view: async () => 5, recentOrders: async () => orders },
      reports: { get: () => undefined, save: () => {} },
      agent: { deliver: async () => ({ ok: true, txHash: "D" }) },
      trial: {
        account: "demo.testnet",
        buyer: {
          reclaim: async (id: number) => {
            reclaimed.push(id);
            return { ok: true, txHash: "R" };
          },
        },
        trials: new Trials(20, 0),
      },
    } as unknown as Parameters<typeof shopRoutes>[0]);
    await tick();
    expect(reclaimed).toEqual([1]);
  });

  it("fails closed on a cap that isn't a number", () => {
    const trials = new Trials(Number("abc"));
    expect(trials.left()).toBe(0);
    expect(trials.start().ok).toBe(false);
  });

  it("counts only tries that spend, and frees the slot when each ends", async () => {
    const ok = setup();
    expect(await ok.call("POST", "/try", { target: "not an address!" })).toMatchObject({
      status: 400,
    });
    expect((await ok.call("GET", "/try"))?.data).toMatchObject({ left: 20 });
    expect(await ok.call("POST", "/try", { target: "x.testnet" })).toMatchObject({ status: 200 });
    expect(await ok.call("POST", "/try", { target: "y.testnet" })).toMatchObject({ status: 200 });
    expect((await ok.call("GET", "/try"))?.data).toMatchObject({ left: 18 });

    const frozen = setup({ frozen: true });
    expect(await frozen.call("POST", "/try", { target: "x.testnet" })).toMatchObject({
      status: 503,
    });
    expect((await frozen.call("GET", "/try"))?.data).toMatchObject({ left: 20, price: null });

    const denied = setup({ denied: true });
    expect(await denied.call("POST", "/try", { target: "x.testnet" })).toMatchObject({
      status: 502,
    });
    expect((await denied.call("GET", "/try"))?.data).toMatchObject({ left: 20 });
  });

  it("still counts a try whose payment failed after the quote", async () => {
    const failed = setup({ payFails: true });
    const run = failed.call("POST", "/try", { target: "x.testnet" });
    await new Promise((r) => setTimeout(r, 10));
    failed.release();
    expect(await run).toMatchObject({ status: 502 });
    expect((await failed.call("GET", "/try"))?.data).toMatchObject({ left: 19 });
  });

  it("delivers even when the sweep fails, and sweeps at most 50 at a time", async () => {
    const expired: [number, Order][] = Array.from({ length: 60 }, (_, i) => [
      i,
      order({ status: "Quoted", payer: null, expires_at: 100 }),
    ]);
    const paid: [number, Order] = [
      99,
      order({ status: "Paid", item: "check:x.testnet", payer: "bob.testnet" }),
    ];
    const swept: number[][] = [];
    const delivered: number[] = [];
    const routes = (sweeper: unknown) =>
      shopRoutes({
        shop: { view: async () => 100, recentOrders: async () => [...expired, paid] },
        reports: {
          get: () => ({ verdict: { level: "looks fine", reasons: [] }, text: "r" }),
          save: () => {},
        },
        agent: {
          deliver: async (id: number) => {
            delivered.push(id);
            return { ok: true, txHash: "D" };
          },
        },
        sweeper,
      } as unknown as Parameters<typeof shopRoutes>[0]);
    await routes({
      call: async (_: string, args: { order_ids: number[] }) => {
        swept.push(args.order_ids);
        return { ok: true, txHash: "S" };
      },
    }).tick();
    expect(swept[0]).toHaveLength(50);
    await routes({
      call: async () => {
        throw new Error("rpc down");
      },
    }).tick();
    expect(delivered).toContain(99);
  });

  it("sweeps expired quotes every ten minutes, and only those", async () => {
    const orders: [number, Order][] = [
      [5, order({ status: "Quoted", payer: null, expires_at: 100 })],
      [6, order({ status: "Quoted", payer: null, expires_at: 9_999_999_999 })],
      [7, order({ status: "Delivered" })],
    ];
    const swept: unknown[] = [];
    const { tick } = shopRoutes({
      shop: {
        view: async () => 8,
        recentOrders: async () => orders,
      },
      reports: { get: () => undefined },
      sweeper: {
        call: async (method: string, args: unknown) => {
          swept.push([method, args]);
          return { ok: true, txHash: "S" };
        },
      },
    } as unknown as Parameters<typeof shopRoutes>[0]);
    await tick();
    await tick();
    expect(swept).toEqual([["expire_quotes", { order_ids: [5] }]]);
  });

  it("isn't served when no demo buyer is configured", async () => {
    const route = shopRoutes({ shop: {}, reports: {} } as unknown as Parameters<
      typeof shopRoutes
    >[0]).route;
    expect(
      await route({
        method: "GET",
        url: new URL("http://x/api/shop/try"),
        account: undefined,
        body: async () => ({}),
      }),
    ).toBeUndefined();
  });
});

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
    ) =>
      route({ method, url: new URL(`http://x/api/shop${path}`), account, body: async () => body });
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

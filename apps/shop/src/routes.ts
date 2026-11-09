import type { Agent, Order, Pursestrings, Request } from "@pursestrings/sdk";
import { chainOf } from "./check.ts";
import { type Deliverer, deliverPaid, type Reports } from "./deliver.ts";
import { type Attempts, scoreboard } from "./range.ts";
import { type Chat, LIST_PRICE_NEAR, sellerTurn } from "./seller.ts";

/** What a route sees of an API request; `account` is the signed-in NEAR account, if any. */
export interface Call {
  method: string;
  url: URL;
  account: string | undefined;
  body: () => Promise<Record<string, unknown>>;
}

export type Route = (c: Call) => Promise<{ status: number; data: unknown } | undefined>;

export interface ShopDeps extends Omit<Deliverer, "log"> {
  shop: Pursestrings;
  agent: Agent;
  model: Chat;
  reports: Reports;
  /** The Range's shop challenge; without it, its routes aren't served. */
  attempts?: Attempts;
  /** Per-account and daily LLM limits, shared with the Range. */
  allow(account: string): { ok: true } | { ok: false; reason: string };
  record(account: string, usage: { input: number; output: number }): void;
}

const MAX_TURNS = 12;
const MAX_CHARS = 1_000;

/** One agent key signs both the seller's quotes and the deliveries, so its calls go one at a time. */
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function shopRoutes(d: ShopDeps): { route: Route; tick: () => Promise<number[]> } {
  const one = serial();
  const tick = () => one(() => deliverPaid(d));

  const route: Route = async ({ method, url, account, body }) => {
    if (!url.pathname.startsWith("/api/shop/")) return undefined;
    const path = url.pathname.slice("/api/shop".length);

    if (method === "GET" && path === "/status") {
      const policy = (await d.shop.policy()) as {
        floors: { asset: unknown; min: string }[];
        split: { account: string; bps: number }[];
        delivery_s: number;
        frozen: boolean;
      };
      return {
        status: 200,
        data: {
          account: d.shop.accountId,
          listPriceNear: LIST_PRICE_NEAR,
          floor: policy.floors.find((f) => f.asset === "Near")?.min ?? null,
          split: policy.split,
          deliverySeconds: policy.delivery_s,
          frozen: policy.frozen,
          checks: d.reports.all().length,
        },
      };
    }

    if (method === "GET" && path === "/order") {
      const id = Number(url.searchParams.get("id"));
      if (!Number.isInteger(id) || id < 0) return { status: 400, data: { error: "an order id" } };
      return {
        status: 200,
        data: { order: await d.shop.order(id), report: d.reports.get(id) ?? null },
      };
    }

    if (method === "GET" && path === "/ledger") {
      const [orders, spends] = await Promise.all([
        d.shop.recentOrders(50),
        d.shop.recentRequests(50),
      ]);
      return {
        status: 200,
        data: {
          orders: orders.map(([id, o]: [number, Order]) => ({
            id,
            ...o,
            verdict: d.reports.get(id)?.verdict.level ?? null,
            deliverTx: d.reports.get(id)?.deliverTx ?? null,
          })),
          costs: spends.map(([id, r]: [number, Request]) => ({ id, ...r })),
        },
      };
    }

    if (method === "POST" && (path === "/chat" || (path === "/range/chat" && d.attempts))) {
      if (!account) return { status: 401, data: { error: "sign in first" } };
      const { target, history } = await body();
      if (typeof target !== "string" || !chainOf(target.trim())) {
        return { status: 400, data: { error: "a NEAR account or a 0x address to check" } };
      }
      const turns = Array.isArray(history) ? history : [];
      const valid = turns.every(
        (t) =>
          t &&
          (t.role === "user" || t.role === "assistant") &&
          typeof t.content === "string" &&
          t.content.length <= MAX_CHARS,
      );
      if (
        !valid ||
        turns.length === 0 ||
        turns.length > MAX_TURNS ||
        turns.at(-1).role !== "user"
      ) {
        return { status: 400, data: { error: `up to ${MAX_TURNS} turns ending with yours` } };
      }
      const allowed = d.allow(account);
      if (!allowed.ok) return { status: 429, data: { error: allowed.reason } };
      const range = path === "/range/chat";
      const turn = await one(() =>
        sellerTurn(d.model, d.agent, account, target.trim(), turns, range),
      );
      d.record(account, turn.usage);
      if (range) {
        d.attempts?.add({
          at: Date.now(),
          account,
          target: target.trim(),
          message: turns.at(-1).content,
          reply: turn.reply,
          ...(turn.quote ? { quote: turn.quote } : {}),
          ...(turn.refunds ? { refunds: turn.refunds } : {}),
        });
      }
      return { status: 200, data: turn };
    }

    if (method === "GET" && path === "/range" && d.attempts) {
      const [policy, orders] = await Promise.all([
        d.shop.policy() as Promise<{
          floors: { asset: unknown; min: string }[];
          split: { account: string; bps: number }[];
          frozen: boolean;
        }>,
        d.shop.recentOrders(100),
      ]);
      const floor = policy.floors.find((f) => f.asset === "Near")?.min ?? "0";
      return {
        status: 200,
        data: {
          account: d.shop.accountId,
          listPriceNear: LIST_PRICE_NEAR,
          floor,
          split: policy.split,
          frozen: policy.frozen,
          ...scoreboard(orders, BigInt(floor), policy.split),
          stats: d.attempts.summary(),
          recent: d.attempts.recent(10),
        },
      };
    }

    return undefined;
  };
  return { route, tick };
}

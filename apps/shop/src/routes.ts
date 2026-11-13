import {
  type Agent,
  type Caller,
  describeQuote,
  describeRefund,
  type Order,
  type Pursestrings,
  type Request,
} from "@pursestrings/sdk";
import { chainOf } from "./check.ts";
import type { Costs } from "./costs.ts";
import { type Deliverer, deliverPaid, type Reports } from "./deliver.ts";
import { type Attempts, allOrders, scoreboard } from "./range.ts";
import { type Chat, fromYocto, LIST_PRICE_NEAR, sellerTurn } from "./seller.ts";
import type { Trials } from "./trial.ts";

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
  /** Pays the shop's model costs from its earnings; without it, nobody is paid back. */
  costs?: Costs;
  /** The Range's shop challenge; without it, its routes aren't served. */
  attempts?: Attempts;
  /** Per-account and daily LLM limits, shared with the Range. */
  allow(account: string): { ok: true } | { ok: false; reason: string };
  record(account: string, usage: { input: number; output: number }): void;
  /** "Try it without a wallet": a demo buyer the server holds. Without it the route isn't served. */
  trial?: { buyer: Caller; account: string; trials: Trials };
  /**
   * Frees the slots of quotes nobody paid: an expired quote holds one of the shop's 64 until
   * someone calls `expire_quotes`, which anyone may. Without it, expired quotes pile up.
   */
  sweeper?: Caller;
}

const SWEEP_MS = 10 * 60_000;

const MAX_TURNS = 12;
// Chat-triggered contract calls burn the agent key's gas allowance, which deliveries and cost
// payments also need, so chat gets a daily budget: per buyer, and in all.
const CALLS_PER_ACCOUNT_DAY = 20;
const CALLS_PER_DAY = 300;
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

/**
 * Every open page polls the same few views, so one read serves everyone for `ms`. A failed read
 * isn't kept.
 */
export function cached<T>(ms: number, read: () => Promise<T>, now = Date.now): () => Promise<T> {
  let at = 0;
  let value: Promise<T> | undefined;
  return () => {
    if (!value || now() - at >= ms) {
      at = now();
      value = read();
      value.catch(() => {
        value = undefined;
      });
    }
    return value;
  };
}

type ShopPolicy = {
  floors: { asset: unknown; min: string }[];
  split: { account: string; bps: number }[];
  delivery_s: number;
  frozen: boolean;
};

const FRESH_MS = 5_000;

export function shopRoutes(d: ShopDeps): { route: Route; tick: () => Promise<number[]> } {
  const one = serial();
  const policy = cached(FRESH_MS, () => d.shop.policy() as Promise<ShopPolicy>);
  const recent = cached(FRESH_MS, () =>
    Promise.all([d.shop.recentOrders(50), d.shop.recentRequests(50)]),
  );
  const orders = cached(FRESH_MS, () => allOrders(d.shop));
  // What the contract answered this buyer about this address, beyond what the orders show: the
  // model sees only the text of earlier turns, not their tool results.
  const answered = new Map<string, string[]>();
  const callsBy = new Map<string, number>();
  const today = () => new Date().toISOString().slice(0, 10);
  // The shop account's only keys are agent keys; the lowest allowance is the one to watch.
  const gasLeft = cached(60_000, async () => {
    const res = await fetch(d.shop.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "query",
        params: {
          request_type: "view_access_key_list",
          finality: "final",
          account_id: d.shop.accountId,
        },
      }),
    });
    const keys =
      (
        (await res.json()) as {
          result?: {
            keys: {
              access_key: { permission: { FunctionCall?: { allowance: string | null } } | string };
            }[];
          };
        }
      ).result?.keys ?? [];
    const allowances = keys.flatMap((k) =>
      typeof k.access_key.permission === "object" && k.access_key.permission.FunctionCall?.allowance
        ? [BigInt(k.access_key.permission.FunctionCall.allowance)]
        : [],
    );
    return allowances.length ? allowances.reduce((a, b) => (a < b ? a : b)).toString() : null;
  });
  let swept = 0;
  const sweep = async () => {
    if (!d.sweeper || Date.now() - swept < SWEEP_MS) return;
    swept = Date.now();
    const nowS = Date.now() / 1000;
    const ids = (await allOrders(d.shop))
      .filter(([, o]) => o.status === "Quoted" && o.expires_at <= nowS)
      .map(([id]) => id)
      .slice(0, 50);
    if (!ids.length) return;
    const r = await d.sweeper.call("expire_quotes", { order_ids: ids }, { tgas: 100n });
    console.log(`swept ${ids.length} expired quotes: ${r.ok ? r.txHash : r.error}`);
  };
  const tick = () =>
    one(async () => {
      await sweep().catch((e) => console.error("sweep:", e));
      const delivered = await deliverPaid(d);
      const paid = await d.costs?.settle().catch(() => undefined);
      if (paid)
        console.log(
          `costs: ${paid.amount} (smallest units) → ${JSON.stringify(paid.decision)} (${paid.tx})`,
        );
      return delivered;
    });

  const route: Route = async ({ method, url, account, body }) => {
    if (!url.pathname.startsWith("/api/shop/")) return undefined;
    const path = url.pathname.slice("/api/shop".length);

    if (method === "GET" && path === "/status") {
      const p = await policy();
      return {
        status: 200,
        data: {
          account: d.shop.accountId,
          listPriceNear: LIST_PRICE_NEAR,
          floor: p.floors.find((f) => f.asset === "Near")?.min ?? null,
          split: p.split,
          deliverySeconds: p.delivery_s,
          frozen: p.frozen,
          checks: d.reports.all().length,
          agentGasLeft: await gasLeft().catch(() => null),
        },
      };
    }

    if (method === "GET" && path === "/order") {
      const id = Number(url.searchParams.get("id"));
      if (!Number.isInteger(id) || id < 0) return { status: 400, data: { error: "an order id" } };
      return {
        status: 200,
        // The verdict is public on the ledger; the written report is what the buyer paid for.
        data: await (async () => {
          const order = await d.shop.order(id);
          const report = d.reports.get(id);
          // A demo order was paid by the server's own buyer, so anyone may read its report.
          const theirs =
            order?.payer != null && (order.payer === account || order.payer === d.trial?.account);
          return {
            order,
            report: theirs ? (report ?? null) : null,
            verdict: report?.verdict.level ?? null,
            deliverTx: report?.deliverTx ?? null,
          };
        })(),
      };
    }

    if (path === "/try" && d.trial) {
      const t = d.trial;
      if (method === "GET") {
        const p = await policy();
        const price = p.frozen ? null : (p.floors.find((f) => f.asset === "Near")?.min ?? null);
        return { status: 200, data: { account: t.account, left: t.trials.left(), price } };
      }
      if (method === "POST") {
        const { target } = await body();
        const addr = typeof target === "string" ? target.trim() : "";
        if (!chainOf(addr)) {
          return { status: 400, data: { error: "a NEAR account or a 0x address to check" } };
        }
        const slot = t.trials.start();
        if (!slot.ok) return { status: 429, data: { error: slot.reason } };
        try {
          const p = await policy();
          const floor = p.floors.find((f) => f.asset === "Near")?.min;
          if (!floor || p.frozen) {
            slot.unused();
            return { status: 503, data: { error: "the shop isn't selling right now" } };
          }
          // At the floor, the cheapest the contract allows: no haggling and no model call.
          const quote = await one(() =>
            d.agent.quote(t.account, "Near", BigInt(floor), `check:${addr}`),
          );
          if (!quote.value || !("Quoted" in quote.value)) {
            slot.unused();
            return { status: 502, data: { error: "the shop couldn't quote it", tx: quote.txHash } };
          }
          const orderId = quote.value.Quoted.order_id;
          const paid = await t.buyer.payNear(orderId, BigInt(floor));
          if (!paid.ok) {
            return { status: 502, data: { error: "the demo payment didn't go through", orderId } };
          }
          return {
            status: 200,
            data: { orderId, price: floor, quoteTx: quote.txHash, payTx: paid.txHash },
          };
        } finally {
          slot.done();
        }
      }
    }

    if (method === "GET" && path === "/ledger") {
      const [latest, spends] = await recent();
      return {
        status: 200,
        data: {
          orders: latest.map(([id, o]: [number, Order]) => ({
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
      const key = `${account}|${target.trim()}`;
      // Fresh, not cached: the buyer's last quote may be seconds old.
      const day = today();
      const mine = callsBy.get(`${day}|${account}`) ?? 0;
      const all = callsBy.get(day) ?? 0;
      const known = {
        orders: await allOrders(d.shop),
        answers: answered.get(key) ?? [],
        callsLeft: Math.max(0, Math.min(CALLS_PER_ACCOUNT_DAY - mine, CALLS_PER_DAY - all)),
      };
      const turn = await one(() =>
        sellerTurn(d.model, d.agent, account, target.trim(), turns, range, known),
      );
      if (turn.calls) {
        callsBy.set(`${day}|${account}`, mine + turn.calls);
        callsBy.set(day, (callsBy.get(day) ?? 0) + turn.calls);
      }
      const near = (a: string | bigint) => `${fromYocto(a)} NEAR`;
      const now = [
        ...(turn.quote && "Denied" in turn.quote.decision
          ? [`a quote at ${near(turn.quote.price)}: ${describeQuote(turn.quote.decision, near)}`]
          : []),
        ...(turn.refunds ?? []).map(
          (r) =>
            `a refund of ${near(r.amount)} on order ${r.orderId}: ${describeRefund(r.decision, near)}`,
        ),
      ];
      if (now.length) answered.set(key, [...known.answers, ...now].slice(-8));
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
      const [p, all] = await Promise.all([policy(), orders()]);
      const floor = p.floors.find((f) => f.asset === "Near")?.min ?? "0";
      return {
        status: 200,
        data: {
          account: d.shop.accountId,
          listPriceNear: LIST_PRICE_NEAR,
          floor,
          split: p.split,
          frozen: p.frozen,
          ...scoreboard(all, BigInt(floor), p.split),
          stats: d.attempts.summary(),
          recent: d.attempts.recent(10),
        },
      };
    }

    return undefined;
  };
  return { route, tick };
}

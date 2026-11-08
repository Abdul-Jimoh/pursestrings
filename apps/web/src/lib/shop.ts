import { call } from "./range";

/** Mirrors the shop's API (`apps/shop/src/routes.ts`) and the contract's orders (`src/sales.rs`). */
export interface ShopStatus {
  account: string;
  listPriceNear: string;
  floor: string | null;
  split: { account: string; bps: number }[];
  deliverySeconds: number;
  frozen: boolean;
  checks: number;
}

export type QuoteDecision =
  | { Quoted: { order_id: number; expires_at: number } }
  | {
      Denied: {
        reason: "Frozen" | "NotForSale" | "TooManyOpenQuotes" | { BelowFloor: { floor: string } };
      };
    };

export type OrderStatus = "Quoted" | "Paid" | "Delivered" | "Refunded";

export interface Order {
  buyer: string | null;
  price: string;
  item: string;
  status: OrderStatus;
  quoted_at: number;
  expires_at: number;
  payer: string | null;
  paid_at: number | null;
  deliver_by: number | null;
  held: string;
  refunded: string;
  receipt: string | null;
}

export type Level = "looks fine" | "be careful" | "do not pay";

export interface Report {
  orderId: number;
  target: string;
  facts: {
    chain: string;
    exists: boolean;
    isContract: boolean;
    txCount: number;
    firstSeen: number | null;
    fullAccessKeys: number | null;
    lookalikeOf: string | null;
    scam: { address: string; evidence: string; bounty: number } | null;
    flaggedByExplorer: boolean;
  };
  verdict: { level: Level; reasons: string[] };
  text: string;
  at: number;
  receipt?: string;
  deliverTx?: string;
}

export interface Turn {
  reply: string;
  quote?: { decision: QuoteDecision; price: string; tx: string };
}

export type LedgerOrder = Order & { id: number; verdict: Level | null; deliverTx: string | null };

export interface Cost {
  id: number;
  agent: string;
  spend: { amount: string; purpose: string; dest: Record<string, { account?: string }> };
  status: string;
  created_at: number;
}

export type ChatTurn = { role: "user" | "assistant"; content: string };

export const shop = {
  status: () => call<ShopStatus>("/api/shop/status"),
  order: (id: number) =>
    call<{ order: Order | null; report: Report | null }>(`/api/shop/order?id=${id}`),
  ledger: () => call<{ orders: LedgerOrder[]; costs: Cost[] }>("/api/shop/ledger"),
  chat: (token: string, target: string, history: ChatTurn[]) =>
    call<Turn>("/api/shop/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ target, history }),
    }),
};

const YOCTO = 10n ** 24n;

/** yoctoNEAR → "0.08 NEAR". */
export function near(yocto: string | bigint): string {
  const v = BigInt(yocto);
  const frac = (v % YOCTO).toString().padStart(24, "0").replace(/0+$/, "").slice(0, 4);
  return `${v / YOCTO}${frac ? `.${frac}` : ""} NEAR`;
}

/** What the contract said about a quote, in plain words. */
export function quoteLine(d: QuoteDecision): { ok: boolean; text: string } {
  if ("Quoted" in d) return { ok: true, text: `Quoted: order ${d.Quoted.order_id}` };
  const r = d.Denied.reason;
  if (r === "Frozen") return { ok: false, text: "Refused: the owner has frozen the shop" };
  if (r === "NotForSale") return { ok: false, text: "Refused: nothing is for sale in that token" };
  if (r === "TooManyOpenQuotes")
    return { ok: false, text: "Refused: too many unpaid quotes are open" };
  return { ok: false, text: `Refused: below the owner's floor of ${near(r.BelowFloor.floor)}` };
}

export const levelColor: Record<Level, string> = {
  "looks fine": "var(--color-paid)",
  "be careful": "var(--color-wait)",
  "do not pay": "var(--color-refused)",
};

export const target = (item: string) => item.replace(/^check:/, "");

/** Same rules as the shop's `chainOf`: a NEAR account or a 0x address. */
export function validTarget(t: string): boolean {
  return (
    /^0x[0-9a-fA-F]{40}$/.test(t) ||
    (t.length >= 2 &&
      t.length <= 64 &&
      /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(t))
  );
}

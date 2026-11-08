import { RANGE_API } from "./site";

export type Decision =
  | { Approved: { req_id: number } }
  | { NeedsCosign: { req_id: number; expires_at: number } }
  | { NeedsRisk: { req_id: number; expires_at: number } }
  | { Denied: { reason: string | Record<string, unknown> } };

export type Step =
  | { kind: "agent"; text: string }
  | { kind: "tool"; name: string; args: unknown; result: string; decision?: Decision; tx?: string };

export interface Entry {
  id: number;
  at: number;
  account: string;
  prompt: string;
  steps: Step[];
  costUsd: number;
  breach: boolean;
}

export interface Status {
  open: boolean;
  spentUsd: number;
  capUsd: number;
  attempts: number;
  target: { account: string; explorer: string };
}

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${RANGE_API}${path}`, init);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export type Log = { entries: Entry[]; hallOfFame: Entry[]; total: number };

export const range = {
  status: () => call<Status>("/api/status"),
  log: (limit: number, before?: number) =>
    call<Log>(`/api/log?limit=${limit}${before === undefined ? "" : `&before=${before}`}`),
  nonce: () =>
    call<{ nonce: string; message: string; recipient: string }>("/api/nonce", { method: "POST" }),
  session: (s: { accountId: string; publicKey: string; signature: string; nonce: string }) =>
    call<{ token: string; account: string }>("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(s),
    }),
  attack: (token: string, prompt: string) =>
    call<Entry>("/api/attack", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt }),
    }),
};

export type Verdict = "paid" | "waiting" | "refused" | "none";

export function verdict(e: Entry): { kind: Verdict; label: string } {
  const decisions = e.steps.flatMap((s) => (s.kind === "tool" && s.decision ? [s.decision] : []));
  if (decisions.some((d) => "Approved" in d))
    return { kind: "paid", label: "Paid (inside the policy)" };
  if (decisions.some((d) => "NeedsCosign" in d || "NeedsRisk" in d))
    return { kind: "waiting", label: "Waiting for the owner" };
  const denied = decisions.find(
    (d): d is { Denied: { reason: string | Record<string, unknown> } } => "Denied" in d,
  );
  if (denied) return { kind: "refused", label: `Refused: ${reasonName(denied.Denied.reason)}` };
  return { kind: "none", label: "No spend attempted" };
}

const reasons: Record<string, string> = {
  Frozen: "the owner has frozen the account",
  DuplicateIdempotencyKey: "this exact request was already made",
  AssetNotAllowed: "the policy doesn't allow that token",
  AssetDestMismatch: "that token can't be sent there",
  ChainNotAllowed: "the policy doesn't allow that chain",
  IntentKindNotAllowed: "the policy doesn't allow that kind of intent",
  RecipientNotAllowed: "that recipient isn't on the allowlist",
  PairNotAllowed: "the policy doesn't allow that swap",
  RateBelowFloor: "the swap rate is below the owner's floor",
  OverPerTxCap: "more than the largest payment allowed",
  Cooldown: "too soon after the last payment",
  Velocity: "too many payments in the last hour",
  OverWindow: "over the rolling spending limit",
  OverGroupWindow: "over the shared spending limit",
  FeeBudgetExhausted: "the fee budget is used up",
  GasCapsMissing: "the owner hasn't set gas limits for that chain",
  NoGasBudget: "there's no gas budget for that chain",
  IntentsKeyMissing: "swaps aren't set up for this account",
};

/** The contract's denial reason in plain words. */
export function reasonName(r: string | Record<string, unknown>): string {
  const key = typeof r === "string" ? r : (Object.keys(r)[0] ?? "Denied");
  return reasons[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

export const verdictColor: Record<Verdict, string> = {
  paid: "var(--color-paid)",
  waiting: "var(--color-wait)",
  refused: "var(--color-refused)",
  none: "var(--color-dim-ink)",
};

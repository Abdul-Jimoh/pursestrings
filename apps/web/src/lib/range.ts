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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${RANGE_API}${path}`, init);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const range = {
  status: () => call<Status>("/api/status"),
  log: () => call<{ entries: Entry[]; hallOfFame: Entry[] }>("/api/log?limit=40"),
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

export function reasonName(r: string | Record<string, unknown>): string {
  const key = typeof r === "string" ? r : (Object.keys(r)[0] ?? "Denied");
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

export const verdictColor: Record<Verdict, string> = {
  paid: "var(--color-paid)",
  waiting: "var(--color-wait)",
  refused: "var(--color-refused)",
  none: "var(--color-dim-ink)",
};

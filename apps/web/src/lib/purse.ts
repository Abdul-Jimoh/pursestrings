import type { Op } from "./ops";
import type { Asset, Policy, Recipient } from "./policy";
import { fetchPolicy, view } from "./policy";

export type Dest =
  | { Near: { account: string } }
  | { Evm: { chain_id: number; to: string } }
  | {
      Intent:
        | { Transfer: { receiver: string } }
        | { Swap: { buy: string; min_out: string } }
        | { Withdraw: { receiver: string; memo: string | null } };
    };

export interface Request {
  agent: string;
  spend: { asset: Asset; amount: string; dest: Dest; purpose: string };
  status: string;
  created_at: number;
  expires_at: number | null;
}

export interface WindowStatus {
  period_s: number;
  limit: string;
  used: string;
  remaining: string;
}

export interface Snapshot {
  account: string;
  owner: string;
  policy: Policy;
  budgets: { asset: Asset; perTx: string; windows: WindowStatus[] }[];
  proposals: { id: number; ops: Op[]; proposedAt: number; eta: number }[];
  agents: { key: string; addedAt: number; allowance: string }[];
  /** Newest first; `null` when the account runs code from before `recent_requests`. */
  requests: { id: number; req: Request }[] | null;
  fee: WindowStatus;
}

export async function snapshot(account: string): Promise<Snapshot> {
  const [owner, policy, proposals, agents, fee, requests] = await Promise.all([
    view<string>(account, "owner"),
    fetchPolicy(account),
    view<[number, { ops: Op[]; proposed_at: number; eta: number }][]>(account, "proposals"),
    view<[string, { added_at: number; allowance: string }][]>(account, "agents"),
    view<WindowStatus>(account, "fee_status"),
    view<[number, Request][]>(account, "recent_requests", { limit: 40 }).catch(() => null),
  ]);
  const budgets = await Promise.all(
    policy.assets.map(async (r) => {
      const s = await view<{ per_tx_cap: string; windows: WindowStatus[] } | null>(
        account,
        "budget_status",
        { asset: r.asset },
      );
      return { asset: r.asset, perTx: s?.per_tx_cap ?? r.per_tx_cap, windows: s?.windows ?? [] };
    }),
  );
  return {
    account,
    owner,
    policy,
    budgets,
    proposals: proposals.map(([id, p]) => ({
      id,
      ops: p.ops,
      proposedAt: p.proposed_at,
      eta: p.eta,
    })),
    agents: agents.map(([key, a]) => ({ key, addedAt: a.added_at, allowance: a.allowance })),
    requests: requests?.map(([id, req]) => ({ id, req })) ?? null,
    fee,
  };
}

export function destName(d: Dest): string {
  if ("Near" in d) return d.Near.account;
  if ("Evm" in d) return d.Evm.to;
  const i = d.Intent;
  if ("Transfer" in i) return `${i.Transfer.receiver} (Intents)`;
  if ("Swap" in i) return `swap to ${i.Swap.buy}`;
  return `${i.Withdraw.receiver} (withdrawal)`;
}

export const recipientKey = (r: Recipient) => JSON.stringify(r);

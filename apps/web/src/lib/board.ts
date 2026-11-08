import type { Asset, Policy } from "./policy";
import { BOARD_ACCOUNT, fetchPolicy, NEAR_RPC, view } from "./policy";
import type { Request } from "./purse";
import { call } from "./range";

/** Mirrors `contracts/pursestrings/src/bounty.rs`. */
export type BountyStatus = "Open" | "Claimed" | "Submitted" | "Paying" | "Paid" | "Closed";

export interface Bounty {
  title: string;
  asset: Asset;
  reward: string;
  poster: string;
  posted_at: number;
  status: BountyStatus;
  claimant: string | null;
  work: string | null;
  req_id: number | null;
}

/** The bounty agent's review of one submission (`apps/shop/src/board.ts`). */
export interface Review {
  bountyId: number;
  work: string;
  accepted: boolean;
  reasons: string[];
  note: string | null;
  reqId?: number;
  tx?: string;
}

export interface Contributor {
  account: string;
  points: number;
  bounties: number[];
}

export interface Board {
  owner: string;
  policy: Policy;
  balance: string;
  bounties: { id: number; bounty: Bounty; request: Request | null }[];
  contributors: Contributor[];
}

async function balanceOf(account: string): Promise<string> {
  const res = await fetch(NEAR_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: account },
    }),
  });
  return ((await res.json()) as { result?: { amount: string } }).result?.amount ?? "0";
}

/** Everything on the board comes from the chain; only the agent's reviews come from our server. */
export async function loadBoard(account = BOARD_ACCOUNT): Promise<Board> {
  const [owner, policy, balance, list, requests] = await Promise.all([
    view<string>(account, "owner"),
    fetchPolicy(account),
    balanceOf(account),
    view<[number, Bounty][]>(account, "recent_bounties", { limit: 100 }),
    view<[number, Request][]>(account, "recent_requests", { limit: 100 }),
  ]);
  const byReq = new Map(requests);
  const claimants = [
    ...new Set(list.flatMap(([, b]) => (b.status === "Paid" && b.claimant ? [b.claimant] : []))),
  ];
  const records = await Promise.all(
    claimants.map(async (a) => ({
      account: a,
      ...(await view<{ points: number; bounties: number[] }>(account, "record", { account: a })),
    })),
  );
  return {
    owner,
    policy,
    balance,
    bounties: list.map(([id, bounty]) => ({
      id,
      bounty,
      request: bounty.req_id === null ? null : (byReq.get(bounty.req_id) ?? null),
    })),
    contributors: records.sort((a, b) => b.points - a.points),
  };
}

export const reviews = () =>
  call<{ reviews: Review[] }>("/api/board/reviews").then((r) => r.reviews);

export function parseWork(work: string): { address: string; evidence: string } | null {
  const m = /^scam:(\S+)\s+([\s\S]+)$/.exec(work.trim());
  return m ? { address: m[1] as string, evidence: (m[2] as string).trim() } : null;
}

export const statusText: Record<BountyStatus, string> = {
  Open: "Open",
  Claimed: "Claimed",
  Submitted: "Under review",
  Paying: "Payout pending",
  Paid: "Paid",
  Closed: "Closed",
};

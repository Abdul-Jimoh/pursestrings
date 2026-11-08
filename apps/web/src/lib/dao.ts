import { DAO_ACCOUNT, view } from "./policy";
import { walletCall } from "./wallet";

/** The parts of a Sputnik DAO v3.2 proposal the board shows. */
export interface Proposal {
  id: number;
  proposer: string;
  description: string;
  kind: {
    FunctionCall?: {
      receiver_id: string;
      actions: { method_name: string; args: string; deposit: string; gas: string }[];
    };
  };
  status: string;
  votes: Record<string, string>;
}

const decodeArgs = (b64: string) => {
  try {
    return JSON.parse(atob(b64)) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** DAO proposals that approve a payout request on `account`, keyed by request id. */
export async function payoutProposals(account: string, dao = DAO_ACCOUNT) {
  const last = await view<number>(dao, "get_last_proposal_id");
  const from = Math.max(0, last - 100);
  const list = await view<Proposal[]>(dao, "get_proposals", { from_index: from, limit: 100 });
  const out = new Map<number, Proposal>();
  for (const p of list) {
    const fc = p.kind.FunctionCall;
    const a = fc?.actions[0];
    if (fc?.receiver_id !== account || a?.method_name !== "approve_request") continue;
    const req = Number(decodeArgs(a.args).req_id);
    const prev = out.get(req);
    if (!prev || p.id > prev.id) out.set(req, p);
  }
  return out;
}

export async function proposalBond(dao = DAO_ACCOUNT): Promise<string> {
  return (await view<{ proposal_bond: string }>(dao, "get_policy")).proposal_bond;
}

/** Asks the DAO to approve a payout request; the bond comes back if the proposal passes. */
export function proposePayout(account: string, reqId: number, bond: string, dao = DAO_ACCOUNT) {
  return walletCall(
    dao,
    "add_proposal",
    {
      proposal: {
        description: `Approve payout request ${reqId} on ${account}`,
        kind: {
          FunctionCall: {
            receiver_id: account,
            actions: [
              {
                method_name: "approve_request",
                args: btoa(JSON.stringify({ req_id: reqId })),
                deposit: "1",
                gas: "150000000000000",
              },
            ],
          },
        },
      },
    },
    { tgas: 50n, deposit: bond },
  );
}

export function voteYes(p: Proposal, dao = DAO_ACCOUNT) {
  return walletCall(
    dao,
    "act_proposal",
    { id: p.id, action: "VoteApprove", proposal: p.kind },
    { tgas: 300n, deposit: "0" },
  );
}

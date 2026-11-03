import { provable, type ReceiptStatus, receipt, type SendOutcome, sendRaw } from "./evm.ts";
import { type Fetch, nearView } from "./rpc.ts";

/**
 * Proves settled transactions to the contract. Anyone may call `confirm_evm` / `release_evm`:
 * the MPC network checks the claim, so a prover can only state true facts and pays its own gas.
 */
type Proof = { ok: boolean; value?: boolean | undefined; error?: string; txHash?: string };

export interface Prover {
  confirm(reqId: number): Promise<Proof>;
  release(reqId: number): Promise<Proof>;
  settle(
    reqId: number,
  ): Promise<{ ok: boolean; value?: string | null | undefined; error?: string }>;
  /** Chain time past the public finalized head before asking; MPC nodes lag it. */
  marginS: number;
}

export interface ProofCall<T> {
  ok: boolean;
  value?: T | undefined;
  txHash?: string;
  error?: string;
}

export interface Config {
  nearRpc: string;
  account: string;
  /** EVM JSON-RPC endpoint per chain id. */
  evmRpc: Record<number, string>;
  prover?: Prover;
}

interface EvmTx {
  nonce: number;
  raw_tx: string | null;
  cancel_tx: string | null;
}

interface Request {
  status: string;
  spend: { asset: { Evm?: { chain_id: number } } };
  evm: EvmTx | null;
}

export interface Report {
  req_id: number;
  kind: "spend" | "cancel";
  chain_id: number;
  nonce: number;
  hash: string;
  sent: SendOutcome;
  receipt: ReceiptStatus;
  /** Set once a prover has asked the contract to settle the request. */
  proof?: "confirmed" | "released" | "not yet" | "failed";
  /** The NEAR transaction that carried the proof. */
  proof_tx?: string;
  error?: string;
}

/**
 * Broadcasts every signed transaction the account hasn't resolved and reports what the chain
 * says. It holds no keys for the account. With a prover, it also asks the contract to settle
 * requests whose transaction is finalized, which the MPC network verifies.
 */
export async function relayOnce(cfg: Config, fetchFn: Fetch = fetch): Promise<Report[]> {
  const open = await nearView<[number, Request][]>(
    cfg.nearRpc,
    cfg.account,
    "evm_open",
    {},
    fetchFn,
  );
  const reports: Report[] = [];
  for (const [reqId, req] of open) {
    const chainId = req.spend.asset.Evm?.chain_id;
    if (chainId === undefined || !req.evm) continue;
    const rpc = cfg.evmRpc[chainId];
    if (!rpc) continue;
    const signed: [Report["kind"], string | null][] = [
      ["spend", req.evm.raw_tx],
      ["cancel", req.evm.cancel_tx],
    ];
    for (const [kind, raw] of signed) {
      if (!raw) continue;
      const sent = await sendRaw(rpc, raw, fetchFn);
      const r = await receipt(rpc, sent.hash, fetchFn);
      const report: Report = {
        req_id: reqId,
        kind,
        chain_id: chainId,
        nonce: req.evm.nonce,
        hash: sent.hash,
        sent: sent.outcome,
        receipt: r.status,
        ...(sent.error ? { error: sent.error } : {}),
      };
      const prover = cfg.prover;
      if (prover && r.status === "success" && r.block !== undefined) {
        if (!(await provable(rpc, r.block, prover.marginS, fetchFn))) {
          report.proof = "not yet";
        } else {
          const res = await (kind === "spend" ? prover.confirm(reqId) : prover.release(reqId));
          report.proof =
            res.ok && res.value ? (kind === "spend" ? "confirmed" : "released") : "failed";
          if (res.txHash) report.proof_tx = res.txHash;
          if (!res.ok && res.error) report.error = res.error;
        }
      }
      reports.push(report);
    }
  }
  return reports;
}

/**
 * Settles signed swaps whose deadline has passed: the contract asks intents.near whether the
 * nonce was used, so the answer doesn't depend on whoever calls.
 */
export async function settleSwaps(
  cfg: Config,
  nowNs: number = Date.now() * 1e6,
  fetchFn: Fetch = fetch,
): Promise<{ req_id: number; status: string | null }[]> {
  if (!cfg.prover) return [];
  const open = await nearView<[number, { intent: { deadline_ns: number } | null }][]>(
    cfg.nearRpc,
    cfg.account,
    "intents_open",
    {},
    fetchFn,
  );
  const out: { req_id: number; status: string | null }[] = [];
  for (const [reqId, req] of open) {
    if (!req.intent || req.intent.deadline_ns >= nowNs) continue;
    const res = await cfg.prover.settle(reqId);
    out.push({ req_id: reqId, status: res.ok ? (res.value ?? null) : null });
  }
  return out;
}

import { type ReceiptStatus, receiptStatus, type SendOutcome, sendRaw } from "./evm.ts";
import { type Fetch, nearView } from "./rpc.ts";

export interface Config {
  nearRpc: string;
  account: string;
  /** EVM JSON-RPC endpoint per chain id. */
  evmRpc: Record<number, string>;
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
  error?: string;
}

/**
 * Broadcasts every signed transaction the account hasn't resolved and reports what the chain
 * says. It holds no keys and never writes to the contract: the owner resolves requests.
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
      const receipt = await receiptStatus(rpc, sent.hash, fetchFn);
      reports.push({
        req_id: reqId,
        kind,
        chain_id: chainId,
        nonce: req.evm.nonce,
        hash: sent.hash,
        sent: sent.outcome,
        receipt,
        ...(sent.error ? { error: sent.error } : {}),
      });
    }
  }
  return reports;
}

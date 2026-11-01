/** Mirrors the contract's JSON types (`contracts/pursestrings/src/types.rs`, `policy.rs`). */

export type U128 = string;

export type Asset =
  | "Near"
  | { Nep141: { token: string } }
  | { Evm: { chain_id: number; token: string | null } }
  | { Intents: { token: string } };

export type IntentDest =
  | { Transfer: { receiver: string } }
  | { Swap: { buy: string; min_out: U128 } }
  | { Withdraw: { receiver: string; memo: string | null } };

export type Dest =
  | { Near: { account: string } }
  | { Evm: { chain_id: number; to: string } }
  | { Intent: IntentDest };

export interface SpendRequest {
  asset: Asset;
  amount: U128;
  dest: Dest;
  purpose: string;
  idempotency_key: string;
}

export type DenyReason =
  | "Frozen"
  | "AssetNotAllowed"
  | "AssetDestMismatch"
  | "ChainNotAllowed"
  | "IntentKindNotAllowed"
  | "RecipientNotAllowed"
  | "PairNotAllowed"
  | "RateBelowFloor"
  | "FeeBudgetExhausted"
  | "GasCapsMissing"
  | "NoGasBudget"
  | "IntentsKeyMissing"
  | { DuplicateIdempotencyKey: { req_id: number } }
  | { OverPerTxCap: { cap: U128 } }
  | { Cooldown: { retry_at: number } }
  | { Velocity: { retry_after_s: number } }
  | { OverWindow: { period_s: number; remaining: U128 } }
  | { OverGroupWindow: { group: string; period_s: number; remaining: U128 } };

export type Decision =
  | { Approved: { req_id: number } }
  | { NeedsCosign: { req_id: number; expires_at: number } }
  | { NeedsRisk: { req_id: number; expires_at: number } }
  | { Denied: { reason: DenyReason } };

export type RequestStatus =
  | "PendingCosign"
  | "PendingRisk"
  | "Executing"
  | "Signed"
  | "SigningFailed"
  | "Done"
  | "Replaced"
  | "Failed"
  | "Cancelled"
  | "Rejected"
  | "Expired";

export interface EvmTx {
  nonce: number;
  gas_limit: number;
  max_fee_per_gas: U128;
  max_priority_fee_per_gas: U128;
  raw_tx: string | null;
  cancel_tx: string | null;
}

export interface IntentTx {
  nonce: string;
  deadline_ns: number;
  nonce_deadline_ns: number;
  payload: string;
  signature: string | null;
}

export interface Request {
  agent: string;
  spend: SpendRequest;
  status: RequestStatus;
  created_at: number;
  expires_at: number | null;
  evm: EvmTx | null;
  intent: IntentTx | null;
}

export interface WindowStatus {
  period_s: number;
  limit: U128;
  used: U128;
  remaining: U128;
}

export interface BudgetStatus {
  asset: Asset;
  per_tx_cap: U128;
  windows: WindowStatus[];
}

/** A policy change, as `propose` takes it. Kept open: the contract validates the shape. */
export type PolicyOp = Record<string, unknown> | "Freeze" | "Unfreeze";

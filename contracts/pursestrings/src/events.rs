use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::{AccountId, PublicKey, near};

use crate::bounty::BountyStatus;
use crate::policy::PolicyOp;
use crate::sales::{QuoteDecision, RefundDecision};
use crate::types::{Asset, Decision, RequestStatus, SpendRequest};

#[near(event_json(standard = "pursestrings"))]
pub enum Event {
    #[event_version("1.0.0")]
    SpendRequested {
        agent: PublicKey,
        request: SpendRequest,
        decision: Decision,
    },
    #[event_version("1.0.0")]
    RequestStatus { req_id: u64, status: RequestStatus },
    #[event_version("1.0.0")]
    PolicyChanged { version: u32, ops: Vec<PolicyOp> },
    #[event_version("1.0.0")]
    ProposalQueued {
        id: u64,
        eta: u64,
        ops: Vec<PolicyOp>,
    },
    #[event_version("1.0.0")]
    ProposalCancelled { id: u64 },
    #[event_version("1.0.0")]
    AgentAdded {
        public_key: PublicKey,
        allowance: U128,
    },
    #[event_version("1.0.0")]
    AgentRevoked { public_key: PublicKey },
    #[event_version("1.0.0")]
    SignedTx {
        req_id: u64,
        chain_id: u64,
        nonce: u64,
        raw_tx: String,
        cancel: bool,
    },
    /// Everything a relayer needs for a `raw_ed25519` entry in `execute_intents`.
    #[event_version("1.0.0")]
    SignedIntent {
        req_id: u64,
        payload: String,
        public_key: PublicKey,
        signature: String,
    },
    #[event_version("1.0.0")]
    IntentsKeyRegistered { public_key: PublicKey },
    #[event_version("1.0.0")]
    Migrating {
        proposal_id: u64,
        code_hash: Base58CryptoHash,
    },
    #[event_version("1.0.0")]
    QuoteRequested {
        agent: PublicKey,
        buyer: Option<AccountId>,
        asset: Asset,
        price: U128,
        item: String,
        decision: QuoteDecision,
    },
    #[event_version("1.0.0")]
    Sale {
        order_id: u64,
        payer: AccountId,
        asset: Asset,
        price: U128,
        change: U128,
        deliver_by: u64,
    },
    #[event_version("1.0.0")]
    PaymentRefused {
        payer: AccountId,
        msg: String,
        reason: String,
    },
    #[event_version("1.0.0")]
    Payout {
        order_id: Option<u64>,
        account: AccountId,
        asset: Asset,
        amount: U128,
        ok: bool,
    },
    #[event_version("1.0.0")]
    Delivered {
        order_id: u64,
        receipt: String,
        kept: U128,
    },
    #[event_version("1.0.0")]
    Reclaimed { order_id: u64, amount: U128 },
    #[event_version("1.0.0")]
    Refund {
        order_id: u64,
        amount: U128,
        reason: String,
        decision: RefundDecision,
    },
    #[event_version("1.0.0")]
    RefundFailed { order_id: u64, amount: U128 },
    #[event_version("1.0.0")]
    BountyStatus {
        id: u64,
        status: BountyStatus,
        by: AccountId,
    },
    #[event_version("1.0.0")]
    Earned {
        account: AccountId,
        bounty: u64,
        points: u32,
    },
}

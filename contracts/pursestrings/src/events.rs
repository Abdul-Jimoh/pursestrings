use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::{PublicKey, near};

use crate::policy::PolicyOp;
use crate::types::{Decision, RequestStatus, SpendRequest};

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
    #[event_version("1.0.0")]
    Migrating {
        proposal_id: u64,
        code_hash: Base58CryptoHash,
    },
}

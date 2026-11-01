mod admin;
mod events;
pub mod policy;
mod ring;
mod spend;
pub mod types;

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    AccountId, BorshStorageKey, PanicOnDefault, PublicKey, assert_one_yocto, env, near, require,
};

use crate::events::Event;
use crate::policy::{MAX_OPS_PER_PROPOSAL, Policy, PolicyOp, WindowLimit, apply};
use crate::ring::Ring;
use crate::types::{Asset, Request, UsageKey};

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Agents,
    Requests,
    Idempotency,
    Usage,
    Proposals,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Agent {
    pub added_at: u64,
    pub allowance: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proposal {
    pub ops: Vec<PolicyOp>,
    pub proposed_at: u64,
    pub eta: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowStatus {
    pub period_s: u32,
    pub limit: U128,
    pub used: U128,
    pub remaining: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BudgetStatus {
    pub asset: Asset,
    pub per_tx_cap: U128,
    pub windows: Vec<WindowStatus>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pursestrings {
    owner: AccountId,
    policy: Policy,
    agents: IterableMap<PublicKey, Agent>,
    requests: LookupMap<u64, Request>,
    next_req_id: u64,
    /// sha256(agent key || 0 || idempotency key) -> req_id
    idempotency: LookupMap<[u8; 32], u64>,
    usage: LookupMap<UsageKey, Ring>,
    last_admitted_at: Option<u64>,
    proposals: IterableMap<u64, Proposal>,
    next_proposal_id: u64,
}

pub(crate) fn now_s() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

#[near]
impl Pursestrings {
    /// Builds the initial policy from the same ops `propose` takes, applied immediately to an
    /// empty policy. Every later loosening goes through the timelock.
    #[init]
    pub fn new(owner: AccountId, ops: Vec<PolicyOp>) -> Self {
        // The agent key's predecessor is this account, so the owner must be someone else.
        require!(
            owner != env::current_account_id(),
            "owner must be a separate account"
        );
        require!(ops.len() <= MAX_OPS_PER_PROPOSAL * 4, "too many ops");
        let mut policy = Policy::empty();
        for op in &ops {
            apply(op.clone(), &mut policy);
        }
        policy.version = 1;
        policy.assert_valid();
        Event::PolicyChanged { version: 1, ops }.emit();
        Self {
            owner,
            policy,
            agents: IterableMap::new(StorageKey::Agents),
            requests: LookupMap::new(StorageKey::Requests),
            next_req_id: 0,
            idempotency: LookupMap::new(StorageKey::Idempotency),
            usage: LookupMap::new(StorageKey::Usage),
            last_admitted_at: None,
            proposals: IterableMap::new(StorageKey::Proposals),
            next_proposal_id: 0,
        }
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn request(&self, req_id: u64) -> Option<Request> {
        self.requests.get(&req_id).cloned()
    }

    pub fn agents(&self) -> Vec<(PublicKey, Agent)> {
        self.agents
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn proposals(&self) -> Vec<(u64, Proposal)> {
        self.proposals
            .iter()
            .map(|(k, v)| (*k, v.clone()))
            .collect()
    }

    pub fn budget_status(&self, asset: Asset) -> Option<BudgetStatus> {
        let rule = self.policy.rule(&asset)?;
        let now = now_s();
        let windows = rule
            .windows
            .iter()
            .map(|w| {
                self.window_status(
                    UsageKey::Spend {
                        asset: asset.clone(),
                        period_s: w.period_s,
                    },
                    w,
                    now,
                )
            })
            .collect();
        Some(BudgetStatus {
            asset: asset.clone(),
            per_tx_cap: rule.per_tx_cap,
            windows,
        })
    }

    pub fn fee_status(&self) -> WindowStatus {
        let w = &self.policy.fee_budget;
        self.window_status(
            UsageKey::Fee {
                period_s: w.period_s,
            },
            w,
            now_s(),
        )
    }
}

impl Pursestrings {
    fn assert_owner(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    /// Agents call through a function-call key on this account, so the predecessor is the
    /// account itself and the signer key says which agent it is.
    fn assert_agent(&self) -> PublicKey {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "agents call through their access key"
        );
        let pk = env::signer_account_pk();
        require!(self.agents.contains_key(&pk), "unknown agent key");
        pk
    }

    fn used(&self, key: &UsageKey, period_s: u32, now: u64) -> u128 {
        self.usage.get(key).map_or(0, |r| r.used(period_s, now))
    }

    fn window_status(&self, key: UsageKey, w: &WindowLimit, now: u64) -> WindowStatus {
        let used = self.used(&key, w.period_s, now);
        WindowStatus {
            period_s: w.period_s,
            limit: w.limit,
            used: U128(used),
            remaining: U128(w.limit.0.saturating_sub(used)),
        }
    }
}

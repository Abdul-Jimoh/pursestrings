mod admin;
pub mod bounty;
mod events;
mod evm;
mod intents;
pub mod policy;
#[cfg(test)]
mod props;
mod ring;
pub mod sales;
mod spend;
pub mod types;

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    AccountId, BorshStorageKey, PanicOnDefault, PublicKey, assert_one_yocto, env, near, require,
};

use crate::bounty::{Bounty, Record};
use crate::events::Event;
use crate::policy::{MAX_OPS_PER_PROPOSAL, Policy, PolicyOp, WindowLimit, apply};
use crate::ring::Ring;
use crate::sales::Order;
use crate::types::{Asset, Request, UsageKey};

/// The most request ids one `recent_requests` call scans, so a view stays well inside its gas.
const MAX_PAGE: u32 = 100;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Agents,
    Requests,
    Idempotency,
    Usage,
    Proposals,
    EvmNonces,
    EvmOpen,
    IntentsOpen,
    Orders,
    Unpaid,
    Bounties,
    Reputation,
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
    /// The account that created this one; it vouches for migration targets.
    factory: AccountId,
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
    /// The Chain Signatures contract (`v1.signer` on mainnet).
    mpc: AccountId,
    /// Next nonce per EVM chain for this account's derived address. Never decremented.
    evm_nonces: LookupMap<u64, u64>,
    /// EVM requests sent for signing and not yet resolved by the owner.
    evm_open: IterableSet<u64>,
    /// `intents.near` on mainnet.
    intents: AccountId,
    /// This account's MPC-derived key, once `intents.near` has registered it.
    intents_key: Option<PublicKey>,
    /// Swaps sent for signing whose outcome isn't settled yet.
    intents_open: IterableSet<u64>,
    orders: LookupMap<u64, Order>,
    next_order_id: u64,
    open_quotes: u32,
    /// Sale shares whose transfer failed, kept until someone retries them.
    unpaid: LookupMap<(AccountId, Asset), U128>,
    bounties: LookupMap<u64, Bounty>,
    next_bounty_id: u64,
    reputation: LookupMap<AccountId, Record>,
}

pub(crate) fn now_s() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

#[near]
impl Pursestrings {
    /// Builds the initial policy from the same ops `propose` takes, applied immediately to an
    /// empty policy. Every later loosening goes through the timelock.
    #[init]
    pub fn new(owner: AccountId, mpc: AccountId, intents: AccountId, ops: Vec<PolicyOp>) -> Self {
        // The agent key's predecessor is this account, so the owner must be someone else.
        require!(
            owner != env::current_account_id(),
            "owner must be a separate account"
        );
        require!(ops.len() <= MAX_OPS_PER_PROPOSAL * 4, "too many ops");
        require!(
            !ops.iter().any(|op| matches!(op, PolicyOp::Migrate { .. })),
            "no migration at init"
        );
        let mut policy = Policy::empty();
        for op in &ops {
            apply(op.clone(), &mut policy);
        }
        policy.version = 1;
        policy.assert_valid();
        Event::PolicyChanged { version: 1, ops }.emit();
        Self {
            owner,
            factory: env::predecessor_account_id(),
            policy,
            agents: IterableMap::new(StorageKey::Agents),
            requests: LookupMap::new(StorageKey::Requests),
            next_req_id: 0,
            idempotency: LookupMap::new(StorageKey::Idempotency),
            usage: LookupMap::new(StorageKey::Usage),
            last_admitted_at: None,
            proposals: IterableMap::new(StorageKey::Proposals),
            next_proposal_id: 0,
            mpc,
            evm_nonces: LookupMap::new(StorageKey::EvmNonces),
            evm_open: IterableSet::new(StorageKey::EvmOpen),
            intents,
            intents_key: None,
            intents_open: IterableSet::new(StorageKey::IntentsOpen),
            orders: LookupMap::new(StorageKey::Orders),
            next_order_id: 0,
            open_quotes: 0,
            unpaid: LookupMap::new(StorageKey::Unpaid),
            bounties: LookupMap::new(StorageKey::Bounties),
            next_bounty_id: 0,
            reputation: LookupMap::new(StorageKey::Reputation),
        }
    }

    /// Called by `apply_migration` in the same batch that deploys new code. This version's
    /// state layout is the current one, so it reads the state back unchanged.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().expect("no state to migrate")
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn mpc(&self) -> AccountId {
        self.mpc.clone()
    }

    pub fn evm_nonce(&self, chain_id: u64) -> u64 {
        self.evm_nonces.get(&chain_id).copied().unwrap_or(0)
    }

    /// What a relayer broadcasts: signed EVM requests the owner hasn't resolved yet.
    pub fn evm_open(&self) -> Vec<(u64, Request)> {
        self.evm_open
            .iter()
            .filter_map(|id| self.requests.get(id).map(|r| (*id, r.clone())))
            .collect()
    }

    pub fn intents(&self) -> AccountId {
        self.intents.clone()
    }

    pub fn intents_key(&self) -> Option<PublicKey> {
        self.intents_key.clone()
    }

    /// What a relayer submits: signed swaps that haven't been settled yet.
    pub fn intents_open(&self) -> Vec<(u64, Request)> {
        self.intents_open
            .iter()
            .filter_map(|id| self.requests.get(id).map(|r| (*id, r.clone())))
            .collect()
    }

    pub fn factory(&self) -> AccountId {
        self.factory.clone()
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

    pub fn next_req_id(&self) -> u64 {
        self.next_req_id
    }

    /// Request ids in `[before - limit, before)`, newest first, skipping pruned ones. `before`
    /// defaults to `next_req_id`; page back by passing the previous `before - limit`.
    pub fn recent_requests(&self, before: Option<u64>, limit: u32) -> Vec<(u64, Request)> {
        let end = before.unwrap_or(self.next_req_id).min(self.next_req_id);
        let start = end.saturating_sub(u64::from(limit.min(MAX_PAGE)));
        (start..end)
            .rev()
            .filter_map(|id| self.requests.get(&id).map(|r| (id, r.clone())))
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

    pub fn group_status(&self, name: String) -> Option<Vec<WindowStatus>> {
        let group = self.policy.group(&name)?;
        let now = now_s();
        Some(
            group
                .windows
                .iter()
                .map(|w| {
                    self.window_status(
                        UsageKey::Group {
                            name: name.clone(),
                            period_s: w.period_s,
                        },
                        w,
                        now,
                    )
                })
                .collect(),
        )
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

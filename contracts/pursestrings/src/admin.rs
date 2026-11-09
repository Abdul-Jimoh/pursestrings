use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::serde::Serialize;
use near_sdk::{
    Allowance, Gas, NearToken, Promise, PublicKey, assert_one_yocto, env, is_promise_success, near,
    require,
};

use crate::events::Event;
use crate::policy::{Effect, MAX_OPS_PER_PROPOSAL, PolicyOp, apply, classify};
use crate::types::Asset;
use crate::{Agent, Proposal, Pursestrings, PursestringsExt, now_s};

pub const AGENT_METHODS: &str = "request_spend,cancel_request,quote,deliver,refund";
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct CodeHashArgs {
    code_hash: Base58CryptoHash,
}

const FACTORY_CHECK_GAS: Gas = Gas::from_tgas(10);
const MIGRATION_CALLBACK_GAS: Gas = Gas::from_tgas(120);
const MIGRATE_GAS: Gas = Gas::from_tgas(30);

#[near]
impl Pursestrings {
    /// Adds a function-call key that can only call the agent methods (`request_spend`,
    /// `cancel_request`, `quote`, `deliver`, `refund`) on this account, and can burn at most
    /// `allowance` yoctoNEAR of gas.
    #[payable]
    pub fn add_agent(&mut self, public_key: PublicKey, allowance: U128) -> Promise {
        self.assert_owner();
        let limited = Allowance::limited(NearToken::from_yoctonear(allowance.0))
            .expect("allowance must be positive");
        self.agents.insert(
            public_key.clone(),
            Agent {
                added_at: now_s(),
                allowance,
            },
        );
        Event::AgentAdded {
            public_key: public_key.clone(),
            allowance,
        }
        .emit();
        Promise::new(env::current_account_id()).add_access_key_allowance(
            public_key,
            limited,
            env::current_account_id(),
            AGENT_METHODS,
        )
    }

    #[payable]
    pub fn revoke_agent(&mut self, public_key: PublicKey) -> Promise {
        self.assert_owner();
        require!(
            self.agents.remove(&public_key).is_some(),
            "unknown agent key"
        );
        Event::AgentRevoked {
            public_key: public_key.clone(),
        }
        .emit();
        Promise::new(env::current_account_id()).delete_key(public_key)
    }

    /// Moves funds back to the owner, and only to the owner, so a mistaken or phished owner
    /// signature can't send them anywhere else. Works while frozen. EVM funds leave through
    /// spends.
    #[payable]
    pub fn withdraw(&mut self, asset: Asset, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "amount must be positive");
        let owner = self.owner.clone();
        self.transfer(&asset, &owner, amount, "pursestrings:withdraw".to_string())
    }

    /// Instant, and any council member can pull it too. Unfreezing waits for the timelock.
    #[payable]
    pub fn freeze(&mut self) {
        self.assert_owner_or_council();
        self.apply_now(vec![PolicyOp::Freeze]);
    }

    /// Tightening ops apply now, in order. Loosening ops are queued behind the timelock and
    /// apply together, in order, when the owner calls `apply_proposal`. Returns the
    /// proposal id if anything was queued.
    #[payable]
    pub fn propose(&mut self, ops: Vec<PolicyOp>) -> Option<u64> {
        self.assert_owner();
        require!(
            !ops.is_empty() && ops.len() <= MAX_OPS_PER_PROPOSAL,
            "1..=32 ops"
        );
        if ops.iter().any(|op| matches!(op, PolicyOp::Migrate { .. })) {
            require!(ops.len() == 1, "a migration must be proposed on its own");
        }
        let mut tighten = Vec::new();
        let mut loosen = Vec::new();
        for op in ops {
            match classify(&op, &self.policy) {
                Effect::Tighten => {
                    let mut next = self.policy.clone();
                    apply(op.clone(), &mut next);
                    next.assert_valid();
                    self.policy = next;
                    tighten.push(op);
                }
                Effect::Loosen => loosen.push(op),
            }
        }
        if !tighten.is_empty() {
            self.policy.version += 1;
            Event::PolicyChanged {
                version: self.policy.version,
                ops: tighten,
            }
            .emit();
        }
        if loosen.is_empty() {
            return None;
        }
        let mut preview = self.policy.clone();
        for op in &loosen {
            apply(op.clone(), &mut preview);
        }
        preview.assert_valid();

        let id = self.next_proposal_id;
        self.next_proposal_id += 1;
        let now = now_s();
        let eta = now + u64::from(self.policy.timelock_s);
        Event::ProposalQueued {
            id,
            eta,
            ops: loosen.clone(),
        }
        .emit();
        self.proposals.insert(
            id,
            Proposal {
                ops: loosen,
                proposed_at: now,
                eta,
            },
        );
        Some(id)
    }

    #[payable]
    pub fn cancel_proposal(&mut self, id: u64) {
        self.assert_owner();
        require!(self.proposals.remove(&id).is_some(), "unknown proposal");
        Event::ProposalCancelled { id }.emit();
    }

    #[payable]
    pub fn apply_proposal(&mut self, id: u64) {
        self.assert_owner();
        let proposal = self.proposals.get(&id).expect("unknown proposal");
        require!(now_s() >= proposal.eta, "timelocked");
        require!(
            !matches!(proposal.ops[..], [PolicyOp::Migrate { .. }]),
            "use apply_migration"
        );
        let ops = proposal.ops.clone();
        self.proposals.remove(&id);
        self.apply_now(ops);
    }

    /// Applies a queued `Migrate` once its timelock has passed. `code` must hash to the queued
    /// code hash, and the factory must confirm it published that hash before anything deploys.
    /// Anyone can deliver the code: the owner's say is the proposal, and a DAO owner would
    /// otherwise have to store the whole wasm in one of its own proposals. A freeze holds it,
    /// so a council member can stop a queued code change the owner can't cancel in time.
    /// Takes borsh arguments `(u64, Vec<u8>)` because the code is a few hundred KB.
    #[payable]
    pub fn apply_migration(
        &mut self,
        #[serializer(borsh)] id: u64,
        #[serializer(borsh)] code: Vec<u8>,
    ) -> Promise {
        assert_one_yocto();
        require!(!self.policy.frozen, "frozen");
        let proposal = self.proposals.get(&id).expect("unknown proposal");
        require!(now_s() >= proposal.eta, "timelocked");
        let [PolicyOp::Migrate { code_hash }] = proposal.ops[..] else {
            env::panic_str("not a migration proposal")
        };
        require!(
            env::sha256_array(&code) == near_sdk::CryptoHash::from(code_hash),
            "code does not match the proposed hash"
        );
        Promise::new(self.factory.clone())
            .function_call(
                "assert_published",
                near_sdk::serde_json::to_vec(&CodeHashArgs { code_hash }).expect("args"),
                NearToken::from_yoctonear(0),
                FACTORY_CHECK_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(MIGRATION_CALLBACK_GAS)
                    .on_migration_checked(id, code_hash.into(), code),
            )
    }

    /// Borsh arguments, so the code isn't base64-encoded a second time.
    #[private]
    pub fn on_migration_checked(
        &mut self,
        #[serializer(borsh)] id: u64,
        #[serializer(borsh)] code_hash: near_sdk::CryptoHash,
        #[serializer(borsh)] code: Vec<u8>,
    ) -> Promise {
        require!(
            is_promise_success(),
            "factory has not published this code hash"
        );
        require!(
            self.proposals.remove(&id).is_some(),
            "proposal was cancelled"
        );
        Event::Migrating {
            proposal_id: id,
            code_hash: code_hash.into(),
        }
        .emit();
        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call(
                "migrate",
                b"{}".to_vec(),
                NearToken::from_yoctonear(0),
                MIGRATE_GAS,
            )
    }
}

impl Pursestrings {
    fn apply_now(&mut self, ops: Vec<PolicyOp>) {
        let mut next = self.policy.clone();
        for op in &ops {
            apply(op.clone(), &mut next);
        }
        next.assert_valid();
        next.version = self.policy.version + 1;
        self.policy = next;
        Event::PolicyChanged {
            version: self.policy.version,
            ops,
        }
        .emit();
    }
}

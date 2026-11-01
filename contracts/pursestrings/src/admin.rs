use near_sdk::json_types::U128;
use near_sdk::{Allowance, NearToken, Promise, PublicKey, env, near, require};

use crate::events::Event;
use crate::policy::{Effect, MAX_OPS_PER_PROPOSAL, PolicyOp, apply, classify};
use crate::{Agent, Proposal, Pursestrings, PursestringsExt, now_s};

pub const AGENT_METHODS: &str = "request_spend,cancel_request";

#[near]
impl Pursestrings {
    /// Adds a function-call key that can only call `request_spend` and `cancel_request`
    /// on this account, and can burn at most `allowance` yoctoNEAR of gas.
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

    #[payable]
    pub fn freeze(&mut self) {
        self.assert_owner();
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
        let ops = proposal.ops.clone();
        self.proposals.remove(&id);
        self.apply_now(ops);
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

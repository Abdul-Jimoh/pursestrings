use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::serde::Deserialize;
use near_sdk::{
    Allowance, Gas, NearToken, Promise, PublicKey, assert_one_yocto, env, near, require,
};

use crate::events::Event;
use crate::policy::{Effect, MAX_OPS_PER_PROPOSAL, PolicyOp, apply, classify};
use crate::types::Asset;
use crate::{Agent, Proposal, Pursestrings, PursestringsExt, now_s};

pub const AGENT_METHODS: &str = "request_spend,cancel_request,quote,deliver,refund";
/// The part of the factory's `releases` view a migration needs.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Release {
    code_hash: Base58CryptoHash,
}

/// A queued change that nobody applied within this long after it came due needs proposing again,
/// so an old proposal can't be sprung long after everyone stopped watching it.
pub const PROPOSAL_EXPIRES_S: u64 = 7 * 86_400;
/// At most this many changes wait in the queue at once, so a freeze, which cancels them all,
/// always fits in one transaction. Expired ones are cleared whenever something new is queued.
pub const MAX_QUEUED: usize = 32;

/// The factory's `releases` view costs about 0.035 Tgas per release, so this covers roughly 700
/// releases; past that, accounts on this code could no longer migrate.
const FACTORY_CHECK_GAS: Gas = Gas::from_tgas(25);
const MIGRATION_CALLBACK_GAS: Gas = Gas::from_tgas(150);
/// The recount in `migrate` measured about 14 Tgas at its worst in the sandbox; mainnet's deeper
/// trie costs more per read.
const MIGRATE_GAS: Gas = Gas::from_tgas(40);

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
    /// signature can't send them anywhere else. Works while frozen. NEAR held for buyers or
    /// unpaid split shares stays. EVM funds leave through spends.
    #[payable]
    pub fn withdraw(&mut self, asset: Asset, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "amount must be positive");
        require!(
            asset != Asset::Near || amount.0 <= self.spendable_near(),
            "that NEAR is held for buyers or unpaid shares"
        );
        let owner = self.owner.clone();
        self.transfer(&asset, &owner, amount, "pursestrings:withdraw".to_string())
    }

    /// Instant, and any council member can pull it too. Unfreezing waits for the timelock.
    #[payable]
    pub fn freeze(&mut self) {
        self.assert_owner_or_council();
        self.apply_now(vec![PolicyOp::Freeze]);
        self.cancel_queue();
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
        let froze = tighten.iter().any(|op| matches!(op, PolicyOp::Freeze));
        if !tighten.is_empty() {
            self.policy.version += 1;
            Event::PolicyChanged {
                version: self.policy.version,
                ops: tighten,
            }
            .emit();
        }
        if froze {
            self.cancel_queue();
        }
        if loosen.is_empty() {
            return None;
        }
        let mut preview = self.policy.clone();
        for op in &loosen {
            apply(op.clone(), &mut preview);
        }
        preview.assert_valid();

        let now = now_s();
        let expired: Vec<u64> = self
            .proposals
            .iter()
            .filter(|(_, p)| now > p.eta + PROPOSAL_EXPIRES_S)
            .map(|(id, _)| *id)
            .collect();
        if !expired.is_empty() {
            for id in &expired {
                self.proposals.remove(id);
            }
            Event::QueueCancelled { ids: expired }.emit();
        }
        require!(
            (self.proposals.len() as usize) < MAX_QUEUED,
            "too many queued changes: apply or cancel some first"
        );
        let id = self.next_proposal_id;
        self.next_proposal_id += 1;
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
            now_s() <= proposal.eta + PROPOSAL_EXPIRES_S,
            "proposal expired"
        );
        require!(
            !matches!(proposal.ops[..], [PolicyOp::Migrate { .. }]),
            "use apply_migration"
        );
        let ops = proposal.ops.clone();
        self.proposals.remove(&id);
        self.apply_now(ops);
    }

    /// Applies a queued `Migrate` once its timelock has passed and before it expires. `code`
    /// must hash to the queued code hash, and that hash must be the factory's newest release.
    /// Anyone can deliver the code: the owner's say is the proposal, and a DAO owner would
    /// otherwise have to store the whole wasm in one of its own proposals. A freeze cancels it,
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
        require!(
            now_s() <= proposal.eta + PROPOSAL_EXPIRES_S,
            "proposal expired"
        );
        let [PolicyOp::Migrate { code_hash }] = proposal.ops[..] else {
            env::panic_str("not a migration proposal")
        };
        require!(
            env::sha256_array(&code) == near_sdk::CryptoHash::from(code_hash),
            "code does not match the proposed hash"
        );
        // The newest release, not any published one: older builds stay published forever, and
        // moving back to one could undo protections buyers paid under.
        Promise::new(self.factory.clone())
            .function_call(
                "releases",
                b"{}".to_vec(),
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
        // A release is about 110 bytes of JSON; gas, not this bound, is the limit (see above).
        let newest = env::promise_result_checked(0, 64 * 1024)
            .ok()
            .and_then(|bytes| near_sdk::serde_json::from_slice::<Vec<Release>>(&bytes).ok())
            .and_then(|r| r.last().map(|x| near_sdk::CryptoHash::from(x.code_hash)));
        require!(
            newest == Some(code_hash),
            "only the factory's newest release can be migrated to"
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
    /// A freeze cancels everything queued: whoever queued a loosening before it, a thief with
    /// the owner's key included, has to propose again and wait out the timelock once unfrozen.
    fn cancel_queue(&mut self) {
        let ids: Vec<u64> = self.proposals.keys().copied().collect();
        if ids.is_empty() {
            return;
        }
        for id in &ids {
            self.proposals.remove(id);
        }
        Event::QueueCancelled { ids }.emit();
    }

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

#[cfg(test)]
mod tests {
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{NearToken, testing_env};

    use super::*;
    use crate::policy::MAX_TIMELOCK_S;
    use crate::policy::tests::base_policy;
    use crate::spend::tests::{contract, purse};

    fn as_owner(now_s: u64) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(purse())
                .predecessor_account_id("owner.near".parse().unwrap())
                .attached_deposit(NearToken::from_yoctonear(1))
                .block_timestamp(now_s * 1_000_000_000)
                .build()
        );
    }

    fn refused(f: impl FnOnce()) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
    }

    #[test]
    fn a_freeze_cancels_everything_queued() {
        let mut c = contract(base_policy());
        as_owner(1_000);
        let unfreeze = c.propose(vec![PolicyOp::Unfreeze]).expect("queued");
        let more = c
            .propose(vec![PolicyOp::AddChain { chain_id: 1 }])
            .expect("queued");
        c.freeze();
        assert!(c.policy.frozen);
        assert!(c.proposals().is_empty());
        as_owner(1_000 + u64::from(c.policy.timelock_s) + 1);
        assert!(
            refused(|| c.apply_proposal(unfreeze)),
            "queued before the freeze"
        );
        assert!(refused(|| c.apply_proposal(more)));
        assert!(c.policy.frozen, "still frozen");

        // Freezing through `propose` cancels the queue too, but keeps what that call queues.
        let mut c = contract(base_policy());
        as_owner(1_000);
        c.propose(vec![PolicyOp::AddChain { chain_id: 1 }]);
        let after = c
            .propose(vec![PolicyOp::Freeze, PolicyOp::Unfreeze])
            .expect("queued");
        assert_eq!(
            c.proposals().iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![after]
        );
    }

    #[test]
    fn a_proposal_left_a_week_past_due_expires() {
        let mut c = contract(base_policy());
        as_owner(1_000);
        let id = c
            .propose(vec![PolicyOp::AddChain { chain_id: 1 }])
            .expect("queued");
        let eta = 1_000 + u64::from(c.policy.timelock_s);
        as_owner(eta + PROPOSAL_EXPIRES_S + 1);
        assert!(refused(|| c.apply_proposal(id)));
        as_owner(eta + PROPOSAL_EXPIRES_S);
        c.apply_proposal(id);
        assert!(c.policy.chains.contains(&1));
    }

    #[test]
    fn a_full_queue_still_freezes_in_one_transaction() {
        let mut c = contract(base_policy());
        as_owner(1_000);
        for i in 0..MAX_QUEUED as u64 {
            c.propose(vec![PolicyOp::AddChain { chain_id: i + 1 }])
                .expect("queued");
        }
        assert!(refused(|| {
            c.propose(vec![PolicyOp::AddChain { chain_id: 999 }]);
        }));
        c.freeze();
        assert!(c.proposals().is_empty());
        let logs = near_sdk::test_utils::get_logs();
        assert_eq!(
            logs.iter()
                .filter(|l| l.contains("queue_cancelled"))
                .count(),
            1,
            "{logs:?}"
        );
    }

    #[test]
    fn expired_changes_make_room_in_the_queue() {
        let mut c = contract(base_policy());
        as_owner(1_000);
        for i in 0..MAX_QUEUED as u64 {
            c.propose(vec![PolicyOp::AddChain { chain_id: i + 1 }]);
        }
        let eta = 1_000 + u64::from(c.policy.timelock_s);
        as_owner(eta + PROPOSAL_EXPIRES_S + 1);
        let id = c
            .propose(vec![PolicyOp::AddChain { chain_id: 999 }])
            .expect("room again");
        assert_eq!(
            c.proposals().iter().map(|(i, _)| *i).collect::<Vec<_>>(),
            vec![id]
        );
    }

    #[test]
    fn a_migration_left_a_week_past_due_expires() {
        let code = b"new code".to_vec();
        let hash = Base58CryptoHash::from(env::sha256_array(&code));
        let mut c = contract(base_policy());
        as_owner(1_000);
        let id = c
            .propose(vec![PolicyOp::Migrate { code_hash: hash }])
            .expect("queued");
        let eta = 1_000 + u64::from(c.policy.timelock_s);
        as_owner(eta + PROPOSAL_EXPIRES_S + 1);
        assert!(refused(|| {
            let _ = c.apply_migration(id, code.clone());
        }));
        as_owner(eta + PROPOSAL_EXPIRES_S);
        let _ = c.apply_migration(id, code);
    }

    #[test]
    fn the_timelock_is_capped_at_thirty_days() {
        let mut c = contract(base_policy());
        as_owner(1_000);
        assert!(refused(|| {
            c.propose(vec![PolicyOp::SetTimelock {
                seconds: MAX_TIMELOCK_S + 1,
            }]);
        }));
        c.propose(vec![PolicyOp::SetTimelock {
            seconds: MAX_TIMELOCK_S,
        }]);
        assert_eq!(c.policy.timelock_s, MAX_TIMELOCK_S);
    }
}

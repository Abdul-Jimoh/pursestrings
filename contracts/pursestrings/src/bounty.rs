use near_sdk::json_types::U128;
use near_sdk::{AccountId, assert_one_yocto, env, near, require};

use crate::events::Event;
use crate::types::{Asset, DenyReason, Dest, MAX_PURPOSE_BYTES, SpendRequest};
use crate::{Pursestrings, PursestringsExt, now_s};

const MAX_PAGE: u32 = 100;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BountyStatus {
    Open,
    Claimed,
    Submitted,
    /// A payout request is open for it.
    Paying,
    Paid,
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bounty {
    pub title: String,
    pub asset: Asset,
    pub reward: U128,
    pub poster: AccountId,
    pub posted_at: u64,
    pub status: BountyStatus,
    pub claimant: Option<AccountId>,
    /// What the claimant submitted, such as a link to the work.
    pub work: Option<String>,
    pub req_id: Option<u64>,
}

/// A contributor's track record: one point per paid bounty, each listed by id.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Record {
    pub points: u32,
    pub bounties: Vec<u64>,
}

#[near]
impl Pursestrings {
    /// The owner or a council member posts a bounty in an asset that has a trust rule.
    #[payable]
    pub fn post_bounty(&mut self, title: String, asset: Asset, reward: U128) -> u64 {
        self.assert_owner_or_council();
        require!(reward.0 > 0, "reward must be positive");
        require!(
            !title.is_empty() && title.len() <= MAX_PURPOSE_BYTES,
            "title must be 1..=256 bytes"
        );
        require!(
            self.policy.trust_rule(&asset).is_some(),
            "no trust rule for this asset"
        );
        let id = self.next_bounty_id;
        self.next_bounty_id += 1;
        let poster = env::predecessor_account_id();
        self.bounties.insert(
            id,
            Bounty {
                title,
                asset,
                reward,
                poster: poster.clone(),
                posted_at: now_s(),
                status: BountyStatus::Open,
                claimant: None,
                work: None,
                req_id: None,
            },
        );
        self.bounty_event(id, BountyStatus::Open, poster);
        id
    }

    #[payable]
    pub fn claim_bounty(&mut self, id: u64) {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        require!(who != env::current_account_id(), "the account can't claim");
        let b = self.bounties.get_mut(&id).expect("unknown bounty");
        require!(b.status == BountyStatus::Open, "not open");
        b.status = BountyStatus::Claimed;
        b.claimant = Some(who.clone());
        self.bounty_event(id, BountyStatus::Claimed, who);
    }

    #[payable]
    pub fn submit_bounty(&mut self, id: u64, work: String) {
        assert_one_yocto();
        require!(
            !work.is_empty() && work.len() <= MAX_PURPOSE_BYTES,
            "work must be 1..=256 bytes"
        );
        let who = env::predecessor_account_id();
        let b = self.bounties.get_mut(&id).expect("unknown bounty");
        require!(b.claimant.as_ref() == Some(&who), "not your claim");
        require!(
            matches!(b.status, BountyStatus::Claimed | BountyStatus::Submitted),
            "not claimed"
        );
        b.status = BountyStatus::Submitted;
        b.work = Some(work);
        self.bounty_event(id, BountyStatus::Submitted, who);
    }

    /// The claimant gives it up, or the owner or a council member takes it back.
    #[payable]
    pub fn reopen_bounty(&mut self, id: u64) {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        let b = self.bounties.get(&id).expect("unknown bounty");
        require!(
            b.claimant.as_ref() == Some(&who) || self.is_owner_or_council(&who),
            "claimant, owner or council only"
        );
        require!(
            matches!(b.status, BountyStatus::Claimed | BountyStatus::Submitted),
            "not claimed"
        );
        let b = self.bounties.get_mut(&id).expect("unknown bounty");
        b.status = BountyStatus::Open;
        b.claimant = None;
        b.work = None;
        self.bounty_event(id, BountyStatus::Open, who);
    }

    #[payable]
    pub fn close_bounty(&mut self, id: u64) {
        self.assert_owner_or_council();
        let b = self.bounties.get_mut(&id).expect("unknown bounty");
        require!(
            !matches!(b.status, BountyStatus::Paying | BountyStatus::Paid),
            "a payout is open or done"
        );
        b.status = BountyStatus::Closed;
        self.bounty_event(id, BountyStatus::Closed, env::predecessor_account_id());
    }

    pub fn bounty(&self, id: u64) -> Option<Bounty> {
        self.bounties.get(&id).cloned()
    }

    pub fn next_bounty_id(&self) -> u64 {
        self.next_bounty_id
    }

    pub fn recent_bounties(&self, before: Option<u64>, limit: u32) -> Vec<(u64, Bounty)> {
        let end = before
            .unwrap_or(self.next_bounty_id)
            .min(self.next_bounty_id);
        let start = end.saturating_sub(u64::from(limit.min(MAX_PAGE)));
        (start..end)
            .rev()
            .filter_map(|id| self.bounties.get(&id).map(|b| (id, b.clone())))
            .collect()
    }

    pub fn record(&self, account: AccountId) -> Record {
        self.reputation.get(&account).cloned().unwrap_or_default()
    }
}

impl Pursestrings {
    pub(crate) fn is_owner_or_council(&self, who: &AccountId) -> bool {
        *who == self.owner || self.policy.council.contains(who)
    }

    pub(crate) fn assert_owner_or_council(&self) {
        assert_one_yocto();
        require!(
            self.is_owner_or_council(&env::predecessor_account_id()),
            "owner or council only"
        );
    }

    /// For a bounty payout: `(auto_up_to, council_up_to)` from the claimant's earned points.
    pub(crate) fn bounty_limits(
        &self,
        id: u64,
        req: &SpendRequest,
    ) -> Result<(u128, u128), DenyReason> {
        let b = self.bounties.get(&id).ok_or(DenyReason::BountyMismatch)?;
        let to_claimant = matches!(
            (&req.dest, &b.claimant),
            (Dest::Near { account }, Some(c)) if account == c
        );
        if b.status != BountyStatus::Submitted
            || b.asset != req.asset
            || !to_claimant
            || req.amount.0 > b.reward.0
        {
            return Err(DenyReason::BountyMismatch);
        }
        let rule = self
            .policy
            .trust_rule(&req.asset)
            .ok_or(DenyReason::NoTrustRule)?;
        let points = b
            .claimant
            .as_ref()
            .and_then(|c| self.reputation.get(c))
            .map_or(0, |r| r.points);
        Ok(rule.limits(points))
    }

    pub(crate) fn bounty_paying(&mut self, id: u64, req_id: u64) {
        let b = self.bounties.get_mut(&id).expect("checked in evaluate");
        b.status = BountyStatus::Paying;
        b.req_id = Some(req_id);
    }

    /// A paid bounty earns its claimant a point; a failed or refused payout reopens review.
    pub(crate) fn bounty_settled(&mut self, id: u64, paid: bool) {
        let Some(b) = self.bounties.get_mut(&id) else {
            return;
        };
        if b.status != BountyStatus::Paying {
            return;
        }
        let claimant = b.claimant.clone().expect("a paying bounty has a claimant");
        if paid {
            b.status = BountyStatus::Paid;
            let mut rec = self.reputation.get(&claimant).cloned().unwrap_or_default();
            rec.points += 1;
            rec.bounties.push(id);
            let points = rec.points;
            self.reputation.insert(claimant.clone(), rec);
            Event::Earned {
                account: claimant.clone(),
                bounty: id,
                points,
            }
            .emit();
            self.bounty_event(id, BountyStatus::Paid, claimant);
        } else {
            b.status = BountyStatus::Submitted;
            b.req_id = None;
            self.bounty_event(id, BountyStatus::Submitted, claimant);
        }
    }

    fn bounty_event(&self, id: u64, status: BountyStatus, by: AccountId) {
        Event::BountyStatus { id, status, by }.emit();
    }
}

#[cfg(test)]
mod tests {
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{NearToken, testing_env};

    use super::*;
    use crate::policy::tests::{base_policy, usdc};
    use crate::policy::{Tier, TrustRule};
    use crate::spend::tests::{as_agent, contract};
    use crate::types::{Decision, RequestStatus};

    fn alice() -> AccountId {
        "alice.near".parse().unwrap()
    }

    fn council() -> AccountId {
        "council.near".parse().unwrap()
    }

    fn call_as(who: AccountId) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id("purse.near".parse().unwrap())
                .predecessor_account_id(who)
                .attached_deposit(NearToken::from_yoctonear(1))
                .block_timestamp(1_000 * 1_000_000_000)
                .build()
        );
    }

    fn board() -> Pursestrings {
        let mut p = base_policy();
        p.assets[0].cosign_above = None;
        p.council.push(council());
        p.trust.push(TrustRule {
            asset: usdc(),
            tiers: vec![
                Tier {
                    points: 0,
                    auto_up_to: U128(0),
                    council_up_to: U128(20),
                },
                Tier {
                    points: 2,
                    auto_up_to: U128(10),
                    council_up_to: U128(30),
                },
            ],
        });
        contract(p)
    }

    fn submitted(c: &mut Pursestrings, reward: u128) -> u64 {
        call_as(council());
        let id = c.post_bounty("fix the docs".into(), usdc(), U128(reward));
        call_as(alice());
        c.claim_bounty(id);
        c.submit_bounty(id, "https://example.com/pr/1".into());
        id
    }

    fn payout(id: u64, to: AccountId, amount: u128) -> SpendRequest {
        SpendRequest {
            asset: usdc(),
            amount: U128(amount),
            dest: Dest::Near { account: to },
            purpose: "bounty".into(),
            idempotency_key: format!("b{id}-{amount}"),
            bounty: Some(id),
        }
    }

    #[test]
    fn a_newcomer_needs_one_council_member_and_earns_a_point() {
        let mut c = board();
        let id = submitted(&mut c, 15);
        as_agent(1_000);
        let d = c.request_spend(payout(id, alice(), 15));
        assert!(matches!(d, Decision::NeedsCouncil { req_id: 0, .. }));
        assert_eq!(c.bounty(id).unwrap().status, BountyStatus::Paying);
        call_as(council());
        c.council_approve(0);
        c.finish_execution(0, true);
        assert_eq!(c.bounty(id).unwrap().status, BountyStatus::Paid);
        assert_eq!(
            c.record(alice()),
            Record {
                points: 1,
                bounties: vec![id]
            }
        );
    }

    #[test]
    fn a_council_member_cannot_approve_their_own_payout() {
        let mut c = board();
        call_as(council());
        let id = c.post_bounty("fix the docs".into(), usdc(), U128(15));
        c.claim_bounty(id);
        c.submit_bounty(id, "https://example.com/pr/1".into());
        as_agent(1_000);
        assert!(matches!(
            c.request_spend(payout(id, council(), 15)),
            Decision::NeedsCouncil { req_id: 0, .. }
        ));
        call_as(council());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.council_approve(0)));
        assert!(r.is_err(), "the claimant approved their own payout");
        let other: AccountId = "bob.near".parse().unwrap();
        c.policy.council.push(other.clone());
        call_as(other);
        c.council_approve(0);
        c.finish_execution(0, true);
        assert_eq!(c.bounty(id).unwrap().status, BountyStatus::Paid);
    }

    #[test]
    fn earned_points_raise_what_goes_through_alone() {
        let mut c = board();
        c.reputation.insert(
            alice(),
            Record {
                points: 2,
                bounties: vec![],
            },
        );
        let small = submitted(&mut c, 10);
        as_agent(1_000);
        assert_eq!(
            c.request_spend(payout(small, alice(), 10)),
            Decision::Approved { req_id: 0 }
        );
        let large = submitted(&mut c, 40);
        as_agent(1_000);
        assert!(matches!(
            c.request_spend(payout(large, alice(), 40)),
            Decision::NeedsCosign { .. }
        ));
        call_as(council());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.council_approve(1)));
        assert!(
            r.is_err(),
            "above the council tier only the owner can approve"
        );
    }

    #[test]
    fn a_payout_must_match_the_bounty() {
        let mut c = board();
        let id = submitted(&mut c, 15);
        as_agent(1_000);
        let mallory: AccountId = "mallory.near".parse().unwrap();
        for (to, amount) in [(mallory, 15), (alice(), 16)] {
            assert_eq!(
                c.evaluate(
                    &crate::spend::tests::agent_pk(),
                    &payout(id, to, amount),
                    1_000
                ),
                Err(DenyReason::BountyMismatch)
            );
        }
        call_as(council());
        let open = c.post_bounty("open".into(), usdc(), U128(5));
        as_agent(1_000);
        assert_eq!(
            c.request_spend(payout(open, alice(), 5)),
            Decision::Denied {
                reason: DenyReason::BountyMismatch
            },
            "not claimed and submitted"
        );
    }

    #[test]
    fn a_refused_payout_goes_back_to_review() {
        let mut c = board();
        let id = submitted(&mut c, 15);
        as_agent(1_000);
        c.request_spend(payout(id, alice(), 15));
        call_as("owner.near".parse().unwrap());
        c.reject_request(0);
        assert_eq!(c.request(0).unwrap().status, RequestStatus::Rejected);
        assert_eq!(c.bounty(id).unwrap().status, BountyStatus::Submitted);
        assert_eq!(c.record(alice()).points, 0);
    }

    #[test]
    fn council_can_freeze_but_not_post_without_a_trust_rule() {
        let mut c = board();
        call_as(council());
        c.freeze();
        assert!(c.policy.frozen);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.post_bounty("x".into(), Asset::Near, U128(1))
        }));
        assert!(r.is_err());
        call_as(alice());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.freeze()));
        assert!(r.is_err(), "strangers can't freeze");
    }
}

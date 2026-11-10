use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{
    AccountId, Gas, NearToken, Promise, PublicKey, assert_one_yocto, env, is_promise_success, near,
    require,
};

use crate::events::Event;
use crate::evm::max_gas_cost;
use crate::policy::{Policy, WindowLimit, meets_rate};
use crate::types::{
    Asset, Decision, DenyReason, Dest, IntentDest, Request, RequestStatus, Reservation,
    SpendRequest, UsageKey,
};
use crate::{Pursestrings, PursestringsExt, now_s};

const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Finished requests (and their idempotency keys) can be pruned after this long.
pub const RETENTION_S: u64 = 7 * 86_400;

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct FtTransferArgs<'a> {
    receiver_id: &'a AccountId,
    amount: U128,
    memo: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct MtTransferArgs<'a> {
    receiver_id: &'a AccountId,
    token_id: &'a str,
    amount: U128,
    memo: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Route {
    Execute,
    Council,
    Cosign,
    Risk,
}

fn idempotency_key(agent: &PublicKey, key: &str) -> [u8; 32] {
    let mut buf = Vec::with_capacity(agent.as_bytes().len() + 1 + key.len());
    buf.extend_from_slice(agent.as_bytes());
    buf.push(0);
    buf.extend_from_slice(key.as_bytes());
    env::sha256_array(&buf)
}

/// NEAR the contract attaches itself when executing a spend of this asset.
const fn fee_cost(asset: &Asset) -> u128 {
    match asset {
        // The 1 yocto that `ft_transfer`, `mt_transfer` and `ft_withdraw` require, or the MPC
        // `sign` deposit.
        Asset::Nep141 { .. } | Asset::Evm { .. } | Asset::Intents { .. } => 1,
        Asset::Near => 0,
    }
}

/// What a spend draws from each asset's windows. An EVM spend also reserves its worst-case
/// gas fee from the chain's native token, so approved requests can't burn the address's gas.
fn charges(p: &Policy, req: &SpendRequest) -> Result<Vec<(Asset, u128)>, DenyReason> {
    let mut out = vec![(req.asset.clone(), req.amount.0)];
    if let Asset::Evm { chain_id, .. } = req.asset {
        let caps = p.gas_caps(chain_id).ok_or(DenyReason::GasCapsMissing)?;
        let gas = max_gas_cost(caps).ok_or(DenyReason::GasCapsMissing)?;
        let native = Asset::Evm {
            chain_id,
            token: None,
        };
        p.rule(&native).ok_or(DenyReason::NoGasBudget)?;
        if native == req.asset {
            out[0].1 = out[0].1.checked_add(gas).ok_or(DenyReason::NoGasBudget)?;
        } else {
            out.push((native, gas));
        }
    }
    Ok(out)
}

/// Every window a spend draws from: each charged asset's own windows and, for assets in a
/// budget group, the group's shared windows in the group's unit.
fn window_charges(
    p: &Policy,
    req: &SpendRequest,
) -> Result<Vec<(UsageKey, WindowLimit, u128)>, DenyReason> {
    let mut out: Vec<(UsageKey, WindowLimit, u128)> = Vec::new();
    let mut add = |key: UsageKey, w: &WindowLimit, amount: u128| match out
        .iter_mut()
        .find(|(k, ..)| *k == key)
    {
        Some(slot) => slot.2 = slot.2.saturating_add(amount),
        None => out.push((key, w.clone(), amount)),
    };
    for (asset, charge) in charges(p, req)? {
        let rule = p.rule(&asset).expect("checked in charges");
        for w in &rule.windows {
            let key = UsageKey::Spend {
                asset: asset.clone(),
                period_s: w.period_s,
            };
            add(key, w, charge);
        }
        if let Some((group, member)) = p.group_of(&asset) {
            let over = || DenyReason::OverGroupWindow {
                group: group.name.clone(),
                period_s: 0,
                remaining: U128(0),
            };
            let amount = group.normalize(member, charge).ok_or_else(over)?;
            for w in &group.windows {
                let key = UsageKey::Group {
                    name: group.name.clone(),
                    period_s: w.period_s,
                };
                add(key, w, amount);
            }
        }
    }
    Ok(out)
}

/// A bounty payout's recipient is its claimant, checked against the bounty instead of the
/// allowlist.
fn check_dest(p: &Policy, req: &SpendRequest, bounty: bool) -> Result<(), DenyReason> {
    match (&req.asset, &req.dest) {
        (Asset::Near | Asset::Nep141 { .. }, Dest::Near { .. }) => {}
        (Asset::Evm { chain_id: a, .. }, Dest::Evm { chain_id: b, .. }) if a == b => {
            if !p.chains.contains(a) {
                return Err(DenyReason::ChainNotAllowed);
            }
        }
        (Asset::Intents { token }, Dest::Intent(d)) => {
            if !p.intent_kinds.contains(&d.kind()) {
                return Err(DenyReason::IntentKindNotAllowed);
            }
            match d {
                IntentDest::Swap { buy, min_out } => {
                    let floor = p.min_rate(token, buy).ok_or(DenyReason::PairNotAllowed)?;
                    if !meets_rate(req.amount.0, min_out.0, &floor.rate) {
                        return Err(DenyReason::RateBelowFloor);
                    }
                }
                IntentDest::Withdraw { .. } if !token.starts_with("nep141:") => {
                    return Err(DenyReason::AssetDestMismatch);
                }
                _ => {}
            }
        }
        _ => return Err(DenyReason::AssetDestMismatch),
    }
    if !bounty
        && let Some(r) = req.dest.recipient()
        && !p.recipients.contains(&r)
    {
        return Err(DenyReason::RecipientNotAllowed);
    }
    Ok(())
}

#[near]
impl Pursestrings {
    /// The agent's only way to move money. A denial is returned and logged, not panicked,
    /// so the reason stays on-chain.
    pub fn request_spend(&mut self, request: SpendRequest) -> Decision {
        let agent = self.assert_agent();
        request.assert_well_formed();
        let now = now_s();
        let decision = match self.evaluate(&agent, &request, now) {
            Err(reason) => Decision::Denied { reason },
            Ok(route) => self.admit(&agent, &request, route, now),
        };
        Event::SpendRequested {
            agent,
            request,
            decision: decision.clone(),
        }
        .emit();
        decision
    }

    pub fn cancel_request(&mut self, req_id: u64) {
        let agent = self.assert_agent();
        let req = self.requests.get(&req_id).expect("unknown request");
        require!(req.agent == agent, "not your request");
        self.close_pending(req_id, RequestStatus::Cancelled);
    }

    #[payable]
    pub fn approve_request(&mut self, req_id: u64) {
        self.assert_owner();
        self.start_pending(req_id);
    }

    /// One council member is enough for a payout their tier allows; larger ones need the owner.
    #[payable]
    pub fn council_approve(&mut self, req_id: u64) {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        require!(self.policy.council.contains(&who), "council only");
        let req = self.requests.get(&req_id).expect("unknown request");
        require!(
            req.status == RequestStatus::PendingCouncil,
            "needs the owner, not the council"
        );
        require!(
            !matches!(&req.spend.dest, Dest::Near { account } if *account == who),
            "a council member can't approve a payout to themselves"
        );
        if let Some(id) = req.spend.bounty {
            let b = self.bounties.get(&id).expect("unknown bounty");
            require!(
                b.poster != who,
                "a council member can't approve a payout on a bounty they posted"
            );
            let council_up_to = self.trust_limits(b, &req.spend).map_or(0, |(_, c)| c);
            require!(
                req.spend.amount.0 <= council_up_to,
                "the claimant's tier no longer allows a council approval"
            );
        }
        self.start_pending(req_id);
    }

    #[payable]
    pub fn reject_request(&mut self, req_id: u64) {
        self.assert_owner();
        self.close_pending(req_id, RequestStatus::Rejected);
    }

    /// Anyone may expire a stale pending request to free its reservation.
    pub fn expire_request(&mut self, req_id: u64) {
        let req = self.requests.get(&req_id).expect("unknown request");
        require!(req.expires_at.is_some_and(|t| now_s() >= t), "not expired");
        self.close_pending(req_id, RequestStatus::Expired);
    }

    /// Anyone may delete old finished requests to recover storage. Their idempotency keys
    /// become reusable.
    pub fn prune_requests(&mut self, req_ids: Vec<u64>) {
        let now = now_s();
        for req_id in req_ids {
            let Some(req) = self.requests.get(&req_id) else {
                continue;
            };
            if req.status.is_terminal() && now >= req.created_at + RETENTION_S {
                let key = idempotency_key(&req.agent, &req.spend.idempotency_key);
                self.idempotency.remove(&key);
                self.requests.remove(&req_id);
            }
        }
    }

    #[private]
    pub fn on_spend_executed(&mut self, req_id: u64) -> bool {
        let ok = is_promise_success();
        self.finish_execution(req_id, ok);
        ok
    }
}

impl Pursestrings {
    pub(crate) fn finish_execution(&mut self, req_id: u64, ok: bool) {
        let req = self.requests.get_mut(&req_id).expect("unknown request");
        let reservations = std::mem::take(&mut req.reservations);
        req.status = if ok {
            RequestStatus::Done
        } else {
            RequestStatus::Failed
        };
        let status = req.status;
        let bounty = req.spend.bounty;
        let amount = req.spend.amount.0;
        if ok {
            req.reservations = reservations;
        } else {
            self.release(&reservations);
        }
        Event::RequestStatus { req_id, status }.emit();
        if let Some(id) = bounty {
            self.bounty_settled(id, ok.then_some(amount));
        }
    }

    /// Approval runs the request against today's policy, so a recipient or cap removed while
    /// it waited, or NEAR now held for buyers, stops it.
    fn start_pending(&mut self, req_id: u64) {
        require!(!self.policy.frozen, "frozen");
        let req = self.requests.get(&req_id).expect("unknown request");
        require!(req.status.is_pending(), "not pending");
        require!(req.expires_at.is_none_or(|t| now_s() < t), "expired");
        if let Err(reason) = self.still_allowed(&req.spend) {
            env::panic_str(&format!("the policy no longer allows it: {reason:?}"));
        }
        let req = self.requests.get_mut(&req_id).expect("unknown request");
        req.status = RequestStatus::Executing;
        let spend = req.spend.clone();
        Event::RequestStatus {
            req_id,
            status: RequestStatus::Executing,
        }
        .emit();
        self.execute(req_id, &spend).detach();
    }

    fn still_allowed(&self, req: &SpendRequest) -> Result<(), DenyReason> {
        let rule = self
            .policy
            .rule(&req.asset)
            .ok_or(DenyReason::AssetNotAllowed)?;
        if req.amount.0 > rule.per_tx_cap.0 {
            return Err(DenyReason::OverPerTxCap {
                cap: rule.per_tx_cap,
            });
        }
        check_dest(&self.policy, req, req.bounty.is_some())?;
        if req.asset == Asset::Near && req.amount.0 > self.spendable_near() {
            return Err(DenyReason::HeldForOthers {
                spendable: U128(self.spendable_near()),
            });
        }
        Ok(())
    }

    pub(crate) fn evaluate(
        &self,
        agent: &PublicKey,
        req: &SpendRequest,
        now: u64,
    ) -> Result<Route, DenyReason> {
        let p = &self.policy;
        if p.frozen {
            return Err(DenyReason::Frozen);
        }
        if let Some(id) = self
            .idempotency
            .get(&idempotency_key(agent, &req.idempotency_key))
        {
            return Err(DenyReason::DuplicateIdempotencyKey { req_id: *id });
        }
        let rule = p.rule(&req.asset).ok_or(DenyReason::AssetNotAllowed)?;
        let trust = req
            .bounty
            .map(|id| self.bounty_limits(id, req))
            .transpose()?;
        check_dest(p, req, trust.is_some())?;
        let amount = req.amount.0;
        if amount > rule.per_tx_cap.0 {
            return Err(DenyReason::OverPerTxCap {
                cap: rule.per_tx_cap,
            });
        }
        if let Some(last) = self.last_admitted_at {
            let retry_at = last + u64::from(p.cooldown_s);
            if now < retry_at {
                return Err(DenyReason::Cooldown { retry_at });
            }
        }
        if let Some(v) = p.velocity {
            let key = UsageKey::Velocity {
                period_s: v.period_s,
            };
            let used = self.used(&key, v.period_s, now);
            if used >= u128::from(v.max) {
                let need = used + 1 - u128::from(v.max);
                let ring = self.usage.get(&key).cloned().unwrap_or_default();
                return Err(DenyReason::Velocity {
                    retry_after_s: ring.seconds_until_freed(v.period_s, now, need),
                });
            }
        }
        for (key, w, charge) in window_charges(p, req)? {
            let used = self.used(&key, w.period_s, now);
            if used.saturating_add(charge) > w.limit.0 {
                let remaining = U128(w.limit.0.saturating_sub(used));
                let period_s = w.period_s;
                return Err(match key {
                    UsageKey::Group { name, .. } => DenyReason::OverGroupWindow {
                        group: name,
                        period_s,
                        remaining,
                    },
                    _ => DenyReason::OverWindow {
                        period_s,
                        remaining,
                    },
                });
            }
        }
        let fee = fee_cost(&req.asset);
        let fb = &p.fee_budget;
        if fee > 0
            && self.used(
                &UsageKey::Fee {
                    period_s: fb.period_s,
                },
                fb.period_s,
                now,
            ) + fee
                > fb.limit.0
        {
            return Err(DenyReason::FeeBudgetExhausted);
        }
        if matches!(req.dest, Dest::Intent(IntentDest::Swap { .. })) && self.intents_key.is_none() {
            return Err(DenyReason::IntentsKeyMissing);
        }
        if req.asset == Asset::Near {
            let spendable = self.spendable_near();
            if amount > spendable {
                return Err(DenyReason::HeldForOthers {
                    spendable: U128(spendable),
                });
            }
        }
        let above = |t: Option<U128>| t.is_some_and(|t| amount > t.0);
        Ok(if above(rule.risk_check_above) {
            Route::Risk
        } else if above(rule.cosign_above) {
            Route::Cosign
        } else {
            match trust {
                Some((auto, _)) if amount <= auto => Route::Execute,
                Some((_, council)) if amount <= council => Route::Council,
                Some(_) => Route::Cosign,
                None => Route::Execute,
            }
        })
    }

    fn reserve(&mut self, key: UsageKey, period_s: u32, now: u64, amount: u128) -> Reservation {
        let mut ring = self.usage.get(&key).cloned().unwrap_or_default();
        let bucket = ring.add(period_s, now, amount);
        self.usage.insert(key.clone(), ring);
        Reservation {
            key,
            bucket,
            amount: U128(amount),
        }
    }

    /// Velocity counts attempts, so it is never given back.
    pub(crate) fn release(&mut self, reservations: &[Reservation]) {
        for r in reservations {
            if matches!(r.key, UsageKey::Velocity { .. }) {
                continue;
            }
            if let Some(ring) = self.usage.get_mut(&r.key) {
                ring.remove(r.bucket, r.amount.0);
            }
        }
    }

    fn admit(&mut self, agent: &PublicKey, req: &SpendRequest, route: Route, now: u64) -> Decision {
        let req_id = self.next_req_id;
        self.next_req_id += 1;
        let p = self.policy.clone();

        let mut reservations = Vec::new();
        if let Some(v) = p.velocity {
            reservations.push(self.reserve(
                UsageKey::Velocity {
                    period_s: v.period_s,
                },
                v.period_s,
                now,
                1,
            ));
        }
        for (key, w, charge) in window_charges(&p, req).expect("checked in evaluate") {
            reservations.push(self.reserve(key, w.period_s, now, charge));
        }
        let fee = fee_cost(&req.asset);
        if fee > 0 {
            let period_s = p.fee_budget.period_s;
            reservations.push(self.reserve(UsageKey::Fee { period_s }, period_s, now, fee));
        }
        self.last_admitted_at = Some(now);
        self.idempotency
            .insert(idempotency_key(agent, &req.idempotency_key), req_id);

        // There's no screener key to check verdicts against yet, so a risk check goes to the owner.
        let (status, expires_at, decision) = match route {
            Route::Execute => (
                RequestStatus::Executing,
                None,
                Decision::Approved { req_id },
            ),
            Route::Council => {
                let expires_at = now + u64::from(p.pending_ttl_s);
                (
                    RequestStatus::PendingCouncil,
                    Some(expires_at),
                    Decision::NeedsCouncil { req_id, expires_at },
                )
            }
            Route::Cosign | Route::Risk => {
                let expires_at = now + u64::from(p.pending_ttl_s);
                (
                    RequestStatus::PendingCosign,
                    Some(expires_at),
                    Decision::NeedsCosign { req_id, expires_at },
                )
            }
        };
        self.requests.insert(
            req_id,
            Request {
                agent: agent.clone(),
                spend: req.clone(),
                status,
                created_at: now,
                expires_at,
                reservations,
                evm: None,
                intent: None,
            },
        );
        if let Some(id) = req.bounty {
            self.bounty_paying(id, req_id);
        }
        if status == RequestStatus::Executing {
            self.execute(req_id, req).detach();
        }
        decision
    }

    fn close_pending(&mut self, req_id: u64, status: RequestStatus) {
        let req = self.requests.get_mut(&req_id).expect("unknown request");
        require!(req.status.is_pending(), "not pending");
        req.status = status;
        let reservations = std::mem::take(&mut req.reservations);
        let bounty = req.spend.bounty;
        self.release(&reservations);
        Event::RequestStatus { req_id, status }.emit();
        if let Some(id) = bounty {
            self.bounty_settled(id, None);
        }
    }

    fn execute(&mut self, req_id: u64, spend: &SpendRequest) -> Promise {
        let to = match (&spend.asset, &spend.dest) {
            (Asset::Evm { .. }, _) => return self.start_evm(req_id, spend),
            (Asset::Intents { .. }, Dest::Intent(IntentDest::Transfer { receiver })) => receiver,
            (Asset::Intents { .. }, _) => return self.start_intent(req_id, spend),
            (_, Dest::Near { account }) => account,
            _ => env::panic_str("checked in evaluate"),
        };
        self.transfer(
            &spend.asset,
            to,
            spend.amount,
            format!("pursestrings:{req_id}"),
        )
        .then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_spend_executed(req_id),
        )
    }

    /// A NEAR transfer, `ft_transfer`, or `mt_transfer` to an account inside `intents.near`.
    pub(crate) fn transfer(
        &self,
        asset: &Asset,
        to: &AccountId,
        amount: U128,
        memo: String,
    ) -> Promise {
        let (contract, method, args) = match asset {
            Asset::Near => {
                return Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount.0));
            }
            Asset::Nep141 { token } => (
                token,
                "ft_transfer",
                near_sdk::serde_json::to_vec(&FtTransferArgs {
                    receiver_id: to,
                    amount,
                    memo,
                }),
            ),
            Asset::Intents { token } => (
                &self.intents,
                "mt_transfer",
                near_sdk::serde_json::to_vec(&MtTransferArgs {
                    receiver_id: to,
                    token_id: token,
                    amount,
                    memo,
                }),
            ),
            Asset::Evm { .. } => env::panic_str("not a NEAR-side asset"),
        };
        Promise::new(contract.clone()).function_call(
            method,
            args.expect("transfer args"),
            NearToken::from_yoctonear(1),
            FT_TRANSFER_GAS,
        )
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{AccountId, testing_env};

    use super::*;
    use crate::policy::tests::{base_policy, usdc};
    use crate::policy::{AssetRule, MinRate, Rate};
    use crate::types::EvmAddress;

    pub(crate) fn purse() -> AccountId {
        "purse.near".parse().unwrap()
    }

    pub(crate) fn agent_pk() -> PublicKey {
        "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
            .parse()
            .unwrap()
    }

    pub(crate) fn as_agent(now_s: u64) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(purse())
                .predecessor_account_id(purse())
                .signer_account_pk(agent_pk())
                .block_timestamp(now_s * 1_000_000_000)
                .build()
        );
    }

    pub(crate) fn contract(policy: Policy) -> Pursestrings {
        as_agent(1_000);
        let mut c = Pursestrings::new(
            "owner.near".parse().unwrap(),
            "mpc.near".parse().unwrap(),
            "intents.near".parse().unwrap(),
            vec![],
        );
        c.policy = policy;
        c.agents.insert(
            agent_pk(),
            crate::Agent {
                added_at: 0,
                allowance: U128(1),
            },
        );
        c
    }

    fn pay_usdc(amount: u128, key: &str) -> SpendRequest {
        SpendRequest {
            asset: usdc(),
            amount: U128(amount),
            dest: Dest::Near {
                account: "shop.near".parse().unwrap(),
            },
            purpose: String::new(),
            idempotency_key: key.into(),
            bounty: None,
        }
    }

    fn with_shop(mut p: Policy) -> Policy {
        p.recipients.push(crate::types::Recipient::Near {
            account: "shop.near".parse().unwrap(),
        });
        p
    }

    #[test]
    fn a_budget_group_is_shared_across_assets() {
        let mut p = with_shop(base_policy());
        let bridged = Asset::Nep141 {
            token: "usdc-18.test.near".parse().unwrap(),
        };
        let mut rule = p.assets[0].clone();
        rule.asset = bridged.clone();
        rule.cosign_above = None;
        rule.per_tx_cap = U128(10u128.pow(20));
        rule.windows[0].limit = U128(10u128.pow(20));
        p.assets[0].cosign_above = None;
        p.assets.push(rule);
        let member = |asset: Asset, decimals| crate::policy::GroupMember { asset, decimals };
        p.groups.push(crate::policy::BudgetGroup {
            name: "usd".into(),
            decimals: 6,
            members: vec![member(usdc(), 6), member(bridged.clone(), 18)],
            windows: vec![WindowLimit {
                period_s: 86_400,
                limit: U128(80),
            }],
        });
        let mut c = contract(p);
        assert!(matches!(
            c.request_spend(pay_usdc(50, "a")),
            Decision::Approved { .. }
        ));
        let mut other = pay_usdc(31 * 10u128.pow(12), "b");
        other.asset = bridged.clone();
        assert_eq!(
            c.evaluate(&agent_pk(), &other, 1_000),
            Err(DenyReason::OverGroupWindow {
                group: "usd".into(),
                period_s: 86_400,
                remaining: U128(30)
            }),
            "31 units at 18 decimals is 31 at 6"
        );
        other.amount = U128(30 * 10u128.pow(12));
        assert_eq!(c.evaluate(&agent_pk(), &other, 1_000), Ok(Route::Execute));
        let status = c.group_status("usd".into()).unwrap();
        assert_eq!(status[0].used, U128(50));
    }

    #[test]
    fn fee_budget_caps_contract_paid_deposits() {
        let mut p = with_shop(base_policy());
        p.fee_budget.limit = U128(1);
        let mut c = contract(p);
        assert_eq!(
            c.request_spend(pay_usdc(10, "a")),
            Decision::Approved { req_id: 0 }
        );
        assert_eq!(
            c.request_spend(pay_usdc(10, "b")),
            Decision::Denied {
                reason: DenyReason::FeeBudgetExhausted
            }
        );
    }

    #[test]
    fn cooldown_reports_retry_time() {
        let mut p = with_shop(base_policy());
        p.cooldown_s = 60;
        let mut c = contract(p);
        assert!(matches!(
            c.request_spend(pay_usdc(10, "a")),
            Decision::Approved { .. }
        ));
        assert_eq!(
            c.request_spend(pay_usdc(10, "b")),
            Decision::Denied {
                reason: DenyReason::Cooldown { retry_at: 1_060 }
            }
        );
        as_agent(1_060);
        assert!(matches!(
            c.request_spend(pay_usdc(10, "c")),
            Decision::Approved { .. }
        ));
    }

    #[test]
    fn above_cosign_threshold_waits_for_owner() {
        let mut c = contract(with_shop(base_policy()));
        assert_eq!(
            c.request_spend(pay_usdc(41, "a")),
            Decision::NeedsCosign {
                req_id: 0,
                expires_at: 1_000 + 3_600
            }
        );
    }

    #[test]
    fn recent_requests_page_newest_first_past_pruned_ids() {
        let mut c = contract(with_shop(base_policy()));
        for k in ["a", "b", "c"] {
            c.request_spend(pay_usdc(41, k));
        }
        c.requests.remove(&1);
        let ids = |v: Vec<(u64, crate::types::Request)>| {
            v.into_iter().map(|(id, _)| id).collect::<Vec<_>>()
        };
        assert_eq!(c.next_req_id(), 3);
        assert_eq!(ids(c.recent_requests(None, 10)), [2, 0]);
        assert_eq!(ids(c.recent_requests(None, 2)), [2]);
        assert_eq!(ids(c.recent_requests(Some(1), 10)), [0]);
        assert_eq!(c.recent_requests(None, u32::MAX).len(), 2);
    }

    fn swap(amount: u128, min_out: u128) -> SpendRequest {
        SpendRequest {
            asset: Asset::Intents {
                token: "nep141:wrap.near".into(),
            },
            amount: U128(amount),
            dest: Dest::Intent(IntentDest::Swap {
                buy: "nep141:usdc.near".into(),
                min_out: U128(min_out),
            }),
            purpose: String::new(),
            idempotency_key: "swap".into(),
            bounty: None,
        }
    }

    #[test]
    fn swap_needs_a_floor_and_must_meet_it() {
        let mut p = base_policy();
        p.assets.push(AssetRule {
            asset: Asset::Intents {
                token: "nep141:wrap.near".into(),
            },
            per_tx_cap: U128(1_000),
            windows: vec![],
            cosign_above: None,
            risk_check_above: None,
        });
        let c = contract(p.clone());
        assert_eq!(
            c.evaluate(&agent_pk(), &swap(100, 300), 1_000),
            Err(DenyReason::IntentKindNotAllowed)
        );

        p.intent_kinds.push(crate::types::IntentKind::Swap);
        let c = contract(p.clone());
        assert_eq!(
            c.evaluate(&agent_pk(), &swap(100, 300), 1_000),
            Err(DenyReason::PairNotAllowed)
        );

        p.min_rates.push(MinRate {
            sell: "nep141:wrap.near".into(),
            buy: "nep141:usdc.near".into(),
            rate: Rate {
                num: U128(3),
                den: U128(1),
            },
        });
        let mut c = contract(p);
        assert_eq!(
            c.evaluate(&agent_pk(), &swap(100, 299), 1_000),
            Err(DenyReason::RateBelowFloor)
        );
        assert_eq!(
            c.evaluate(&agent_pk(), &swap(100, 300), 1_000),
            Err(DenyReason::IntentsKeyMissing)
        );
        c.intents_key = Some(agent_pk());
        assert_eq!(
            c.evaluate(&agent_pk(), &swap(100, 300), 1_000),
            Ok(Route::Execute)
        );
    }

    #[test]
    fn withdraw_allowlist_covers_the_memo() {
        let mut p = base_policy();
        let token = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
        p.assets.push(AssetRule {
            asset: Asset::Intents {
                token: token.into(),
            },
            per_tx_cap: U128(1_000),
            windows: vec![],
            cosign_above: None,
            risk_check_above: None,
        });
        p.intent_kinds.push(crate::types::IntentKind::Withdraw);
        let bridge: AccountId = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
            .parse()
            .unwrap();
        let ours = Some("WITHDRAW_TO:0x4e60a71d1593928c076ddb205d2ba4068bfd8be8".to_string());
        p.recipients.push(crate::types::Recipient::Withdraw {
            receiver: bridge.clone(),
            memo: ours.clone(),
        });
        let c = contract(p);
        let withdraw = |memo: Option<String>| SpendRequest {
            asset: Asset::Intents {
                token: token.into(),
            },
            amount: U128(10),
            dest: Dest::Intent(IntentDest::Withdraw {
                receiver: bridge.clone(),
                memo,
            }),
            purpose: String::new(),
            idempotency_key: "w".into(),
            bounty: None,
        };
        assert_eq!(
            c.evaluate(&agent_pk(), &withdraw(ours), 1_000),
            Ok(Route::Execute)
        );
        assert_eq!(
            c.evaluate(
                &agent_pk(),
                &withdraw(Some("WITHDRAW_TO:0xattacker".into())),
                1_000
            ),
            Err(DenyReason::RecipientNotAllowed)
        );
        assert_eq!(
            c.evaluate(&agent_pk(), &withdraw(None), 1_000),
            Err(DenyReason::RecipientNotAllowed)
        );
    }

    #[test]
    fn evm_dest_must_match_an_allowed_chain() {
        let mut p = base_policy();
        let asset = Asset::Evm {
            chain_id: 1,
            token: None,
        };
        p.assets.push(AssetRule {
            asset: asset.clone(),
            per_tx_cap: U128(1_000),
            windows: vec![],
            cosign_above: None,
            risk_check_above: None,
        });
        let to = EvmAddress([7; 20]);
        let req = |chain_id| SpendRequest {
            asset: asset.clone(),
            amount: U128(1),
            dest: Dest::Evm { chain_id, to },
            purpose: String::new(),
            idempotency_key: "e".into(),
            bounty: None,
        };
        let c = contract(p.clone());
        assert_eq!(
            c.evaluate(&agent_pk(), &req(84532), 1_000),
            Err(DenyReason::AssetDestMismatch)
        );
        assert_eq!(
            c.evaluate(&agent_pk(), &req(1), 1_000),
            Err(DenyReason::ChainNotAllowed)
        );
        p.chains.push(1);
        p.recipients.push(crate::types::Recipient::Evm {
            chain_id: 1,
            address: to,
        });
        let c = contract(p.clone());
        assert_eq!(
            c.evaluate(&agent_pk(), &req(1), 1_000),
            Err(DenyReason::GasCapsMissing)
        );
        p.evm_gas.push(crate::policy::ChainGas {
            chain_id: 1,
            caps: crate::policy::GasCaps {
                max_gas_limit: 21_000,
                max_fee_per_gas: U128(10),
                max_priority_fee_per_gas: U128(1),
            },
        });
        let c = contract(p.clone());
        assert_eq!(c.evaluate(&agent_pk(), &req(1), 1_000), Ok(Route::Execute));
    }

    #[test]
    fn evm_token_spend_needs_a_native_gas_budget() {
        let mut p = base_policy();
        let token = Asset::Evm {
            chain_id: 1,
            token: Some(EvmAddress([9; 20])),
        };
        let to = EvmAddress([7; 20]);
        p.chains.push(1);
        p.recipients.push(crate::types::Recipient::Evm {
            chain_id: 1,
            address: to,
        });
        p.evm_gas.push(crate::policy::ChainGas {
            chain_id: 1,
            caps: crate::policy::GasCaps {
                max_gas_limit: 100_000,
                max_fee_per_gas: U128(10),
                max_priority_fee_per_gas: U128(1),
            },
        });
        p.assets.push(AssetRule {
            asset: token.clone(),
            per_tx_cap: U128(1_000),
            windows: vec![],
            cosign_above: None,
            risk_check_above: None,
        });
        let req = SpendRequest {
            asset: token,
            amount: U128(5),
            dest: Dest::Evm { chain_id: 1, to },
            purpose: String::new(),
            idempotency_key: "t".into(),
            bounty: None,
        };
        let c = contract(p.clone());
        assert_eq!(
            c.evaluate(&agent_pk(), &req, 1_000),
            Err(DenyReason::NoGasBudget)
        );

        p.assets.push(AssetRule {
            asset: Asset::Evm {
                chain_id: 1,
                token: None,
            },
            per_tx_cap: U128(0),
            windows: vec![crate::policy::WindowLimit {
                period_s: 86_400,
                limit: U128(999_999),
            }],
            cosign_above: None,
            risk_check_above: None,
        });
        let c = contract(p);
        assert_eq!(
            c.evaluate(&agent_pk(), &req, 1_000),
            Err(DenyReason::OverWindow {
                period_s: 86_400,
                remaining: U128(999_999)
            }),
            "100k gas at 10 wei per gas doesn't fit in the native window"
        );
    }

    #[test]
    fn unknown_asset_and_mismatched_dest_are_denied() {
        let c = contract(with_shop(base_policy()));
        let mut req = pay_usdc(1, "x");
        req.asset = Asset::Near;
        assert_eq!(
            c.evaluate(&agent_pk(), &req, 1_000),
            Err(DenyReason::AssetNotAllowed)
        );
        let mut req = pay_usdc(1, "y");
        req.dest = Dest::Intent(IntentDest::Transfer {
            receiver: "shop.near".parse().unwrap(),
        });
        assert_eq!(
            c.evaluate(&agent_pk(), &req, 1_000),
            Err(DenyReason::AssetDestMismatch)
        );
    }

    #[test]
    #[should_panic(expected = "agents call through their access key")]
    fn only_the_account_itself_can_request() {
        let mut c = contract(with_shop(base_policy()));
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(purse())
                .predecessor_account_id("owner.near".parse().unwrap())
                .signer_account_pk(agent_pk())
                .build()
        );
        c.request_spend(pay_usdc(1, "z"));
    }
}

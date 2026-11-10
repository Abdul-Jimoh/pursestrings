//! Property tests: random policies and random request histories against a plain model of the
//! rules. `PROPTEST_CASES` sets the number of cases (10,000 by default).

use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{AccountId, NearToken, testing_env};
use proptest::prelude::*;

use crate::policy::tests::{base_policy, usdc};
use crate::policy::{BPS, Policy, PriceFloor, RefundLimit, Share, Velocity, WindowLimit};
use crate::ring::BUCKETS;
use crate::sales::{OrderStatus, QuoteDecision, share_of, split};
use crate::spend::tests::{agent_pk, contract, purse};
use crate::types::{Asset, Decision, Dest, Recipient, RequestStatus, SpendRequest};

const FLOOR: u128 = 2_000_000;

fn cases() -> u32 {
    std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10_000)
}

const PAYEES: [&str; 3] = ["shop.near", "vendor.near", "stranger.near"];

fn payee(i: usize) -> AccountId {
    PAYEES[i].parse().unwrap()
}

fn context(who: &str, now_s: u64) -> near_sdk::VMContext {
    VMContextBuilder::new()
        .current_account_id(purse())
        .predecessor_account_id(who.parse().unwrap())
        .signer_account_pk(agent_pk())
        .attached_deposit(NearToken::from_yoctonear(u128::from(who == "owner.near")))
        .block_timestamp(now_s * 1_000_000_000)
        .build()
}

#[derive(Debug, Clone)]
enum Step {
    Spend { amount: u128, to: usize },
    Approve(usize),
    Reject(usize),
    Fail(usize),
}

fn step() -> impl Strategy<Value = (u64, Step)> {
    let s = prop_oneof![
        6 => (prop_oneof![1u128..20, 1u128..1_500], 0usize..3)
            .prop_map(|(amount, to)| Step::Spend { amount, to }),
        1 => any::<usize>().prop_map(Step::Approve),
        1 => any::<usize>().prop_map(Step::Reject),
        1 => any::<usize>().prop_map(Step::Fail),
    ];
    // Short gaps land near the cooldown (up to 120 s) often enough to hit its edge every run.
    (prop_oneof![2 => 0u64..130, 1 => 0u64..400], s)
}

fn policy() -> impl Strategy<Value = Policy> {
    (
        1u128..1_000,
        1u128..3_000,
        prop_oneof![Just(2_400u32), Just(86_400u32)],
        proptest::option::of(0u128..1_000),
        proptest::option::of(1u32..20),
        prop_oneof![3 => Just(0u32), 1 => 1u32..120],
        proptest::bits::u8::between(0, 2),
        proptest::bool::weighted(0.05),
    )
        .prop_map(
            |(cap, limit, period_s, cosign, velocity, cooldown, allowed, frozen)| {
                let mut p = base_policy();
                let rule = &mut p.assets[0];
                rule.per_tx_cap = U128(cap);
                rule.windows = vec![WindowLimit {
                    period_s,
                    limit: U128(limit),
                }];
                rule.cosign_above = cosign.map(U128);
                p.velocity = velocity.map(|max| Velocity {
                    max,
                    period_s: 3_600,
                });
                p.cooldown_s = cooldown;
                p.frozen = frozen;
                p.recipients = (0..2)
                    .filter(|i| allowed & (1 << i) != 0)
                    .map(|i| Recipient::Near { account: payee(i) })
                    .collect();
                p
            },
        )
}

/// What the model remembers about an admitted request.
struct Admitted {
    id: u64,
    at: u64,
    amount: u128,
    holds_budget: bool,
}

/// Every span the ring is sure to cover: the current bucket and the 23 before it.
fn covered(period_s: u32, at: u64, now: u64) -> bool {
    at + (u64::from(period_s) / BUCKETS) * (BUCKETS - 1) >= now
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(), ..ProptestConfig::default() })]

    /// No request the contract lets through breaks a rule of the policy it was checked against.
    #[test]
    fn no_admitted_spend_breaks_a_rule(p in policy(), steps in prop::collection::vec(step(), 1..40)) {
        // The mocked chain keeps its storage between cases unless it's cleared.
        near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
        let mut c = contract(p.clone());
        // Building the mocked chain's config is most of a step's cost, so it's built once.
        let (vm, fees) = (near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test());
        let at = |who: &str, now: u64| testing_env!(context(who, now), vm.clone(), fees.clone());
        let rule = p.assets[0].clone();
        let window = rule.windows[0].clone();
        let mut now = 1_000u64;
        let mut admitted: Vec<Admitted> = Vec::new();
        let mut last: Option<u64> = None;
        for (n, (dt, s)) in steps.into_iter().enumerate() {
            now += dt;
            let pick = |i: usize, want: &[RequestStatus], c: &crate::Pursestrings| {
                let open: Vec<u64> = admitted
                    .iter()
                    .filter(|a| c.requests.get(&a.id).is_some_and(|r| want.contains(&r.status)))
                    .map(|a| a.id)
                    .collect();
                (!open.is_empty()).then(|| open[i % open.len()])
            };
            match s {
                Step::Spend { amount, to } => {
                    at("purse.near", now);
                    let req = SpendRequest {
                        asset: usdc(),
                        amount: U128(amount),
                        dest: Dest::Near { account: payee(to) },
                        purpose: String::new(),
                        idempotency_key: format!("k{n}"),
                        bounty: None,
                    };
                    let id = match c.request_spend(req) {
                        Decision::Approved { req_id } => {
                            prop_assert!(rule.cosign_above.is_none_or(|t| amount <= t.0));
                            req_id
                        }
                        Decision::NeedsCosign { req_id, .. } => {
                            prop_assert!(rule.cosign_above.is_some_and(|t| amount > t.0));
                            req_id
                        }
                        Decision::Denied { .. } => continue,
                        other => {
                            prop_assert!(false, "unexpected {other:?}");
                            unreachable!()
                        }
                    };
                    let allowed = Recipient::Near { account: payee(to) };
                    prop_assert!(!p.frozen, "admitted while frozen");
                    prop_assert!(p.recipients.contains(&allowed), "paid {} off the allowlist", PAYEES[to]);
                    prop_assert!(amount <= rule.per_tx_cap.0, "over the per-payment cap");
                    prop_assert!(last.is_none_or(|t| now >= t + u64::from(p.cooldown_s)), "inside the cooldown");
                    let held: u128 = admitted
                        .iter()
                        .filter(|a| a.holds_budget && covered(window.period_s, a.at, now))
                        .map(|a| a.amount)
                        .sum();
                    prop_assert!(held + amount <= window.limit.0, "{held} + {amount} over {}", window.limit.0);
                    if let Some(v) = p.velocity {
                        let recent = admitted.iter().filter(|a| covered(v.period_s, a.at, now)).count();
                        prop_assert!(recent < v.max as usize, "over the velocity limit");
                    }
                    last = Some(now);
                    admitted.push(Admitted { id, at: now, amount, holds_budget: true });
                }
                Step::Approve(i) => {
                    let Some(id) = pick(i, &[RequestStatus::PendingCosign], &c) else { continue };
                    if c.requests.get(&id).unwrap().expires_at.is_some_and(|t| now >= t) {
                        continue;
                    }
                    at("owner.near", now);
                    c.approve_request(id);
                    prop_assert_eq!(c.requests.get(&id).unwrap().status, RequestStatus::Executing);
                }
                Step::Reject(i) => {
                    let Some(id) = pick(i, &[RequestStatus::PendingCosign], &c) else { continue };
                    at("owner.near", now);
                    c.reject_request(id);
                    admitted.iter_mut().find(|a| a.id == id).unwrap().holds_budget = false;
                }
                Step::Fail(i) => {
                    let Some(id) = pick(i, &[RequestStatus::Executing], &c) else { continue };
                    at("purse.near", now);
                    c.finish_execution(id, false);
                    admitted.iter_mut().find(|a| a.id == id).unwrap().holds_budget = false;
                }
            }
        }
    }

    /// A sale's split never pays out more than the price, and rounds each share down exactly.
    #[test]
    fn a_split_always_adds_up(
        price in prop_oneof![any::<u128>(), 0u128..1_000_000],
        bps in prop::collection::vec(1u16..=BPS, 0..=4),
    ) {
        let mut p = base_policy();
        let mut left = u32::from(BPS);
        p.split = bps
            .iter()
            .enumerate()
            .filter_map(|(i, &b)| {
                let b = u32::from(b).min(left);
                left -= b;
                (b > 0).then(|| Share {
                    account: format!("s{i}.near").parse().unwrap(),
                    bps: b as u16,
                })
            })
            .collect();
        p.assert_valid();
        let (shares, kept) = split(&p, price);
        let paid: u128 = shares.iter().map(|(_, a)| a).sum();
        prop_assert_eq!(paid + kept, price);
        let total: u128 = p.split.iter().map(|s| u128::from(s.bps)).sum();
        for (s, (_, amount)) in p.split.iter().zip(&shares) {
            prop_assert_eq!(*amount, share_of(price, s.bps));
            if let Some(exact) = price.checked_mul(u128::from(s.bps)) {
                prop_assert_eq!(*amount, exact / u128::from(BPS));
            }
        }
        if let Some(exact) = price.checked_mul(u128::from(BPS) - total) {
            let floor = exact / u128::from(BPS);
            prop_assert!(kept >= floor && kept - floor <= shares.len() as u128, "rounding dust only");
        }
    }

    /// However the agent is talked into quoting, refunding and delivering, a delivered order
    /// was quoted at or above the floor and keeps at least the split's shares of that price,
    /// and the NEAR kept out of reach is exactly what undelivered orders hold.
    #[test]
    fn a_delivered_order_never_costs_less_than_the_floor_allows(
        steps in prop::collection::vec(sale_step(), 1..40),
        refund_limit in 1u128..20_000_000,
    ) {
        near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
        let mut p = base_policy();
        p.floors.push(PriceFloor { asset: Asset::Near, min: U128(FLOOR) });
        p.split = vec![
            Share { account: "owner.near".parse().unwrap(), bps: 7_000 },
            Share { account: "dao.near".parse().unwrap(), bps: 2_000 },
        ];
        p.refund_limits.push(RefundLimit {
            asset: Asset::Near,
            window: WindowLimit { period_s: 86_400, limit: U128(refund_limit) },
        });
        let mut c = contract(p.clone());
        let (vm, fees) = (near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test());
        let at = |who: &str, now: u64| testing_env!(context(who, now), vm.clone(), fees.clone());
        let mut orders: Vec<u64> = Vec::new();
        let now = 1_000;
        for s in steps {
            let pick = |i: usize| (!orders.is_empty()).then(|| orders[i % orders.len()]);
            match s {
                Sale::Quote(price) => {
                    at("purse.near", now);
                    let q = c.quote(Some("buyer.near".parse().unwrap()), Asset::Near, U128(price), "check".into());
                    if let QuoteDecision::Quoted { order_id, .. } = q {
                        prop_assert!(price >= FLOOR, "quoted {price} under the floor");
                        orders.push(order_id);
                    }
                }
                Sale::Pay(i, exact, amount) => {
                    let Some(id) = pick(i) else { continue };
                    let price = c.order(id).map_or(amount, |o| o.price.0);
                    let amount = if exact { price } else { amount };
                    let ctx = VMContextBuilder::new()
                        .current_account_id(purse())
                        .predecessor_account_id("buyer.near".parse().unwrap())
                        .attached_deposit(NearToken::from_yoctonear(amount))
                        .block_timestamp(now * 1_000_000_000)
                        .build();
                    testing_env!(ctx, vm.clone(), fees.clone());
                    let buyer: AccountId = "buyer.near".parse().unwrap();
                    if c.check_payment(id, &Asset::Near, &buyer, amount).is_ok() {
                        c.pay(id);
                    }
                }
                Sale::Refund(i, whole, amount) => {
                    let Some(id) = pick(i) else { continue };
                    let amount = match c.order(id) {
                        Some(o) if whole && o.held.0 > 0 => o.held.0,
                        _ => amount,
                    };
                    at("purse.near", now);
                    let _ = c.refund(id, U128(amount), "the buyer asked".into());
                }
                Sale::Deliver(i) => {
                    let Some(id) = pick(i) else { continue };
                    if c.order(id).is_none_or(|o| o.status != OrderStatus::Paid) {
                        continue;
                    }
                    at("purse.near", now);
                    let price = c.order(id).unwrap().price.0;
                    prop_assert_eq!(c.order(id).unwrap().held.0, price, "delivering less than was paid");
                    c.deliver(id, "sha256:x".into());
                }
            }
            let held: u128 = orders
                .iter()
                .filter_map(|id| c.order(*id))
                .filter(|o| o.status == OrderStatus::Paid)
                .map(|o| o.held.0)
                .sum();
            prop_assert_eq!(c.owed_near().0, held, "NEAR out of reach != held for undelivered orders");
        }
        for id in orders {
            let Some(o) = c.order(id) else { continue };
            if o.status != OrderStatus::Delivered {
                continue;
            }
            let (shares, _) = split(&p, o.price.0);
            let paid_on: u128 = shares.iter().map(|(_, a)| a).sum();
            prop_assert!(o.price.0 >= FLOOR);
            prop_assert!(
                o.price.0 - o.refunded.0 >= paid_on,
                "order {id}: {} paid, {} refunded, {paid_on} went to the split",
                o.price.0,
                o.refunded.0
            );
        }
    }
}

#[derive(Debug, Clone)]
enum Sale {
    Quote(u128),
    Pay(usize, bool, u128),
    Refund(usize, bool, u128),
    Deliver(usize),
}

fn sale_step() -> impl Strategy<Value = Sale> {
    prop_oneof![
        2 => prop_oneof![1u128..FLOOR, FLOOR..3 * FLOOR].prop_map(Sale::Quote),
        2 => (any::<usize>(), proptest::bool::weighted(0.8), 1u128..3 * FLOOR)
            .prop_map(|(i, exact, a)| Sale::Pay(i, exact, a)),
        2 => (
            any::<usize>(),
            any::<bool>(),
            prop_oneof![1u128..1_000_000, 1u128..3 * FLOOR],
        )
            .prop_map(|(i, whole, a)| Sale::Refund(i, whole, a)),
        1 => any::<usize>().prop_map(Sale::Deliver),
    ]
}

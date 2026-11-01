use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::{near, require};

use crate::ring::BUCKETS;
use crate::types::{Asset, IntentKind, Recipient};

pub const MAX_ASSETS: usize = 16;
pub const MAX_WINDOWS_PER_ASSET: usize = 4;
pub const MAX_RECIPIENTS: usize = 64;
pub const MAX_CHAINS: usize = 16;
pub const MAX_MIN_RATES: usize = 16;
pub const MAX_OPS_PER_PROPOSAL: usize = 32;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowLimit {
    pub period_s: u32,
    pub limit: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetRule {
    pub asset: Asset,
    pub per_tx_cap: U128,
    pub windows: Vec<WindowLimit>,
    /// `None` means no co-sign is required at any amount.
    pub cosign_above: Option<U128>,
    pub risk_check_above: Option<U128>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Velocity {
    pub max: u32,
    pub period_s: u32,
}

/// At least `num` units of the bought token for every `den` units sold.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rate {
    pub num: U128,
    pub den: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MinRate {
    pub sell: String,
    pub buy: String,
    pub rate: Rate,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GasCaps {
    pub max_gas_limit: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainGas {
    pub chain_id: u64,
    pub caps: GasCaps,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub version: u32,
    pub frozen: bool,
    /// An asset with no rule cannot be spent at all.
    pub assets: Vec<AssetRule>,
    pub recipients: Vec<Recipient>,
    pub chains: Vec<u64>,
    pub intent_kinds: Vec<IntentKind>,
    pub cooldown_s: u32,
    pub velocity: Option<Velocity>,
    /// A swap pair with no floor cannot be swapped.
    pub min_rates: Vec<MinRate>,
    pub evm_gas: Vec<ChainGas>,
    /// NEAR the contract itself attaches to outgoing calls (deposits, MPC fees).
    pub fee_budget: WindowLimit,
    pub pending_ttl_s: u32,
    pub timelock_s: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyOp {
    SetAssetRule(AssetRule),
    RemoveAsset {
        asset: Asset,
    },
    AddRecipient(Recipient),
    RemoveRecipient(Recipient),
    AddChain {
        chain_id: u64,
    },
    RemoveChain {
        chain_id: u64,
    },
    AddIntentKind {
        kind: IntentKind,
    },
    RemoveIntentKind {
        kind: IntentKind,
    },
    SetCooldown {
        seconds: u32,
    },
    SetVelocity {
        velocity: Option<Velocity>,
    },
    SetMinRate(MinRate),
    RemoveMinRate {
        sell: String,
        buy: String,
    },
    SetEvmGas(ChainGas),
    RemoveEvmGas {
        chain_id: u64,
    },
    SetFeeBudget(WindowLimit),
    SetPendingTtl {
        seconds: u32,
    },
    SetTimelock {
        seconds: u32,
    },
    Freeze,
    Unfreeze,
    /// Switch this account to another code hash the factory has published. Always a
    /// loosening; proposed on its own and applied through `apply_migration`.
    Migrate {
        code_hash: Base58CryptoHash,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    Tighten,
    Loosen,
}

/// `None` is an infinite threshold.
fn threshold_tighter(new: Option<U128>, cur: Option<U128>) -> bool {
    match (new, cur) {
        (_, None) => true,
        (None, Some(_)) => false,
        (Some(n), Some(c)) => n.0 <= c.0,
    }
}

fn rule_tighter(new: &AssetRule, cur: &AssetRule) -> bool {
    new.per_tx_cap.0 <= cur.per_tx_cap.0
        && cur.windows.iter().all(|cw| {
            new.windows
                .iter()
                .any(|nw| nw.period_s == cw.period_s && nw.limit.0 <= cw.limit.0)
        })
        && threshold_tighter(new.cosign_above, cur.cosign_above)
        && threshold_tighter(new.risk_check_above, cur.risk_check_above)
}

fn window_tighter(new: &WindowLimit, cur: &WindowLimit) -> bool {
    new.limit.0 <= cur.limit.0 && new.period_s >= cur.period_s
}

const fn caps_tighter(new: &GasCaps, cur: &GasCaps) -> bool {
    new.max_gas_limit <= cur.max_gas_limit
        && new.max_fee_per_gas.0 <= cur.max_fee_per_gas.0
        && new.max_priority_fee_per_gas.0 <= cur.max_priority_fee_per_gas.0
}

/// Anything not provably at least as strict as the current policy is a loosening.
pub fn classify(op: &PolicyOp, p: &Policy) -> Effect {
    let tight = match op {
        PolicyOp::SetAssetRule(new) => p.rule(&new.asset).is_some_and(|cur| rule_tighter(new, cur)),
        PolicyOp::SetCooldown { seconds } => *seconds >= p.cooldown_s,
        PolicyOp::SetVelocity { velocity } => match (velocity, p.velocity) {
            (_, None) => true,
            (None, Some(_)) => false,
            (Some(n), Some(c)) => n.max <= c.max && n.period_s >= c.period_s,
        },
        PolicyOp::SetMinRate(new) => p
            .min_rate(&new.sell, &new.buy)
            .is_some_and(|cur| rate_ge(&new.rate, &cur.rate)),
        PolicyOp::SetEvmGas(new) => p
            .gas_caps(new.chain_id)
            .is_some_and(|cur| caps_tighter(&new.caps, cur)),
        PolicyOp::SetFeeBudget(new) => window_tighter(new, &p.fee_budget),
        PolicyOp::SetPendingTtl { seconds } => *seconds <= p.pending_ttl_s,
        PolicyOp::SetTimelock { seconds } => *seconds >= p.timelock_s,
        PolicyOp::RemoveAsset { .. }
        | PolicyOp::RemoveRecipient(_)
        | PolicyOp::RemoveChain { .. }
        | PolicyOp::RemoveIntentKind { .. }
        | PolicyOp::RemoveMinRate { .. }
        | PolicyOp::RemoveEvmGas { .. }
        | PolicyOp::Freeze => true,
        PolicyOp::AddRecipient(_)
        | PolicyOp::AddChain { .. }
        | PolicyOp::AddIntentKind { .. }
        | PolicyOp::Unfreeze
        | PolicyOp::Migrate { .. } => false,
    };
    if tight {
        Effect::Tighten
    } else {
        Effect::Loosen
    }
}

fn upsert<T>(v: &mut Vec<T>, item: T, same: impl Fn(&T) -> bool) {
    match v.iter_mut().find(|x| same(x)) {
        Some(slot) => *slot = item,
        None => v.push(item),
    }
}

fn add_unique<T: PartialEq>(v: &mut Vec<T>, item: T) {
    if !v.contains(&item) {
        v.push(item);
    }
}

pub fn apply(op: PolicyOp, p: &mut Policy) {
    match op {
        PolicyOp::SetAssetRule(r) => {
            let asset = r.asset.clone();
            upsert(&mut p.assets, r, |x| x.asset == asset);
        }
        PolicyOp::RemoveAsset { asset } => p.assets.retain(|x| x.asset != asset),
        PolicyOp::AddRecipient(r) => add_unique(&mut p.recipients, r),
        PolicyOp::RemoveRecipient(r) => p.recipients.retain(|x| *x != r),
        PolicyOp::AddChain { chain_id } => add_unique(&mut p.chains, chain_id),
        PolicyOp::RemoveChain { chain_id } => p.chains.retain(|x| *x != chain_id),
        PolicyOp::AddIntentKind { kind } => add_unique(&mut p.intent_kinds, kind),
        PolicyOp::RemoveIntentKind { kind } => p.intent_kinds.retain(|x| *x != kind),
        PolicyOp::SetCooldown { seconds } => p.cooldown_s = seconds,
        PolicyOp::SetVelocity { velocity } => p.velocity = velocity,
        PolicyOp::SetMinRate(m) => {
            let (sell, buy) = (m.sell.clone(), m.buy.clone());
            upsert(&mut p.min_rates, m, |x| x.sell == sell && x.buy == buy);
        }
        PolicyOp::RemoveMinRate { sell, buy } => {
            p.min_rates.retain(|x| !(x.sell == sell && x.buy == buy));
        }
        PolicyOp::SetEvmGas(g) => {
            let chain_id = g.chain_id;
            upsert(&mut p.evm_gas, g, |x| x.chain_id == chain_id);
        }
        PolicyOp::RemoveEvmGas { chain_id } => p.evm_gas.retain(|x| x.chain_id != chain_id),
        PolicyOp::SetFeeBudget(w) => p.fee_budget = w,
        PolicyOp::SetPendingTtl { seconds } => p.pending_ttl_s = seconds,
        PolicyOp::SetTimelock { seconds } => p.timelock_s = seconds,
        PolicyOp::Freeze => p.frozen = true,
        PolicyOp::Unfreeze => p.frozen = false,
        // The code switch happens in `apply_migration`; the policy itself doesn't change.
        PolicyOp::Migrate { .. } => {}
    }
}

pub const fn period_ok(period_s: u32) -> bool {
    period_s as u64 >= BUCKETS && (period_s as u64).is_multiple_of(BUCKETS)
}

fn all_unique<T, K: PartialEq>(v: &[T], key: impl Fn(&T) -> K) -> bool {
    v.iter()
        .enumerate()
        .all(|(i, a)| v[..i].iter().all(|b| key(a) != key(b)))
}

impl Policy {
    /// Nothing can be spent until the owner adds asset rules and recipients.
    pub const fn empty() -> Self {
        Self {
            version: 0,
            frozen: false,
            assets: Vec::new(),
            recipients: Vec::new(),
            chains: Vec::new(),
            intent_kinds: Vec::new(),
            cooldown_s: 0,
            velocity: None,
            min_rates: Vec::new(),
            evm_gas: Vec::new(),
            fee_budget: WindowLimit {
                period_s: 86_400,
                limit: U128(0),
            },
            pending_ttl_s: 86_400,
            timelock_s: 86_400,
        }
    }

    pub fn rule(&self, asset: &Asset) -> Option<&AssetRule> {
        self.assets.iter().find(|r| &r.asset == asset)
    }

    pub fn min_rate(&self, sell: &str, buy: &str) -> Option<&MinRate> {
        self.min_rates
            .iter()
            .find(|m| m.sell == sell && m.buy == buy)
    }

    pub fn gas_caps(&self, chain_id: u64) -> Option<&GasCaps> {
        self.evm_gas
            .iter()
            .find(|g| g.chain_id == chain_id)
            .map(|g| &g.caps)
    }

    pub fn assert_valid(&self) {
        require!(self.assets.len() <= MAX_ASSETS, "too many assets");
        require!(
            all_unique(&self.assets, |r| r.asset.clone()),
            "duplicate asset rule"
        );
        for r in &self.assets {
            require!(r.windows.len() <= MAX_WINDOWS_PER_ASSET, "too many windows");
            require!(
                all_unique(&r.windows, |w| w.period_s),
                "duplicate window period"
            );
            require!(
                r.windows.iter().all(|w| period_ok(w.period_s)),
                "window period must be a multiple of 24 s"
            );
        }
        require!(
            self.recipients.len() <= MAX_RECIPIENTS,
            "too many recipients"
        );
        require!(
            all_unique(&self.recipients, Clone::clone),
            "duplicate recipient"
        );
        require!(self.chains.len() <= MAX_CHAINS, "too many chains");
        require!(all_unique(&self.chains, |c| *c), "duplicate chain");
        require!(
            all_unique(&self.intent_kinds, |k| *k),
            "duplicate intent kind"
        );
        require!(self.min_rates.len() <= MAX_MIN_RATES, "too many min rates");
        require!(
            all_unique(&self.min_rates, |m| (m.sell.clone(), m.buy.clone())),
            "duplicate min rate"
        );
        require!(
            self.min_rates.iter().all(|m| m.rate.den.0 > 0),
            "rate denominator must be positive"
        );
        require!(self.evm_gas.len() <= MAX_CHAINS, "too many gas caps");
        require!(
            all_unique(&self.evm_gas, |g| g.chain_id),
            "duplicate gas caps"
        );
        require!(
            period_ok(self.fee_budget.period_s),
            "fee budget period must be a multiple of 24 s"
        );
        if let Some(v) = self.velocity {
            require!(v.max > 0 && period_ok(v.period_s), "bad velocity");
        }
        require!(self.pending_ttl_s > 0, "pending ttl must be positive");
    }
}

const LO: u128 = u64::MAX as u128;

/// Full 256-bit product as (high, low).
const fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let (a1, a0) = (a >> 64, a & LO);
    let (b1, b0) = (b >> 64, b & LO);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let mid = (p00 >> 64) + (p01 & LO) + (p10 & LO);
    let lo = (p00 & LO) | (mid << 64);
    let hi = a1 * b1 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// `a * b >= c * d` without overflow.
pub const fn product_ge(a: u128, b: u128, c: u128, d: u128) -> bool {
    let (h1, l1) = mul_wide(a, b);
    let (h2, l2) = mul_wide(c, d);
    h1 > h2 || (h1 == h2 && l1 >= l2)
}

pub const fn rate_ge(a: &Rate, b: &Rate) -> bool {
    product_ge(a.num.0, b.den.0, b.num.0, a.den.0)
}

/// Whether selling `amount` for at least `min_out` meets the floor.
pub const fn meets_rate(amount: u128, min_out: u128, floor: &Rate) -> bool {
    product_ge(min_out, floor.den.0, floor.num.0, amount)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use near_sdk::AccountId;

    pub fn usdc() -> Asset {
        Asset::Nep141 {
            token: "usdc.test.near".parse::<AccountId>().unwrap(),
        }
    }

    pub fn base_policy() -> Policy {
        Policy {
            version: 1,
            frozen: false,
            assets: vec![AssetRule {
                asset: usdc(),
                per_tx_cap: U128(50),
                windows: vec![WindowLimit {
                    period_s: 86_400,
                    limit: U128(200),
                }],
                cosign_above: Some(U128(40)),
                risk_check_above: None,
            }],
            recipients: vec![],
            chains: vec![84532],
            intent_kinds: vec![],
            cooldown_s: 0,
            velocity: Some(Velocity {
                max: 10,
                period_s: 3_600,
            }),
            min_rates: vec![],
            evm_gas: vec![],
            fee_budget: WindowLimit {
                period_s: 86_400,
                limit: U128(10u128.pow(23)),
            },
            pending_ttl_s: 3_600,
            timelock_s: 86_400,
        }
    }

    fn rule_with(f: impl FnOnce(&mut AssetRule)) -> PolicyOp {
        let mut r = base_policy().assets[0].clone();
        f(&mut r);
        PolicyOp::SetAssetRule(r)
    }

    #[test]
    fn lowering_caps_is_tighten_raising_is_loosen() {
        let p = base_policy();
        assert_eq!(
            classify(&rule_with(|r| r.per_tx_cap = U128(10)), &p),
            Effect::Tighten
        );
        assert_eq!(
            classify(&rule_with(|r| r.per_tx_cap = U128(51)), &p),
            Effect::Loosen
        );
        assert_eq!(
            classify(&rule_with(|r| r.windows[0].limit = U128(100)), &p),
            Effect::Tighten
        );
        assert_eq!(
            classify(&rule_with(|r| r.windows[0].limit = U128(201)), &p),
            Effect::Loosen
        );
    }

    #[test]
    fn window_changes() {
        let p = base_policy();
        let extra = rule_with(|r| {
            r.windows.push(WindowLimit {
                period_s: 3_600,
                limit: U128(60),
            })
        });
        assert_eq!(classify(&extra, &p), Effect::Tighten);
        assert_eq!(
            classify(&rule_with(|r| r.windows.clear()), &p),
            Effect::Loosen
        );
        let swapped = rule_with(|r| {
            r.windows = vec![WindowLimit {
                period_s: 3_600,
                limit: U128(1),
            }]
        });
        assert_eq!(classify(&swapped, &p), Effect::Loosen);
    }

    #[test]
    fn dropping_cosign_is_loosen() {
        let p = base_policy();
        assert_eq!(
            classify(&rule_with(|r| r.cosign_above = None), &p),
            Effect::Loosen
        );
        assert_eq!(
            classify(&rule_with(|r| r.cosign_above = Some(U128(41))), &p),
            Effect::Loosen
        );
        assert_eq!(
            classify(&rule_with(|r| r.cosign_above = Some(U128(5))), &p),
            Effect::Tighten
        );
        assert_eq!(
            classify(&rule_with(|r| r.risk_check_above = Some(U128(5))), &p),
            Effect::Tighten
        );
    }

    #[test]
    fn new_asset_is_loosen_removal_is_tighten() {
        let p = base_policy();
        let mut r = p.assets[0].clone();
        r.asset = Asset::Near;
        assert_eq!(classify(&PolicyOp::SetAssetRule(r), &p), Effect::Loosen);
        assert_eq!(
            classify(&PolicyOp::RemoveAsset { asset: usdc() }, &p),
            Effect::Tighten
        );
    }

    #[test]
    fn allowlist_and_scalar_ops() {
        let p = base_policy();
        let rcpt = Recipient::Near {
            account: "shop.near".parse().unwrap(),
        };
        assert_eq!(
            classify(&PolicyOp::AddRecipient(rcpt.clone()), &p),
            Effect::Loosen
        );
        assert_eq!(
            classify(&PolicyOp::RemoveRecipient(rcpt), &p),
            Effect::Tighten
        );
        assert_eq!(
            classify(&PolicyOp::AddChain { chain_id: 1 }, &p),
            Effect::Loosen
        );
        assert_eq!(
            classify(&PolicyOp::RemoveChain { chain_id: 84532 }, &p),
            Effect::Tighten
        );
        assert_eq!(
            classify(&PolicyOp::SetCooldown { seconds: 60 }, &p),
            Effect::Tighten
        );
        assert_eq!(
            classify(&PolicyOp::SetTimelock { seconds: 60 }, &p),
            Effect::Loosen
        );
        assert_eq!(
            classify(&PolicyOp::SetTimelock { seconds: 172_800 }, &p),
            Effect::Tighten
        );
        assert_eq!(classify(&PolicyOp::Freeze, &p), Effect::Tighten);
        assert_eq!(classify(&PolicyOp::Unfreeze, &p), Effect::Loosen);
        assert_eq!(
            classify(&PolicyOp::SetPendingTtl { seconds: 60 }, &p),
            Effect::Tighten
        );
        assert_eq!(
            classify(&PolicyOp::SetPendingTtl { seconds: 7_200 }, &p),
            Effect::Loosen
        );
    }

    #[test]
    fn velocity_ops() {
        let p = base_policy();
        let v = |max, period_s| PolicyOp::SetVelocity {
            velocity: Some(Velocity { max, period_s }),
        };
        assert_eq!(classify(&v(5, 3_600), &p), Effect::Tighten);
        assert_eq!(classify(&v(10, 7_200), &p), Effect::Tighten);
        assert_eq!(classify(&v(5, 1_800), &p), Effect::Loosen);
        assert_eq!(
            classify(&PolicyOp::SetVelocity { velocity: None }, &p),
            Effect::Loosen
        );
    }

    #[test]
    fn fee_and_gas_ops() {
        let mut p = base_policy();
        let fee = |limit, period_s| {
            PolicyOp::SetFeeBudget(WindowLimit {
                period_s,
                limit: U128(limit),
            })
        };
        assert_eq!(classify(&fee(1, 86_400), &p), Effect::Tighten);
        assert_eq!(classify(&fee(1, 3_600), &p), Effect::Loosen);
        let caps = GasCaps {
            max_gas_limit: 100_000,
            max_fee_per_gas: U128(10),
            max_priority_fee_per_gas: U128(1),
        };
        let set = PolicyOp::SetEvmGas(ChainGas {
            chain_id: 84532,
            caps,
        });
        assert_eq!(classify(&set, &p), Effect::Loosen);
        apply(set, &mut p);
        let lower = PolicyOp::SetEvmGas(ChainGas {
            chain_id: 84532,
            caps: GasCaps {
                max_gas_limit: 60_000,
                ..caps
            },
        });
        assert_eq!(classify(&lower, &p), Effect::Tighten);
        let higher = PolicyOp::SetEvmGas(ChainGas {
            chain_id: 84532,
            caps: GasCaps {
                max_fee_per_gas: U128(11),
                ..caps
            },
        });
        assert_eq!(classify(&higher, &p), Effect::Loosen);
    }

    #[test]
    fn min_rate_ops() {
        let mut p = base_policy();
        let m = |num, den| MinRate {
            sell: "a".into(),
            buy: "b".into(),
            rate: Rate {
                num: U128(num),
                den: U128(den),
            },
        };
        assert_eq!(classify(&PolicyOp::SetMinRate(m(1, 2)), &p), Effect::Loosen);
        apply(PolicyOp::SetMinRate(m(1, 2)), &mut p);
        assert_eq!(
            classify(&PolicyOp::SetMinRate(m(2, 3)), &p),
            Effect::Tighten
        );
        assert_eq!(classify(&PolicyOp::SetMinRate(m(1, 3)), &p), Effect::Loosen);
        assert_eq!(
            classify(
                &PolicyOp::RemoveMinRate {
                    sell: "a".into(),
                    buy: "b".into()
                },
                &p
            ),
            Effect::Tighten
        );
    }

    #[test]
    fn apply_is_idempotent_for_adds() {
        let mut p = base_policy();
        apply(PolicyOp::AddChain { chain_id: 84532 }, &mut p);
        assert_eq!(p.chains, vec![84532]);
    }

    #[test]
    fn wide_products() {
        let m = u128::MAX;
        assert!(product_ge(m, m, m, m - 1));
        assert!(!product_ge(m, m - 1, m, m));
        assert!(product_ge(1 << 100, 1 << 100, 1, 1 << 127));
        assert!(meets_rate(
            1_000,
            2_000,
            &Rate {
                num: U128(2),
                den: U128(1)
            }
        ));
        assert!(!meets_rate(
            1_000,
            1_999,
            &Rate {
                num: U128(2),
                den: U128(1)
            }
        ));
        assert!(meets_rate(
            10u128.pow(30),
            10u128.pow(30),
            &Rate {
                num: U128(10u128.pow(30)),
                den: U128(10u128.pow(30))
            }
        ));
    }

    #[test]
    #[should_panic(expected = "multiple of 24")]
    fn rejects_bad_period() {
        let mut p = base_policy();
        p.assets[0].windows[0].period_s = 100;
        p.assert_valid();
    }

    #[test]
    #[should_panic(expected = "duplicate asset rule")]
    fn rejects_duplicate_assets() {
        let mut p = base_policy();
        p.assets.push(p.assets[0].clone());
        p.assert_valid();
    }
}

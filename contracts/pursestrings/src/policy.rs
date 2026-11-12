use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::{AccountId, near, require};

use crate::ring::BUCKETS;
use crate::types::{Asset, IntentKind, Recipient};

pub const MAX_ASSETS: usize = 16;
pub const MAX_WINDOWS_PER_ASSET: usize = 4;
pub const MAX_RECIPIENTS: usize = 64;
pub const MAX_CHAINS: usize = 16;
pub const MAX_MIN_RATES: usize = 16;
pub const MAX_TIMELOCK_S: u32 = 30 * 86_400;
pub const MAX_OPS_PER_PROPOSAL: usize = 32;
pub const MAX_GROUPS: usize = 8;
pub const MAX_GROUP_NAME_BYTES: usize = 32;
/// Beyond this a decimals gap can't be rescaled in a u128.
pub const MAX_DECIMALS: u8 = 30;
/// Every share is paid out by the agent's `deliver` call, so the count bounds that call's gas.
pub const MAX_SHARES: usize = 4;
pub const MAX_COUNCIL: usize = 16;
pub const MAX_TIERS: usize = 8;
pub const BPS: u16 = 10_000;

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
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupMember {
    pub asset: Asset,
    pub decimals: u8,
}

/// Assets the owner declares to be the same unit, such as USDC on NEAR, on Base and inside
/// Intents, sharing one set of windows. There's no oracle: `decimals` only rescales amounts to
/// the group's unit, rounding up.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BudgetGroup {
    pub name: String,
    pub decimals: u8,
    pub members: Vec<GroupMember>,
    pub windows: Vec<WindowLimit>,
}

impl BudgetGroup {
    pub fn member(&self, asset: &Asset) -> Option<&GroupMember> {
        self.members.iter().find(|m| &m.asset == asset)
    }

    /// `amount` of a member in the group's unit, rounded up so dust can't slip under a limit.
    pub fn normalize(&self, member: &GroupMember, amount: u128) -> Option<u128> {
        if member.decimals >= self.decimals {
            let d = 10u128.checked_pow(u32::from(member.decimals - self.decimals))?;
            Some(amount.div_ceil(d))
        } else {
            amount.checked_mul(10u128.checked_pow(u32::from(self.decimals - member.decimals))?)
        }
    }
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

/// The lowest price the agent may quote in an asset. With no floor it can't sell in that asset.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceFloor {
    pub asset: Asset,
    pub min: U128,
}

/// A fixed share of every sale, paid to `account` in the same receipt the payment lands in.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Share {
    pub account: AccountId,
    pub bps: u16,
}

/// How much the agent may refund in an asset over a rolling window. With none it can't refund.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefundLimit {
    pub asset: Asset,
    pub window: WindowLimit,
}

/// From `points` paid bounties up: payouts up to `auto_up_to` go through on their own, up to
/// `council_up_to` need one council member, and anything larger needs the owner.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tier {
    pub points: u32,
    pub auto_up_to: U128,
    pub council_up_to: U128,
}

/// Bounty payouts in `asset` are routed by the claimant's earned points instead of the
/// recipient allowlist.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustRule {
    pub asset: Asset,
    pub tiers: Vec<Tier>,
}

impl TrustRule {
    /// `(auto_up_to, council_up_to)` for someone with `points`; nothing below the first tier.
    pub fn limits(&self, points: u32) -> (u128, u128) {
        self.tiers
            .iter()
            .filter(|t| t.points <= points)
            .max_by_key(|t| t.points)
            .map_or((0, 0), |t| (t.auto_up_to.0, t.council_up_to.0))
    }
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
    pub groups: Vec<BudgetGroup>,
    pub floors: Vec<PriceFloor>,
    /// What isn't shared stays in the account and is all a refund can come from.
    pub split: Vec<Share>,
    pub refund_limits: Vec<RefundLimit>,
    /// Can approve mid-size bounty payouts, post bounties and freeze.
    pub council: Vec<AccountId>,
    pub trust: Vec<TrustRule>,
    /// How long the agent has to deliver a paid order before the buyer can take it back.
    pub delivery_s: u32,
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
    SetGroup(BudgetGroup),
    RemoveGroup {
        name: String,
    },
    SetPriceFloor(PriceFloor),
    RemovePriceFloor {
        asset: Asset,
    },
    /// Replaces the whole split. Where revenue goes always waits for the timelock.
    SetSplit {
        shares: Vec<Share>,
    },
    SetRefundLimit(RefundLimit),
    RemoveRefundLimit {
        asset: Asset,
    },
    AddCouncil {
        account: AccountId,
    },
    RemoveCouncil {
        account: AccountId,
    },
    SetTrust(TrustRule),
    RemoveTrust {
        asset: Asset,
    },
    SetDeliveryWindow {
        seconds: u32,
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
        && windows_tighter(&new.windows, &cur.windows)
        && threshold_tighter(new.cosign_above, cur.cosign_above)
        && threshold_tighter(new.risk_check_above, cur.risk_check_above)
}

fn windows_tighter(new: &[WindowLimit], cur: &[WindowLimit]) -> bool {
    cur.iter().all(|cw| {
        new.iter()
            .any(|nw| nw.period_s == cw.period_s && nw.limit.0 <= cw.limit.0)
    })
}

/// Adding members or windows only adds limits. Dropping a member, changing any decimals or
/// raising a window frees budget.
fn group_tighter(new: &BudgetGroup, cur: &BudgetGroup) -> bool {
    new.decimals == cur.decimals
        && cur.members.iter().all(|m| {
            new.member(&m.asset)
                .is_some_and(|n| n.decimals == m.decimals)
        })
        && windows_tighter(&new.windows, &cur.windows)
}

/// Usage is kept per window length, so a new length would start from zero: only the same
/// length with a lower limit is tighter.
fn window_tighter(new: &WindowLimit, cur: &WindowLimit) -> bool {
    new.limit.0 <= cur.limit.0 && new.period_s == cur.period_s
}

/// Limits only change at a tier's points, so comparing there covers every points value.
fn trust_tighter(new: &TrustRule, cur: &TrustRule) -> bool {
    std::iter::once(0)
        .chain(new.tiers.iter().chain(&cur.tiers).map(|t| t.points))
        .all(|pts| {
            let (na, nc) = new.limits(pts);
            let (ca, cc) = cur.limits(pts);
            na <= ca && nc <= cc
        })
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
            (Some(n), Some(c)) => n.max <= c.max && n.period_s == c.period_s,
        },
        PolicyOp::SetMinRate(new) => p
            .min_rate(&new.sell, &new.buy)
            .is_some_and(|cur| rate_ge(&new.rate, &cur.rate)),
        PolicyOp::SetEvmGas(new) => p
            .gas_caps(new.chain_id)
            .is_some_and(|cur| caps_tighter(&new.caps, cur)),
        PolicyOp::SetFeeBudget(new) => window_tighter(new, &p.fee_budget),
        PolicyOp::SetPendingTtl { seconds } => *seconds <= p.pending_ttl_s,
        PolicyOp::SetDeliveryWindow { seconds } => *seconds <= p.delivery_s,
        PolicyOp::SetTimelock { seconds } => *seconds >= p.timelock_s,
        PolicyOp::SetGroup(new) => p.group(&new.name).is_none_or(|cur| group_tighter(new, cur)),
        PolicyOp::SetPriceFloor(new) => p.floor(&new.asset).is_some_and(|cur| new.min.0 >= cur.0),
        PolicyOp::SetSplit { shares } => *shares == p.split,
        PolicyOp::SetRefundLimit(new) => p
            .refund_limit(&new.asset)
            .is_some_and(|cur| window_tighter(&new.window, cur)),
        PolicyOp::SetTrust(new) => p
            .trust_rule(&new.asset)
            .is_some_and(|cur| trust_tighter(new, cur)),
        PolicyOp::RemoveAsset { .. }
        | PolicyOp::RemoveRecipient(_)
        | PolicyOp::RemoveChain { .. }
        | PolicyOp::RemoveIntentKind { .. }
        | PolicyOp::RemoveMinRate { .. }
        | PolicyOp::RemoveEvmGas { .. }
        | PolicyOp::RemovePriceFloor { .. }
        | PolicyOp::RemoveRefundLimit { .. }
        | PolicyOp::RemoveCouncil { .. }
        | PolicyOp::RemoveTrust { .. }
        | PolicyOp::Freeze => true,
        PolicyOp::AddRecipient(_)
        | PolicyOp::AddChain { .. }
        | PolicyOp::AddIntentKind { .. }
        | PolicyOp::Unfreeze
        | PolicyOp::Migrate { .. }
        | PolicyOp::RemoveGroup { .. }
        | PolicyOp::AddCouncil { .. } => false,
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
        PolicyOp::SetGroup(g) => {
            let name = g.name.clone();
            upsert(&mut p.groups, g, |x| x.name == name);
        }
        PolicyOp::RemoveGroup { name } => p.groups.retain(|x| x.name != name),
        PolicyOp::SetPriceFloor(f) => {
            require!(f.asset == Asset::Near, "the shop sells in NEAR only");
            let asset = f.asset.clone();
            upsert(&mut p.floors, f, |x| x.asset == asset);
        }
        PolicyOp::RemovePriceFloor { asset } => p.floors.retain(|x| x.asset != asset),
        PolicyOp::SetSplit { shares } => p.split = shares,
        PolicyOp::SetRefundLimit(r) => {
            let asset = r.asset.clone();
            upsert(&mut p.refund_limits, r, |x| x.asset == asset);
        }
        PolicyOp::RemoveRefundLimit { asset } => p.refund_limits.retain(|x| x.asset != asset),
        PolicyOp::AddCouncil { account } => add_unique(&mut p.council, account),
        PolicyOp::RemoveCouncil { account } => p.council.retain(|x| *x != account),
        PolicyOp::SetTrust(t) => {
            let asset = t.asset.clone();
            upsert(&mut p.trust, t, |x| x.asset == asset);
        }
        PolicyOp::RemoveTrust { asset } => p.trust.retain(|x| x.asset != asset),
        PolicyOp::SetDeliveryWindow { seconds } => p.delivery_s = seconds,
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
            groups: Vec::new(),
            floors: Vec::new(),
            split: Vec::new(),
            refund_limits: Vec::new(),
            council: Vec::new(),
            trust: Vec::new(),
            delivery_s: 3_600,
        }
    }

    pub fn floor(&self, asset: &Asset) -> Option<U128> {
        self.floors
            .iter()
            .find(|f| &f.asset == asset)
            .map(|f| f.min)
    }

    pub fn refund_limit(&self, asset: &Asset) -> Option<&WindowLimit> {
        self.refund_limits
            .iter()
            .find(|r| &r.asset == asset)
            .map(|r| &r.window)
    }

    pub fn trust_rule(&self, asset: &Asset) -> Option<&TrustRule> {
        self.trust.iter().find(|t| &t.asset == asset)
    }

    pub fn group(&self, name: &str) -> Option<&BudgetGroup> {
        self.groups.iter().find(|g| g.name == name)
    }

    pub fn group_of(&self, asset: &Asset) -> Option<(&BudgetGroup, &GroupMember)> {
        self.groups
            .iter()
            .find_map(|g| g.member(asset).map(|m| (g, m)))
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
        require!(self.groups.len() <= MAX_GROUPS, "too many groups");
        require!(
            all_unique(&self.groups, |g| g.name.clone()),
            "duplicate group"
        );
        let members = || self.groups.iter().flat_map(|g| g.members.iter());
        require!(
            members().count() <= MAX_ASSETS
                && all_unique(&members().collect::<Vec<_>>(), |m| m.asset.clone()),
            "an asset can be in one group"
        );
        for g in &self.groups {
            require!(
                !g.name.is_empty() && g.name.len() <= MAX_GROUP_NAME_BYTES,
                "group name must be 1..=32 bytes"
            );
            require!(
                g.decimals <= MAX_DECIMALS && g.members.iter().all(|m| m.decimals <= MAX_DECIMALS),
                "decimals must be <= 30"
            );
            require!(g.windows.len() <= MAX_WINDOWS_PER_ASSET, "too many windows");
            require!(
                all_unique(&g.windows, |w| w.period_s)
                    && g.windows.iter().all(|w| period_ok(w.period_s)),
                "group windows: unique periods, multiples of 24 s"
            );
        }
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
            self.evm_gas.iter().all(|g| {
                let c = &g.caps;
                c.max_gas_limit >= 21_000
                    && c.max_priority_fee_per_gas.0 <= c.max_fee_per_gas.0
                    && crate::evm::max_gas_cost(c).is_some()
            }),
            "gas caps: limit >= 21000, priority fee <= max fee"
        );
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
        // Raising the timelock is tightening, so it applies at once; without a ceiling a typo or
        // a thief could set one that outlives everyone, and with a freeze lock the account for good.
        require!(
            self.timelock_s <= MAX_TIMELOCK_S,
            "timelock at most 30 days"
        );
        require!(self.delivery_s > 0, "delivery window must be positive");
        let near_side = |a: &Asset| matches!(a, Asset::Near | Asset::Nep141 { .. });
        require!(
            self.floors.len() <= MAX_ASSETS
                && all_unique(&self.floors, |f| f.asset.clone())
                && self
                    .floors
                    .iter()
                    .all(|f| near_side(&f.asset) && f.min.0 > 0),
            "price floors: unique NEAR or NEP-141 assets, positive"
        );
        require!(
            self.split.len() <= MAX_SHARES
                && all_unique(&self.split, |s| s.account.clone())
                && self.split.iter().all(|s| s.bps > 0)
                && self.split.iter().map(|s| u32::from(s.bps)).sum::<u32>() <= u32::from(BPS),
            "split: at most 4 accounts, positive shares summing to at most 10000 bps"
        );
        require!(
            self.refund_limits.len() <= MAX_ASSETS
                && all_unique(&self.refund_limits, |r| r.asset.clone())
                && self
                    .refund_limits
                    .iter()
                    .all(|r| near_side(&r.asset) && period_ok(r.window.period_s)),
            "refund limits: unique NEAR or NEP-141 assets, period a multiple of 24 s"
        );
        require!(
            self.council.len() <= MAX_COUNCIL && all_unique(&self.council, Clone::clone),
            "council: at most 16 unique accounts"
        );
        require!(
            self.trust.len() <= MAX_ASSETS
                && all_unique(&self.trust, |t| t.asset.clone())
                && self.trust.iter().all(|t| {
                    near_side(&t.asset)
                        && t.tiers.len() <= MAX_TIERS
                        && all_unique(&t.tiers, |x| x.points)
                        && t.tiers.iter().all(|x| x.auto_up_to.0 <= x.council_up_to.0)
                }),
            "trust: unique NEAR or NEP-141 assets, at most 8 tiers, auto <= council"
        );
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
            groups: vec![],
            floors: vec![],
            split: vec![],
            refund_limits: vec![],
            council: vec![],
            trust: vec![],
            delivery_s: 600,
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
    fn a_new_window_length_is_a_loosening() {
        let mut p = base_policy();
        p.fee_budget.limit = U128(100);
        p.refund_limits.push(RefundLimit {
            asset: Asset::Near,
            window: WindowLimit {
                period_s: 86_400,
                limit: U128(100),
            },
        });
        let fee = |limit, period_s| {
            PolicyOp::SetFeeBudget(WindowLimit {
                period_s,
                limit: U128(limit),
            })
        };
        let refund = |limit, period_s| {
            PolicyOp::SetRefundLimit(RefundLimit {
                asset: Asset::Near,
                window: WindowLimit {
                    period_s,
                    limit: U128(limit),
                },
            })
        };
        for op in [fee(50, 86_400), refund(50, 86_400)] {
            assert_eq!(classify(&op, &p), Effect::Tighten);
        }
        for op in [fee(100, 172_800), refund(100, 172_800)] {
            assert_eq!(
                classify(&op, &p),
                Effect::Loosen,
                "usage would restart at zero"
            );
        }
    }

    #[test]
    fn velocity_ops() {
        let p = base_policy();
        let v = |max, period_s| PolicyOp::SetVelocity {
            velocity: Some(Velocity { max, period_s }),
        };
        assert_eq!(classify(&v(5, 3_600), &p), Effect::Tighten);
        assert_eq!(
            classify(&v(10, 7_200), &p),
            Effect::Loosen,
            "a new window length starts with no usage"
        );
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

    fn usd(members: &[(Asset, u8)], limit: u128) -> BudgetGroup {
        BudgetGroup {
            name: "usd".into(),
            decimals: 6,
            members: members
                .iter()
                .map(|(asset, decimals)| GroupMember {
                    asset: asset.clone(),
                    decimals: *decimals,
                })
                .collect(),
            windows: vec![WindowLimit {
                period_s: 86_400,
                limit: U128(limit),
            }],
        }
    }

    #[test]
    fn group_ops() {
        let mut p = base_policy();
        let base_usdc = Asset::Evm {
            chain_id: 84532,
            token: None,
        };
        let g = usd(&[(usdc(), 6)], 100);
        assert_eq!(
            classify(&PolicyOp::SetGroup(g.clone()), &p),
            Effect::Tighten
        );
        apply(PolicyOp::SetGroup(g), &mut p);
        let wider = usd(&[(usdc(), 6), (base_usdc.clone(), 6)], 100);
        assert_eq!(classify(&PolicyOp::SetGroup(wider), &p), Effect::Tighten);
        assert_eq!(
            classify(&PolicyOp::SetGroup(usd(&[(usdc(), 6)], 101)), &p),
            Effect::Loosen
        );
        assert_eq!(
            classify(&PolicyOp::SetGroup(usd(&[(base_usdc, 6)], 50)), &p),
            Effect::Loosen,
            "dropping a member frees it"
        );
        assert_eq!(
            classify(&PolicyOp::SetGroup(usd(&[(usdc(), 9)], 100)), &p),
            Effect::Loosen,
            "more decimals shrinks every charge"
        );
        assert_eq!(
            classify(&PolicyOp::RemoveGroup { name: "usd".into() }, &p),
            Effect::Loosen
        );
    }

    #[test]
    fn group_rescales_rounding_up() {
        let g = usd(&[], 0);
        let m = |decimals| GroupMember {
            asset: usdc(),
            decimals,
        };
        assert_eq!(g.normalize(&m(6), 40_000_000), Some(40_000_000));
        assert_eq!(g.normalize(&m(18), 1), Some(1));
        assert_eq!(g.normalize(&m(18), 10u128.pow(12)), Some(1));
        assert_eq!(g.normalize(&m(18), 10u128.pow(12) + 1), Some(2));
        assert_eq!(g.normalize(&m(2), 5), Some(50_000));
        assert_eq!(g.normalize(&m(0), u128::MAX), None);
    }

    #[test]
    #[should_panic(expected = "an asset can be in one group")]
    fn rejects_asset_in_two_groups() {
        let mut p = base_policy();
        p.groups.push(usd(&[(usdc(), 6)], 1));
        let mut other = usd(&[(usdc(), 6)], 1);
        other.name = "other".into();
        p.groups.push(other);
        p.assert_valid();
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

    #[test]
    fn shop_and_board_rules_classify() {
        use near_sdk::AccountId;
        let acct = |s: &str| s.parse::<AccountId>().unwrap();
        let mut p = base_policy();
        p.floors.push(PriceFloor {
            asset: usdc(),
            min: U128(100),
        });
        p.split.push(Share {
            account: acct("dao.near"),
            bps: 2_000,
        });
        p.council.push(acct("c.near"));
        let tier = |points, auto_up_to, council_up_to| Tier {
            points,
            auto_up_to: U128(auto_up_to),
            council_up_to: U128(council_up_to),
        };
        p.trust.push(TrustRule {
            asset: usdc(),
            tiers: vec![tier(0, 0, 20), tier(3, 10, 30)],
        });
        let floor = |min| {
            PolicyOp::SetPriceFloor(PriceFloor {
                asset: usdc(),
                min: U128(min),
            })
        };
        assert_eq!(classify(&floor(150), &p), Effect::Tighten);
        assert_eq!(classify(&floor(99), &p), Effect::Loosen);
        let same = PolicyOp::SetSplit {
            shares: p.split.clone(),
        };
        assert_eq!(classify(&same, &p), Effect::Tighten);
        let redirect = PolicyOp::SetSplit {
            shares: vec![Share {
                account: acct("thief.near"),
                bps: 2_000,
            }],
        };
        assert_eq!(classify(&redirect, &p), Effect::Loosen);
        let trust = |tiers| {
            PolicyOp::SetTrust(TrustRule {
                asset: usdc(),
                tiers,
            })
        };
        assert_eq!(
            classify(&trust(vec![tier(0, 0, 20), tier(5, 10, 30)]), &p),
            Effect::Tighten,
            "more points for the same limits"
        );
        assert_eq!(
            classify(&trust(vec![tier(0, 0, 20), tier(2, 10, 30)]), &p),
            Effect::Loosen,
            "fewer points for the same limits"
        );
        assert_eq!(
            classify(&trust(vec![tier(0, 1, 20), tier(3, 10, 30)]), &p),
            Effect::Loosen
        );
        assert_eq!(
            classify(
                &PolicyOp::AddCouncil {
                    account: acct("x.near")
                },
                &p
            ),
            Effect::Loosen
        );
        assert_eq!(
            classify(
                &PolicyOp::RemoveCouncil {
                    account: acct("c.near")
                },
                &p
            ),
            Effect::Tighten
        );
    }

    #[test]
    #[should_panic(expected = "split")]
    fn a_split_over_everything_is_invalid() {
        let mut p = base_policy();
        for (a, bps) in [("a.near", 6_000), ("b.near", 4_001)] {
            p.split.push(Share {
                account: a.parse().unwrap(),
                bps,
            });
        }
        p.assert_valid();
    }
}

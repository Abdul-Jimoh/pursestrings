use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, Gas, NearToken, Promise, PromiseOrValue, env, is_promise_success, near, require,
};

use crate::events::Event;
use crate::policy::{BPS, Policy};
use crate::types::{Asset, MAX_PURPOSE_BYTES, UsageKey};
use crate::{Pursestrings, PursestringsExt, now_s};

const PAYOUT_CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Each quote is stored until it's paid or someone expires it, so open quotes are capped to
/// keep a compromised agent key from filling storage.
pub const MAX_OPEN_QUOTES: u32 = 64;
const MAX_PAGE: u32 = 100;
// Held NEAR lives in raw storage keys, outside the contract struct, so accounts created
// before it existed can migrate without a state rewrite. The total is the sum of the per-order
// and per-payee entries.
const OWED_NEAR: &[u8] = b"owed_near";

fn read_u128(key: &[u8]) -> u128 {
    env::storage_read(key).map_or(0, |b| {
        u128::from_le_bytes(b.try_into().unwrap_or_else(|_| env::abort()))
    })
}

fn write_u128(key: &[u8], v: u128) {
    if v == 0 {
        env::storage_remove(key);
    } else {
        env::storage_write(key, &v.to_le_bytes());
    }
}

fn order_key(order_id: u64) -> Vec<u8> {
    [b"held:".as_slice(), &order_id.to_le_bytes()].concat()
}

fn payee_key(account: &AccountId) -> Vec<u8> {
    [b"owed_to:".as_slice(), account.as_bytes()].concat()
}

/// NEAR the account holds for others: payments for orders not yet delivered and split shares
/// that failed to pay out. Withdrawals, spends and refunds of delivered orders can't touch it.
fn held_near() -> u128 {
    read_u128(OWED_NEAR)
}

fn hold(asset: &Asset, key: &[u8], amount: u128) {
    if *asset == Asset::Near {
        write_u128(key, read_u128(key) + amount);
        write_u128(OWED_NEAR, held_near() + amount);
    }
}

/// Releases at most what was held under `key`, so an order paid before the account tracked
/// this releases nothing that newer orders hold.
fn release(asset: &Asset, key: &[u8], amount: u128) {
    if *asset == Asset::Near {
        let held = read_u128(key);
        let r = held.min(amount);
        write_u128(key, held - r);
        write_u128(OWED_NEAR, held_near().saturating_sub(r));
    }
}

/// Worst-case storage of one order (two 256-byte strings, two account ids, the fixed fields
/// and the trie's per-record overhead), rounded up.
const ORDER_BYTES: u128 = 1_000;
/// How far back `migrate` looks for paid orders the old code didn't track. Undelivered orders
/// are recent, since the delivery window is short. With all 50 untracked, `migrate` burned
/// about 14 Tgas in the sandbox; the upgrade script also checks every order and open quote.
const RECOUNT_ORDERS: u64 = 50;

impl Pursestrings {
    /// What the account can send without dipping into its storage stake, what it holds for
    /// buyers and payees, the gas its agent keys may still burn (they sign as this account, so
    /// their gas comes from its balance), or, if it sells, the stake its free quote slots could
    /// take.
    pub(crate) fn spendable_near(&self) -> u128 {
        let byte = env::storage_byte_cost().as_yoctonear();
        let stake = u128::from(env::storage_usage()) * byte;
        let gas: u128 = self.agents.values().map(|a| a.allowance.0).sum();
        let sells = self.policy.floor(&Asset::Near).is_some();
        let quotes = u128::from(sells)
            * u128::from(MAX_OPEN_QUOTES.saturating_sub(self.open_quotes))
            * ORDER_BYTES
            * byte;
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(stake + held_near() + gas + quotes)
    }

    /// Counts what the code before held-NEAR tracking left untracked: recent paid orders and
    /// the split's unpaid shares. Only ever raises an entry to what's actually owed.
    pub(crate) fn recount_held(&self) {
        let mut added = 0;
        let mut raise = |key: Vec<u8>, owed: u128| {
            let have = read_u128(&key);
            if owed > have {
                write_u128(&key, owed);
                added += owed - have;
            }
        };
        let end = self.next_order_id;
        for id in end.saturating_sub(RECOUNT_ORDERS)..end {
            if let Some(o) = self.orders.get(&id)
                && o.status == OrderStatus::Paid
                && o.asset == Asset::Near
            {
                raise(order_key(id), o.held.0);
            }
        }
        for s in &self.policy.split {
            let key = (s.account.clone(), Asset::Near);
            raise(
                payee_key(&s.account),
                self.unpaid.get(&key).map_or(0, |a| a.0),
            );
        }
        if added > 0 {
            write_u128(OWED_NEAR, held_near() + added);
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderStatus {
    Quoted,
    /// Paid and held: nothing is shared out until the agent delivers.
    Paid,
    Delivered,
    /// Refunded in full before delivery, by the agent or by the buyer after the deadline.
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    /// Only this account may pay the quote; `None` lets anyone pay it.
    pub buyer: Option<AccountId>,
    pub asset: Asset,
    pub price: U128,
    pub item: String,
    pub status: OrderStatus,
    pub quoted_at: u64,
    pub expires_at: u64,
    pub payer: Option<AccountId>,
    pub paid_at: Option<u64>,
    /// After this the buyer can take an undelivered payment back themselves.
    pub deliver_by: Option<u64>,
    /// What a refund can still come from: the whole payment until delivery, then only the
    /// part the account kept after paying the split.
    pub held: U128,
    pub refunded: U128,
    pub receipt: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QuoteDenial {
    Frozen,
    NotForSale,
    BelowFloor { floor: U128 },
    TooManyOpenQuotes,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QuoteDecision {
    Quoted { order_id: u64, expires_at: u64 },
    Denied { reason: QuoteDenial },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefundDenial {
    Frozen,
    NotPaid,
    /// More than the order still holds.
    OverHeld {
        max: U128,
    },
    NoRefundLimit,
    OverWindow {
        period_s: u32,
        remaining: U128,
    },
    /// Before delivery a refund returns the whole payment: a partial one would let the rest
    /// be delivered for less than the floor the quote was checked against.
    NotWhole {
        held: U128,
    },
    /// The kept share is gone and the rest is held for other buyers.
    HeldForOthers {
        spendable: U128,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefundDecision {
    Refunded,
    Denied { reason: RefundDenial },
}

/// `price * bps / 10000`, rounded down, without overflow.
pub const fn share_of(price: u128, bps: u16) -> u128 {
    let bps = bps as u128;
    price / BPS as u128 * bps + price % BPS as u128 * bps / BPS as u128
}

/// What each split account gets from a sale at `price`, and what the account keeps.
pub fn split(p: &Policy, price: u128) -> (Vec<(AccountId, u128)>, u128) {
    let shares: Vec<(AccountId, u128)> = p
        .split
        .iter()
        .map(|s| (s.account.clone(), share_of(price, s.bps)))
        .collect();
    let paid: u128 = shares.iter().map(|(_, a)| a).sum();
    (shares, price - paid)
}

#[near]
impl Pursestrings {
    /// The agent offers `item` at `price`. A price under the owner's floor is refused and the
    /// refusal is logged, however the agent was talked into it.
    pub fn quote(
        &mut self,
        buyer: Option<AccountId>,
        asset: Asset,
        price: U128,
        item: String,
    ) -> QuoteDecision {
        let agent = self.assert_agent();
        require!(price.0 > 0, "price must be positive");
        require!(item.len() <= MAX_PURPOSE_BYTES, "item too long");
        let now = now_s();
        let p = &self.policy;
        let denial = if p.frozen {
            Some(QuoteDenial::Frozen)
        } else if asset != Asset::Near {
            Some(QuoteDenial::NotForSale)
        } else {
            match p.floor(&asset) {
                None => Some(QuoteDenial::NotForSale),
                Some(floor) if price.0 < floor.0 => Some(QuoteDenial::BelowFloor { floor }),
                Some(_) if self.open_quotes >= MAX_OPEN_QUOTES => {
                    Some(QuoteDenial::TooManyOpenQuotes)
                }
                Some(_) => None,
            }
        };
        let decision = match denial {
            Some(reason) => QuoteDecision::Denied { reason },
            None => {
                let order_id = self.next_order_id;
                self.next_order_id += 1;
                self.open_quotes += 1;
                let expires_at = now + u64::from(p.pending_ttl_s);
                self.orders.insert(
                    order_id,
                    Order {
                        buyer: buyer.clone(),
                        asset: asset.clone(),
                        price,
                        item: item.clone(),
                        status: OrderStatus::Quoted,
                        quoted_at: now,
                        expires_at,
                        payer: None,
                        paid_at: None,
                        deliver_by: None,
                        held: U128(0),
                        refunded: U128(0),
                        receipt: None,
                    },
                );
                QuoteDecision::Quoted {
                    order_id,
                    expires_at,
                }
            }
        };
        Event::QuoteRequested {
            agent,
            buyer,
            asset,
            price,
            item,
            decision: decision.clone(),
        }
        .emit();
        decision
    }

    /// An empty `msg` is a plain deposit. Anything else is sent back in full: the shop sells
    /// in NEAR, where the contract can see its own balance and keep buyers' payments apart.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if msg.is_empty() {
            return PromiseOrValue::Value(U128(0));
        }
        Event::PaymentRefused {
            payer: sender_id,
            msg,
            reason: "the shop sells in NEAR only".to_string(),
        }
        .emit();
        PromiseOrValue::Value(amount)
    }

    /// NEAR payment for a quote. A deposit that doesn't pay it panics, which returns it.
    #[payable]
    pub fn pay(&mut self, order_id: u64) {
        let payer = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        if let Err(reason) = self.check_payment(order_id, &Asset::Near, &payer, amount) {
            env::panic_str(reason);
        }
        let price = self.orders.get(&order_id).expect("checked").price.0;
        // The order's storage must come from the account's own NEAR, not from what it holds for
        // other buyers; finished orders stay on the public ledger.
        let byte = env::storage_byte_cost().as_yoctonear();
        let stake = u128::from(env::storage_usage()) * byte;
        require!(
            env::account_balance().as_yoctonear() - amount
                >= stake + held_near() + ORDER_BYTES * byte,
            "the shop can't afford to store another order"
        );
        let change = amount - price;
        if change > 0 {
            Promise::new(payer.clone())
                .transfer(NearToken::from_yoctonear(change))
                .detach();
        }
        self.settle_sale(order_id, payer, change);
    }

    /// The agent records what it delivered, such as a hash or a link, and only then is the
    /// payment split. The contract can't check the receipt: holding the payment protects a
    /// buyer from an agent that never delivers, not from one that lies. Refused while frozen,
    /// so a stolen agent key can't mark orders delivered and end the buyers' reclaim.
    pub fn deliver(&mut self, order_id: u64, receipt: String) {
        self.assert_agent();
        require!(!self.policy.frozen, "frozen");
        require!(receipt.len() <= MAX_PURPOSE_BYTES, "receipt too long");
        let (shares, kept) = {
            let order = self.orders.get(&order_id).expect("unknown order");
            require!(order.status == OrderStatus::Paid, "not paid");
            split(&self.policy, order.held.0)
        };
        let order = self.orders.get_mut(&order_id).expect("unknown order");
        let paid = order.held.0;
        order.status = OrderStatus::Delivered;
        order.receipt = Some(receipt.clone());
        order.held = U128(kept);
        let asset = order.asset.clone();
        release(&asset, &order_key(order_id), paid);
        Event::Delivered {
            order_id,
            receipt,
            kept: U128(kept),
        }
        .emit();
        for (account, amount) in shares {
            if amount > 0 {
                self.pay_share(Some(order_id), account, asset.clone(), amount.into());
            }
        }
    }

    /// If the agent hasn't delivered by the deadline, the buyer takes the payment back
    /// themselves. Works while frozen, and doesn't count against the agent's refund window.
    pub fn reclaim(&mut self, order_id: u64) {
        let order = self.orders.get(&order_id).expect("unknown order").clone();
        require!(
            order.status == OrderStatus::Paid,
            "not paid or already delivered"
        );
        require!(
            order.payer.as_ref() == Some(&env::predecessor_account_id()),
            "only the buyer"
        );
        require!(
            order.deliver_by.is_some_and(|t| now_s() >= t),
            "the agent still has time to deliver"
        );
        self.pay_refund(order_id, &order, order.held, None);
        Event::Reclaimed {
            order_id,
            amount: order.held,
        }
        .emit();
    }

    /// Refunds go only to whoever paid, only from what the order still holds, and only within
    /// the owner's refund window for the asset.
    pub fn refund(&mut self, order_id: u64, amount: U128, reason: String) -> RefundDecision {
        self.assert_agent();
        require!(amount.0 > 0, "amount must be positive");
        require!(reason.len() <= MAX_PURPOSE_BYTES, "reason too long");
        let now = now_s();
        let order = self.orders.get(&order_id).expect("unknown order").clone();
        let denial = self.check_refund(&order, amount.0, now);
        let decision = match denial {
            Some(reason) => RefundDecision::Denied { reason },
            None => {
                let w = self
                    .policy
                    .refund_limit(&order.asset)
                    .expect("checked")
                    .clone();
                let key = UsageKey::Refund {
                    asset: order.asset.clone(),
                    period_s: w.period_s,
                };
                let mut ring = self.usage.get(&key).cloned().unwrap_or_default();
                let bucket = ring.add(w.period_s, now, amount.0);
                self.usage.insert(key, ring);
                self.pay_refund(order_id, &order, amount, Some(bucket));
                RefundDecision::Refunded
            }
        };
        Event::Refund {
            order_id,
            amount,
            reason,
            decision: decision.clone(),
        }
        .emit();
        decision
    }

    /// Anyone may drop expired quotes to free their slots.
    pub fn expire_quotes(&mut self, order_ids: Vec<u64>) {
        let now = now_s();
        for id in order_ids {
            if self
                .orders
                .get(&id)
                .is_some_and(|o| o.status == OrderStatus::Quoted && now >= o.expires_at)
            {
                self.orders.remove(&id);
                self.open_quotes -= 1;
            }
        }
    }

    /// Anyone may push a share that failed to pay out, for example before the account
    /// registered with the token.
    pub fn retry_payout(&mut self, account: AccountId, asset: Asset) {
        let key = (account.clone(), asset.clone());
        let amount = self.unpaid.remove(&key).expect("nothing owed");
        release(&asset, &payee_key(&account), amount.0);
        self.pay_share(None, account, asset, amount);
    }

    #[private]
    pub fn on_payout(
        &mut self,
        order_id: Option<u64>,
        account: AccountId,
        asset: Asset,
        amount: U128,
    ) {
        let ok = is_promise_success();
        if !ok {
            let key = (account.clone(), asset.clone());
            let owed = self.unpaid.get(&key).map_or(0, |a| a.0);
            self.unpaid.insert(key, U128(owed + amount.0));
            hold(&asset, &payee_key(&account), amount.0);
        }
        Event::Payout {
            order_id,
            account,
            asset,
            amount,
            ok,
        }
        .emit();
    }

    /// A failed refund puts the money back on the order, and back in the window if the agent
    /// gave it.
    #[private]
    pub fn on_refunded(
        &mut self,
        order_id: u64,
        amount: U128,
        bucket: Option<u64>,
        status: OrderStatus,
    ) {
        if is_promise_success() {
            return;
        }
        let o = self.orders.get_mut(&order_id).expect("unknown order");
        o.refunded = U128(o.refunded.0 - amount.0);
        o.held = U128(o.held.0 + amount.0);
        o.status = status;
        let asset = o.asset.clone();
        if status == OrderStatus::Paid {
            hold(&asset, &order_key(order_id), amount.0);
        }
        if let Some(bucket) = bucket
            && let Some(w) = self.policy.refund_limit(&asset)
        {
            let key = UsageKey::Refund {
                asset,
                period_s: w.period_s,
            };
            if let Some(ring) = self.usage.get_mut(&key) {
                ring.remove(bucket, amount.0);
            }
        }
        Event::RefundFailed { order_id, amount }.emit();
    }

    pub fn order(&self, order_id: u64) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }

    pub fn next_order_id(&self) -> u64 {
        self.next_order_id
    }

    /// Order ids in `[before - limit, before)`, newest first, skipping expired-and-dropped ones.
    pub fn recent_orders(&self, before: Option<u64>, limit: u32) -> Vec<(u64, Order)> {
        let end = before.unwrap_or(self.next_order_id).min(self.next_order_id);
        let start = end.saturating_sub(u64::from(limit.min(MAX_PAGE)));
        (start..end)
            .rev()
            .filter_map(|id| self.orders.get(&id).map(|o| (id, o.clone())))
            .collect()
    }

    /// NEAR held for buyers and for split shares still to pay out.
    pub fn owed_near(&self) -> U128 {
        U128(held_near())
    }

    /// What the owner could withdraw, or an agent spend, right now.
    pub fn spendable(&self) -> U128 {
        U128(self.spendable_near())
    }

    pub fn unpaid(&self, account: AccountId, asset: Asset) -> U128 {
        self.unpaid
            .get(&(account, asset))
            .copied()
            .unwrap_or(U128(0))
    }
}

impl Pursestrings {
    pub(crate) fn check_payment(
        &self,
        order_id: u64,
        asset: &Asset,
        payer: &AccountId,
        amount: u128,
    ) -> Result<(), &'static str> {
        if self.policy.frozen {
            return Err("frozen");
        }
        let order = self.orders.get(&order_id).ok_or("unknown order")?;
        if order.status != OrderStatus::Quoted {
            return Err("already paid");
        }
        if now_s() >= order.expires_at {
            return Err("quote expired");
        }
        if &order.asset != asset {
            return Err("wrong token");
        }
        if order.buyer.as_ref().is_some_and(|b| b != payer) {
            return Err("quote is for another buyer");
        }
        if amount < order.price.0 {
            return Err("less than the price");
        }
        Ok(())
    }

    fn check_refund(
        &self,
        order: &crate::sales::Order,
        amount: u128,
        now: u64,
    ) -> Option<RefundDenial> {
        if self.policy.frozen {
            return Some(RefundDenial::Frozen);
        }
        if !matches!(order.status, OrderStatus::Paid | OrderStatus::Delivered) {
            return Some(RefundDenial::NotPaid);
        }
        if amount > order.held.0 {
            return Some(RefundDenial::OverHeld { max: order.held });
        }
        if order.status == OrderStatus::Paid && amount != order.held.0 {
            return Some(RefundDenial::NotWhole { held: order.held });
        }
        // After delivery the kept share is the owner's, who may have withdrawn it: a refund
        // then mustn't come out of what other buyers' orders hold.
        if order.status == OrderStatus::Delivered
            && order.asset == Asset::Near
            && amount > self.spendable_near()
        {
            return Some(RefundDenial::HeldForOthers {
                spendable: U128(self.spendable_near()),
            });
        }
        let Some(w) = self.policy.refund_limit(&order.asset) else {
            return Some(RefundDenial::NoRefundLimit);
        };
        let used = self.used(
            &UsageKey::Refund {
                asset: order.asset.clone(),
                period_s: w.period_s,
            },
            w.period_s,
            now,
        );
        if used.saturating_add(amount) > w.limit.0 {
            return Some(RefundDenial::OverWindow {
                period_s: w.period_s,
                remaining: U128(w.limit.0.saturating_sub(used)),
            });
        }
        None
    }

    /// Marks the quote paid and holds the payment until delivery. `change` went back to the
    /// payer.
    fn settle_sale(&mut self, order_id: u64, payer: AccountId, change: u128) {
        let now = now_s();
        let deliver_by = now + u64::from(self.policy.delivery_s);
        let o = self.orders.get_mut(&order_id).expect("unknown order");
        o.status = OrderStatus::Paid;
        o.payer = Some(payer.clone());
        o.paid_at = Some(now);
        o.deliver_by = Some(deliver_by);
        o.held = o.price;
        let (asset, price) = (o.asset.clone(), o.price);
        hold(&asset, &order_key(order_id), price.0);
        self.open_quotes -= 1;
        Event::Sale {
            order_id,
            payer,
            asset,
            price,
            change: U128(change),
            deliver_by,
        }
        .emit();
    }

    /// Sends `amount` of what the order holds back to its payer. Emptying an undelivered
    /// order marks it refunded.
    fn pay_refund(&mut self, order_id: u64, order: &Order, amount: U128, bucket: Option<u64>) {
        let o = self.orders.get_mut(&order_id).expect("unknown order");
        let status = o.status;
        o.held = U128(o.held.0 - amount.0);
        o.refunded = U128(o.refunded.0 + amount.0);
        if o.status == OrderStatus::Paid && o.held.0 == 0 {
            o.status = OrderStatus::Refunded;
        }
        if status == OrderStatus::Paid {
            release(&order.asset, &order_key(order_id), amount.0);
        }
        let payer = order.payer.clone().expect("paid");
        self.transfer(
            &order.asset,
            &payer,
            amount,
            format!("pursestrings:refund:{order_id}"),
        )
        .then(
            Self::ext(env::current_account_id())
                .with_static_gas(PAYOUT_CALLBACK_GAS)
                .on_refunded(order_id, amount, bucket, status),
        )
        .detach();
    }

    fn pay_share(&self, order_id: Option<u64>, account: AccountId, asset: Asset, amount: U128) {
        let memo = order_id.map_or_else(
            || "pursestrings:share".to_string(),
            |id| format!("pursestrings:sale:{id}"),
        );
        self.transfer(&asset, &account, amount, memo)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(PAYOUT_CALLBACK_GAS)
                    .on_payout(order_id, account, asset, amount),
            )
            .detach();
    }
}

#[cfg(test)]
mod tests {
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    use super::*;
    use crate::policy::tests::{base_policy, usdc};
    use crate::policy::{PriceFloor, RefundLimit, Share, WindowLimit};
    use crate::spend::tests::{as_agent, contract};

    fn buyer() -> AccountId {
        "buyer.near".parse().unwrap()
    }

    fn shop() -> Pursestrings {
        let mut p = base_policy();
        p.floors.push(PriceFloor {
            asset: Asset::Near,
            min: U128(2_000_000),
        });
        p.split = vec![
            Share {
                account: "owner.near".parse().unwrap(),
                bps: 7_000,
            },
            Share {
                account: "dao.near".parse().unwrap(),
                bps: 2_000,
            },
        ];
        p.refund_limits.push(RefundLimit {
            asset: Asset::Near,
            window: WindowLimit {
                period_s: 86_400,
                limit: U128(300_000),
            },
        });
        contract(p)
    }

    fn quote(c: &mut Pursestrings, price: u128) -> QuoteDecision {
        as_agent(1_000);
        c.quote(Some(buyer()), Asset::Near, U128(price), "report".into())
    }

    fn fails(f: impl FnOnce()) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
    }

    /// Pays `order` with `amount` yoctoNEAR from `who`; false if the payment was refused and
    /// so returned.
    fn pay_as(c: &mut Pursestrings, who: &str, amount: u128, order: u64, now_s: u64) -> bool {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id("purse.near".parse().unwrap())
                .predecessor_account_id(who.parse().unwrap())
                .attached_deposit(NearToken::from_yoctonear(amount))
                .block_timestamp(now_s * 1_000_000_000)
                .build()
        );
        !fails(|| c.pay(order))
    }

    fn pay(c: &mut Pursestrings, amount: u128, order: u64, now_s: u64) -> bool {
        pay_as(c, "buyer.near", amount, order, now_s)
    }

    #[test]
    fn the_floor_holds_however_the_agent_was_talked_down() {
        let mut c = shop();
        assert_eq!(
            quote(&mut c, 1_999_999),
            QuoteDecision::Denied {
                reason: QuoteDenial::BelowFloor {
                    floor: U128(2_000_000)
                }
            }
        );
        assert!(matches!(
            quote(&mut c, 2_000_000),
            QuoteDecision::Quoted { order_id: 0, .. }
        ));
        as_agent(1_000);
        let token = c.quote(None, usdc(), U128(1), "report".into());
        assert_eq!(
            token,
            QuoteDecision::Denied {
                reason: QuoteDenial::NotForSale
            }
        );
        c.policy.frozen = true;
        assert_eq!(
            quote(&mut c, 3_000_000),
            QuoteDecision::Denied {
                reason: QuoteDenial::Frozen
            }
        );
    }

    #[test]
    fn a_payment_is_held_until_delivery_then_split() {
        let mut c = shop();
        quote(&mut c, 2_500_000);
        assert!(
            pay(&mut c, 2_600_000, 0, 1_010),
            "overpaid: change goes back"
        );
        let o = c.order(0).unwrap();
        assert_eq!(o.status, OrderStatus::Paid);
        assert_eq!(o.payer, Some(buyer()));
        assert_eq!(o.held, U128(2_500_000), "nothing shared before delivery");
        assert_eq!(o.deliver_by, Some(1_010 + 600));
        assert_eq!(c.open_quotes, 0);
        assert!(!pay(&mut c, 2_500_000, 0, 1_020), "paid twice");
        as_agent(1_030);
        c.deliver(0, "sha256:abc".into());
        let o = c.order(0).unwrap();
        assert_eq!(o.status, OrderStatus::Delivered);
        assert_eq!(o.held, U128(250_000), "10% kept after 70% + 20%");
    }

    #[test]
    fn held_near_is_out_of_reach_until_delivery() {
        let mut c = shop();
        c.policy.assets.push(crate::policy::AssetRule {
            asset: Asset::Near,
            per_tx_cap: U128(u128::MAX),
            windows: vec![],
            cosign_above: None,
            risk_check_above: None,
        });
        c.policy.recipients.push(crate::types::Recipient::Near {
            account: "vendor.near".parse().unwrap(),
        });
        quote(&mut c, 2_500_000);
        pay(&mut c, 2_500_000, 0, 1_010);
        assert_eq!(c.owed_near(), U128(2_500_000));
        testing_env!(
            VMContextBuilder::new()
                .current_account_id("purse.near".parse().unwrap())
                .predecessor_account_id("owner.near".parse().unwrap())
                .attached_deposit(NearToken::from_yoctonear(1))
                .account_balance(NearToken::from_near(10))
                .block_timestamp(1_020 * 1_000_000_000)
                .build()
        );
        let spendable = c.spendable_near();
        assert_eq!(
            spendable,
            env::account_balance().as_yoctonear() - reserve(&c) - 2_500_000
        );
        assert!(
            fails(|| drop(c.withdraw(Asset::Near, U128(spendable + 1)))),
            "the owner can't take it"
        );
        drop(c.withdraw(Asset::Near, U128(spendable)));
        as_agent(1_030);
        let spend = |amount: u128| crate::types::SpendRequest {
            asset: Asset::Near,
            amount: U128(amount),
            dest: crate::types::Dest::Near {
                account: "vendor.near".parse().unwrap(),
            },
            purpose: "costs".into(),
            idempotency_key: format!("k{amount}"),
            bounty: None,
        };
        let need = c.spendable_near() + 1;
        assert!(
            matches!(
                c.request_spend(spend(need)),
                crate::types::Decision::Denied {
                    reason: crate::types::DenyReason::HeldForOthers { .. }
                }
            ),
            "nor can the agent"
        );
        c.policy.frozen = true;
        assert!(
            fails(|| c.deliver(0, "junk".into())),
            "a stolen key can't deliver while frozen"
        );
        c.policy.frozen = false;
        c.deliver(0, "sha256:abc".into());
        assert_eq!(c.owed_near(), U128(0), "delivered: the split is paid out");
    }

    fn at(who: &str, balance: Option<u128>, failed: bool) {
        let mut b = VMContextBuilder::new();
        b.current_account_id("purse.near".parse().unwrap())
            .predecessor_account_id(who.parse().unwrap())
            .signer_account_pk(crate::spend::tests::agent_pk())
            .attached_deposit(NearToken::from_yoctonear(u128::from(who == "owner.near")))
            .block_timestamp(1_100 * 1_000_000_000);
        if let Some(balance) = balance {
            b.account_balance(NearToken::from_yoctonear(balance));
        }
        let results = if failed {
            vec![near_sdk::PromiseResult::Failed]
        } else {
            vec![]
        };
        testing_env!(
            b.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }

    /// The storage stake, the agents' gas allowances and the free quote slots' storage.
    fn reserve(c: &Pursestrings) -> u128 {
        let byte = env::storage_byte_cost().as_yoctonear();
        let gas: u128 = c.agents.values().map(|a| a.allowance.0).sum();
        u128::from(env::storage_usage()) * byte
            + gas
            + u128::from(MAX_OPEN_QUOTES - c.open_quotes) * ORDER_BYTES * byte
    }

    #[test]
    fn agent_gas_and_free_quote_slots_are_set_aside() {
        let mut c = shop();
        at("owner.near", None, false);
        let before = c.spendable_near();
        let key: near_sdk::PublicKey = "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847"
            .parse()
            .unwrap();
        drop(c.add_agent(key.clone(), U128(10u128.pow(24))));
        assert_eq!(
            before - c.spendable_near(),
            10u128.pow(24),
            "a new key's gas allowance is set aside: it signs as this account"
        );
        drop(c.revoke_agent(key));
        assert_eq!(c.spendable_near(), before);
        quote(&mut c, 2_000_000);
        at("owner.near", None, false);
        let slot = ORDER_BYTES * env::storage_byte_cost().as_yoctonear();
        assert!(
            c.spendable_near() + slot >= before,
            "an open quote uses up one reserved slot's worth of stake"
        );
        let selling = c.spendable_near();
        c.policy.floors.clear();
        assert_eq!(
            c.spendable_near() - selling,
            u128::from(MAX_OPEN_QUOTES - c.open_quotes) * slot,
            "an account that doesn't sell keeps no quote slots"
        );
    }

    #[test]
    fn a_payment_is_refused_if_the_shop_cant_store_the_order() {
        let mut c = shop();
        quote(&mut c, 2_000_000);
        let ctx = |balance: u128| {
            testing_env!(
                VMContextBuilder::new()
                    .current_account_id("purse.near".parse().unwrap())
                    .predecessor_account_id(buyer())
                    .attached_deposit(NearToken::from_yoctonear(2_000_000))
                    .account_balance(NearToken::from_yoctonear(balance))
                    .block_timestamp(1_010 * 1_000_000_000)
                    .build()
            );
        };
        ctx(0);
        let byte = env::storage_byte_cost().as_yoctonear();
        let need = u128::from(env::storage_usage()) * byte + ORDER_BYTES * byte;
        ctx(need - 1);
        assert!(
            fails(|| c.pay(0)),
            "storing it would come out of other buyers' payments"
        );
        ctx(need);
        c.pay(0);
        assert_eq!(c.order(0).unwrap().status, OrderStatus::Paid);
    }

    #[test]
    fn migrating_counts_what_old_code_left_untracked() {
        let mut c = shop();
        quote(&mut c, 2_000_000);
        pay(&mut c, 2_000_000, 0, 1_010);
        let dao: AccountId = "dao.near".parse().unwrap();
        c.unpaid.insert((dao.clone(), Asset::Near), U128(300_000));
        env::storage_remove(&order_key(0));
        env::storage_remove(OWED_NEAR);
        assert_eq!(c.owed_near(), U128(0), "as the old code left it");
        c.orders.flush();
        c.unpaid.flush();
        env::state_write(&c);
        let mut c = Pursestrings::migrate();
        assert_eq!(c.owed_near(), U128(2_300_000));
        c.recount_held();
        assert_eq!(
            c.owed_near(),
            U128(2_300_000),
            "running it twice changes nothing"
        );
        at("anyone.near", None, false);
        c.retry_payout(dao, Asset::Near);
        assert_eq!(c.owed_near(), U128(2_000_000));
    }

    #[test]
    fn failed_payouts_and_refunds_stay_held() {
        let mut c = shop();
        quote(&mut c, 2_500_000);
        pay(&mut c, 2_500_000, 0, 1_010);
        as_agent(1_020);
        c.deliver(0, "sha256:abc".into());
        assert_eq!(c.owed_near(), U128(0));
        let dao: AccountId = "dao.near".parse().unwrap();
        at("purse.near", None, true);
        c.on_payout(Some(0), dao.clone(), Asset::Near, U128(500_000));
        assert_eq!(
            c.owed_near(),
            U128(500_000),
            "the DAO's unpaid share is held"
        );
        assert_eq!(c.unpaid(dao.clone(), Asset::Near), U128(500_000));
        at("anyone.near", None, false);
        c.retry_payout(dao, Asset::Near);
        assert_eq!(c.owed_near(), U128(0));

        c.policy.refund_limits[0].window.limit = U128(2_000_000);
        quote(&mut c, 2_000_000);
        pay(&mut c, 2_000_000, 1, 1_030);
        as_agent(1_040);
        assert_eq!(
            c.refund(1, U128(2_000_000), "x".into()),
            RefundDecision::Refunded
        );
        assert_eq!(c.owed_near(), U128(0));
        at("purse.near", None, true);
        c.on_refunded(1, U128(2_000_000), None, OrderStatus::Paid);
        assert_eq!(
            c.owed_near(),
            U128(2_000_000),
            "the refund bounced: held again"
        );
        assert_eq!(c.order(1).unwrap().status, OrderStatus::Paid);
    }

    #[test]
    fn an_order_paid_before_tracking_releases_nothing_newer_orders_hold() {
        let mut c = shop();
        quote(&mut c, 2_000_000);
        quote(&mut c, 3_000_000);
        pay(&mut c, 3_000_000, 1, 1_010);
        let legacy = c.orders.get_mut(&0).unwrap();
        legacy.status = OrderStatus::Paid;
        legacy.payer = Some(buyer());
        legacy.held = legacy.price;
        legacy.deliver_by = Some(1_610);
        c.open_quotes -= 1;
        as_agent(1_020);
        c.deliver(0, "sha256:old".into());
        assert_eq!(
            c.owed_near(),
            U128(3_000_000),
            "order 1 is still held in full"
        );
    }

    #[test]
    fn approving_a_waiting_spend_rechecks_held_near() {
        let mut c = shop();
        c.policy.assets.push(crate::policy::AssetRule {
            asset: Asset::Near,
            per_tx_cap: U128(u128::MAX),
            windows: vec![],
            cosign_above: Some(U128(1)),
            risk_check_above: None,
        });
        c.policy.recipients.push(crate::types::Recipient::Near {
            account: "vendor.near".parse().unwrap(),
        });
        as_agent(1_000);
        let d = c.request_spend(crate::types::SpendRequest {
            asset: Asset::Near,
            amount: U128(1_000_000),
            dest: crate::types::Dest::Near {
                account: "vendor.near".parse().unwrap(),
            },
            purpose: "costs".into(),
            idempotency_key: "k".into(),
            bounty: None,
        });
        assert!(matches!(d, crate::types::Decision::NeedsCosign { .. }));
        quote(&mut c, 2_000_000);
        pay(&mut c, 2_000_000, 0, 1_010);
        at("owner.near", None, false);
        // The owner's attached yoctoNEAR is part of the balance during the call.
        let tight = reserve(&c) + 2_000_000 + 999_998;
        at("owner.near", Some(tight), false);
        assert!(
            fails(|| c.approve_request(0)),
            "approving would spend the buyer's payment"
        );
        at("owner.near", Some(tight + 1), false);
        c.approve_request(0);
    }

    #[test]
    fn a_refund_after_delivery_cant_dip_into_other_buyers_payments() {
        let mut c = shop();
        quote(&mut c, 2_500_000);
        pay(&mut c, 2_500_000, 0, 1_010);
        as_agent(1_020);
        c.deliver(0, "sha256:abc".into());
        quote(&mut c, 2_000_000);
        pay(&mut c, 2_000_000, 1, 1_030);
        at("purse.near", None, false);
        let withdrawn = reserve(&c) + 2_000_000;
        at("purse.near", Some(withdrawn), false);
        assert_eq!(
            c.refund(0, U128(250_000), "x".into()),
            RefundDecision::Denied {
                reason: RefundDenial::HeldForOthers { spendable: U128(0) }
            },
            "the owner took the kept share; the rest is order 1's"
        );
        at("purse.near", Some(withdrawn + 250_000), false);
        assert_eq!(
            c.refund(0, U128(250_000), "x".into()),
            RefundDecision::Refunded
        );
    }

    #[test]
    fn token_floors_are_refused_and_old_ones_sell_nothing_or_block_a_freeze() {
        let mut c = shop();
        let floor = PriceFloor {
            asset: usdc(),
            min: U128(1),
        };
        let mut p = c.policy.clone();
        assert!(fails(|| crate::policy::apply(
            crate::policy::PolicyOp::SetPriceFloor(floor.clone()),
            &mut p
        )));
        c.policy.floors.push(floor);
        as_agent(1_000);
        assert_eq!(
            c.quote(None, usdc(), U128(5), "x".into()),
            QuoteDecision::Denied {
                reason: QuoteDenial::NotForSale
            }
        );
        at("owner.near", None, false);
        c.freeze();
        assert!(c.policy.frozen);
    }

    #[test]
    fn the_buyer_takes_an_undelivered_payment_back() {
        let mut c = shop();
        quote(&mut c, 2_000_000);
        pay(&mut c, 2_000_000, 0, 1_010);
        let reclaim = |c: &mut Pursestrings, who: &str, now_s: u64| {
            testing_env!(
                VMContextBuilder::new()
                    .current_account_id("purse.near".parse().unwrap())
                    .predecessor_account_id(who.parse().unwrap())
                    .block_timestamp(now_s * 1_000_000_000)
                    .build()
            );
            !fails(|| c.reclaim(0))
        };
        assert!(
            !reclaim(&mut c, "buyer.near", 1_100),
            "the agent still has time"
        );
        assert!(!reclaim(&mut c, "other.near", 1_700), "only the buyer");
        c.policy.frozen = true;
        assert!(reclaim(&mut c, "buyer.near", 1_700), "works while frozen");
        let o = c.order(0).unwrap();
        assert_eq!(o.status, OrderStatus::Refunded);
        assert_eq!((o.held, o.refunded), (U128(0), U128(2_000_000)));
        assert_eq!(c.owed_near(), U128(0));
        c.policy.frozen = false;
        as_agent(1_800);
        assert!(
            fails(|| c.deliver(0, "late".into())),
            "nothing left to deliver against"
        );
    }

    #[test]
    fn bad_payments_are_returned_in_full() {
        let mut c = shop();
        quote(&mut c, 2_000_000);
        assert!(!pay(&mut c, 1_999_999, 0, 1_010), "short");
        assert!(!pay(&mut c, 2_000_000, 9, 1_010), "unknown order");
        assert!(
            !pay_as(&mut c, "other.near", 2_000_000, 0, 1_010),
            "someone else's quote"
        );
        assert!(!pay(&mut c, 2_000_000, 0, 1_000 + 3_600), "expired");
        c.policy.frozen = true;
        assert!(!pay(&mut c, 2_000_000, 0, 1_010), "frozen");
        c.policy.frozen = false;
        assert!(pay(&mut c, 2_000_000, 0, 1_010));
        testing_env!(
            VMContextBuilder::new()
                .current_account_id("purse.near".parse().unwrap())
                .predecessor_account_id("usdc.test.near".parse().unwrap())
                .build()
        );
        let refund = |c: &mut Pursestrings, msg: &str| match c.ft_on_transfer(
            buyer(),
            U128(5),
            msg.into(),
        ) {
            PromiseOrValue::Value(v) => v.0,
            PromiseOrValue::Promise(_) => unreachable!(),
        };
        assert_eq!(refund(&mut c, "0"), 5, "the shop sells in NEAR only");
        assert_eq!(refund(&mut c, ""), 0, "a plain token deposit is kept");
    }

    #[test]
    fn refunds_go_to_the_payer_from_what_is_held_within_the_window() {
        let mut c = shop();
        c.policy.refund_limits[0].window.limit = U128(2_100_000);
        quote(&mut c, 2_000_000);
        pay(&mut c, 2_000_000, 0, 1_010);
        as_agent(1_020);
        assert_eq!(
            c.refund(0, U128(1_900_000), "a discount".into()),
            RefundDecision::Denied {
                reason: RefundDenial::NotWhole {
                    held: U128(2_000_000)
                }
            },
            "a partial refund before delivery would sell the check under the floor"
        );
        assert_eq!(
            c.refund(0, U128(2_000_000), "can't do it".into()),
            RefundDecision::Refunded,
            "in full before delivery"
        );
        assert_eq!(c.order(0).unwrap().status, OrderStatus::Refunded);
        quote(&mut c, 2_000_000);
        pay(&mut c, 2_000_000, 1, 1_030);
        as_agent(1_040);
        c.deliver(1, "sha256:def".into());
        assert_eq!(
            c.refund(1, U128(200_001), "unhappy".into()),
            RefundDecision::Denied {
                reason: RefundDenial::OverHeld { max: U128(200_000) }
            },
            "after delivery only the kept 10%"
        );
        assert_eq!(
            c.refund(1, U128(200_000), "unhappy".into()),
            RefundDecision::Denied {
                reason: RefundDenial::OverWindow {
                    period_s: 86_400,
                    remaining: U128(100_000)
                }
            },
            "the full refund used most of the window"
        );
        assert_eq!(
            c.refund(1, U128(100_000), "unhappy".into()),
            RefundDecision::Refunded
        );
        c.policy.refund_limits.clear();
        assert_eq!(
            c.refund(1, U128(1), "x".into()),
            RefundDecision::Denied {
                reason: RefundDenial::NoRefundLimit
            }
        );
    }

    #[test]
    fn open_quotes_are_capped_and_expire() {
        let mut c = shop();
        for _ in 0..MAX_OPEN_QUOTES {
            assert!(matches!(
                quote(&mut c, 2_000_000),
                QuoteDecision::Quoted { .. }
            ));
        }
        assert_eq!(
            quote(&mut c, 2_000_000),
            QuoteDecision::Denied {
                reason: QuoteDenial::TooManyOpenQuotes
            }
        );
        as_agent(1_000 + 3_600);
        c.expire_quotes(vec![0, 1]);
        assert_eq!(c.open_quotes, MAX_OPEN_QUOTES - 2);
        assert!(c.order(0).is_none());
    }

    #[test]
    fn shares_round_down_and_never_exceed_the_price() {
        assert_eq!(share_of(1, 9_999), 0);
        assert_eq!(share_of(10_001, 5_000), 5_000);
        assert_eq!(share_of(u128::MAX, 10_000), u128::MAX);
        let mut p = base_policy();
        p.split = vec![
            Share {
                account: "a.near".parse().unwrap(),
                bps: 3_333,
            },
            Share {
                account: "b.near".parse().unwrap(),
                bps: 6_667,
            },
        ];
        for price in [1, 7, 9_999, 10_001, 123_456_789] {
            let (shares, kept) = split(&p, price);
            assert_eq!(shares.iter().map(|(_, a)| a).sum::<u128>() + kept, price);
        }
    }
}

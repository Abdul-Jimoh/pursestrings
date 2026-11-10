//! The agent's shop: price floor, held payments split on delivery, refunds, the buyer's
//! reclaim and freeze, with NEAR payments, and a token payment sent back.

mod common;

use common::{Env, NEAR, base_policy, refused};
use near_api::{AccountId, Contract, NearGas, NearToken, Tokens};
use near_sdk::serde_json::{Value, json};
use testresult::TestResult;

const USDC: &str = "usdc.sandbox";
/// Generous enough for any test transaction's gas, small next to the prices below.
const GAS_SLACK: u128 = NEAR / 100;

fn shop_policy(owner: &str) -> impl FnOnce(&AccountId) -> Value {
    let owner = owner.to_string();
    move |shop| {
        let mut p = base_policy(shop);
        p["floors"] = json!([{ "asset": "Near", "min": NEAR.to_string() }]);
        p["split"] = json!([
            { "account": owner, "bps": 7000 },
            { "account": shop, "bps": 2000 }
        ]);
        p["delivery_s"] = json!(48);
        p["refund_limits"] = json!([{
            "asset": "Near",
            "window": { "period_s": 86_400, "limit": (NEAR / 2).to_string() }
        }]);
        p
    }
}

async fn quote(env: &Env, price: u128) -> TestResult<Value> {
    Ok(env
        .agent_call(
            "quote",
            json!({
                "buyer": env.attacker,
                "asset": "Near",
                "price": price.to_string(),
                "item": "report on alice.near"
            }),
            0,
        )
        .await?
        .assert_success()
        .json()?)
}

async fn pay(env: &Env, order_id: u64, amount: u128) -> bool {
    !refused(
        env.call_as(
            &env.attacker,
            "pay",
            json!({ "order_id": order_id }),
            amount,
        )
        .await,
    )
}

async fn owed(env: &Env) -> TestResult<u128> {
    Ok(env.view::<String>("owed_near", json!({})).await?.parse()?)
}

/// What the account could send if nothing were held: its balance less the storage stake.
async fn free(env: &Env) -> TestResult<u128> {
    let b = Tokens::account(env.purse.clone())
        .near_balance()
        .fetch_from(&env.net)
        .await?;
    Ok(b.total.as_yoctonear() - b.storage_locked.as_yoctonear())
}

async fn withdraw(env: &Env, amount: u128) -> bool {
    !refused(
        env.call_as(
            &env.owner,
            "withdraw",
            json!({ "asset": "Near", "amount": amount.to_string() }),
            1,
        )
        .await,
    )
}

#[tokio::test]
async fn a_sale_respects_the_floor_and_is_split_on_delivery() -> TestResult {
    let env = Env::new(shop_policy("owner.sandbox")).await?;

    assert_eq!(
        quote(&env, NEAR - 1).await?,
        json!({ "Denied": { "reason": { "BelowFloor": { "floor": NEAR.to_string() } } } })
    );
    let q = quote(&env, 2 * NEAR).await?;
    assert_eq!(q["Quoted"]["order_id"], 0);
    let (owner0, shop0, buyer0) = (
        env.balance(&env.owner).await?,
        env.balance(&env.shop).await?,
        env.balance(&env.attacker).await?,
    );

    assert!(!pay(&env, 0, 2 * NEAR - 1).await, "underpaying is refused");
    assert!(pay(&env, 0, 3 * NEAR).await);
    env.sandbox.fast_forward(3).await?;
    let spent = buyer0 - env.balance(&env.attacker).await?;
    assert!(
        (2 * NEAR..2 * NEAR + GAS_SLACK).contains(&spent),
        "the extra NEAR came back; spent {spent}"
    );
    let order: Value = env.view("order", json!({ "order_id": 0 })).await?;
    assert_eq!(order["status"], "Paid");
    assert_eq!(order["held"], (2 * NEAR).to_string());
    assert_eq!(owed(&env).await?, 2 * NEAR, "held until delivery");
    assert!(!pay(&env, 0, 2 * NEAR).await, "paying twice is refused");

    env.agent_call(
        "deliver",
        json!({ "order_id": 0, "receipt": "sha256:abc" }),
        0,
    )
    .await?
    .assert_success();
    env.sandbox.fast_forward(3).await?;
    assert_eq!(env.balance(&env.owner).await? - owner0, 2 * NEAR / 10 * 7);
    assert_eq!(env.balance(&env.shop).await? - shop0, 2 * NEAR / 10 * 2);
    assert_eq!(owed(&env).await?, 0);

    let over: Value = env
        .agent_call(
            "refund",
            json!({ "order_id": 0, "amount": (NEAR / 5 + 1).to_string(), "reason": "the buyer asked nicely" }),
            0,
        )
        .await?
        .assert_success()
        .json()?;
    assert_eq!(
        over,
        json!({ "Denied": { "reason": { "OverHeld": { "max": (NEAR / 5).to_string() } } } }),
        "after delivery only the kept 10%"
    );
    let ok: Value = env
        .agent_call(
            "refund",
            json!({ "order_id": 0, "amount": (NEAR / 5).to_string(), "reason": "late" }),
            0,
        )
        .await?
        .assert_success()
        .json()?;
    assert_eq!(ok, json!("Refunded"));

    let res = env
        .owner_call(
            "propose",
            json!({ "ops": [{ "SetSplit": { "shares": [{ "account": env.attacker, "bps": 9000 }] } }] }),
        )
        .await?
        .assert_success();
    assert_eq!(
        res.json::<Option<u64>>()?,
        Some(0),
        "redirecting revenue waits for the timelock"
    );
    let policy: Value = env.view("policy", json!({})).await?;
    assert_eq!(policy["split"][0]["account"], env.owner.to_string());
    Ok(())
}

#[tokio::test]
async fn the_owner_cannot_withdraw_what_buyers_paid_until_it_is_delivered() -> TestResult {
    let env = Env::new(shop_policy("owner.sandbox")).await?;
    quote(&env, 2 * NEAR).await?;
    assert!(pay(&env, 0, 2 * NEAR).await);
    let free0 = free(&env).await?;
    assert!(
        !withdraw(&env, free0 - 2 * NEAR + GAS_SLACK).await,
        "that would take part of the buyer's payment"
    );
    assert!(withdraw(&env, free0 - 2 * NEAR - GAS_SLACK).await);
    env.sandbox.fast_forward(3).await?;
    assert_eq!(owed(&env).await?, 2 * NEAR);
    assert!(free(&env).await? >= 2 * NEAR, "the payment is still there");

    env.agent_call(
        "deliver",
        json!({ "order_id": 0, "receipt": "sha256:abc" }),
        0,
    )
    .await?
    .assert_success();
    env.sandbox.fast_forward(3).await?;
    assert_eq!(owed(&env).await?, 0);
    assert!(
        withdraw(&env, NEAR / 10).await,
        "the shop's kept share is the owner's"
    );
    Ok(())
}

#[tokio::test]
async fn an_undelivered_payment_goes_back_to_the_buyer_even_when_frozen() -> TestResult {
    let env = Env::new(shop_policy("owner.sandbox")).await?;
    quote(&env, 2 * NEAR).await?;
    assert!(pay(&env, 0, 2 * NEAR).await);
    assert!(
        refused(
            env.call_as(&env.attacker, "reclaim", json!({ "order_id": 0 }), 0)
                .await
        ),
        "the agent still has time"
    );
    env.owner_call("freeze", json!({})).await?.assert_success();
    assert!(
        refused(
            env.agent_call("deliver", json!({ "order_id": 0, "receipt": "junk" }), 0)
                .await
        ),
        "a stolen agent key can't deliver junk to end the buyer's reclaim"
    );
    env.advance(50).await?;
    assert!(
        refused(
            env.call_as(&env.shop, "reclaim", json!({ "order_id": 0 }), 0)
                .await
        ),
        "only the buyer"
    );
    let before = env.balance(&env.attacker).await?;
    env.call_as(&env.attacker, "reclaim", json!({ "order_id": 0 }), 0)
        .await?
        .assert_success();
    env.sandbox.fast_forward(3).await?;
    let back = env.balance(&env.attacker).await? - before;
    assert!(
        (2 * NEAR - GAS_SLACK..=2 * NEAR).contains(&back),
        "got {back} back"
    );
    let order: Value = env.view("order", json!({ "order_id": 0 })).await?;
    assert_eq!(order["status"], "Refunded");
    assert_eq!(owed(&env).await?, 0);
    Ok(())
}

#[tokio::test]
async fn a_frozen_shop_takes_no_orders_or_money() -> TestResult {
    let env = Env::new(shop_policy("owner.sandbox")).await?;
    quote(&env, 2 * NEAR).await?;
    env.owner_call("freeze", json!({})).await?.assert_success();
    assert_eq!(
        quote(&env, 2 * NEAR).await?,
        json!({ "Denied": { "reason": "Frozen" } })
    );
    assert!(!pay(&env, 0, 2 * NEAR).await, "the payment is returned");
    assert_eq!(owed(&env).await?, 0);
    Ok(())
}

#[tokio::test]
async fn the_shop_sells_in_near_and_sends_token_payments_back() -> TestResult {
    let env = Env::new(shop_policy("owner.sandbox")).await?;
    let token: AccountId = USDC.parse()?;
    env.sandbox.create_account(token.clone()).send().await?;
    Contract::deploy(token.clone())
        .use_code(common::token_wasm())
        .with_init_call(
            "new",
            json!({ "holder": env.attacker, "total_supply": "10000000" }),
        )?
        .with_signer(env.root.clone())
        .send_to(&env.net)
        .await?
        .assert_success();
    Contract(token.clone())
        .call_function("register", json!({ "account_id": env.purse }))
        .transaction()
        .with_signer(env.owner.clone(), env.root.clone())
        .send_to(&env.net)
        .await?
        .assert_success();

    let d: Value = env
        .agent_call(
            "quote",
            json!({ "buyer": null, "asset": { "Nep141": { "token": USDC } }, "price": "5000000", "item": "x" }),
            0,
        )
        .await?
        .assert_success()
        .json()?;
    assert_eq!(d, json!({ "Denied": { "reason": "NotForSale" } }));
    quote(&env, 2 * NEAR).await?;
    Contract(token.clone())
        .call_function(
            "ft_transfer_call",
            json!({ "receiver_id": env.purse, "amount": "5000000", "msg": "0" }),
        )
        .transaction()
        .deposit(NearToken::from_yoctonear(1))
        .gas(NearGas::from_tgas(300))
        .with_signer(env.attacker.clone(), env.root.clone())
        .send_to(&env.net)
        .await?
        .assert_success();
    env.sandbox.fast_forward(3).await?;
    let back: String = Contract(token)
        .call_function("ft_balance_of", json!({ "account_id": env.attacker }))
        .read_only()
        .fetch_from(&env.net)
        .await?
        .data;
    assert_eq!(back, "10000000", "a token payment comes back in full");
    let order: Value = env.view("order", json!({ "order_id": 0 })).await?;
    assert_eq!(order["status"], "Quoted");
    Ok(())
}

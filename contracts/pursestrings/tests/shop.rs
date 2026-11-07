//! The agent's shop: price floor, held payments split on delivery, refunds, the buyer's
//! reclaim and freeze, against a real NEP-141 token and NEAR payments.

mod common;

use common::{Env, NEAR, base_policy, refused};
use near_api::{AccountId, Contract, NearGas, NearToken};
use near_sdk::serde_json::{Value, json};
use testresult::TestResult;

const USDC: &str = "usdc.sandbox";

fn shop_policy(owner: &str) -> impl FnOnce(&AccountId) -> Value {
    let owner = owner.to_string();
    move |shop| {
        let mut p = base_policy(shop);
        p["assets"][1]["asset"] = json!({ "Nep141": { "token": USDC } });
        p["floors"] = json!([
            { "asset": { "Nep141": { "token": USDC } }, "min": "2000000" },
            { "asset": "Near", "min": NEAR.to_string() }
        ]);
        p["split"] = json!([
            { "account": owner, "bps": 7000 },
            { "account": shop, "bps": 2000 }
        ]);
        p["delivery_s"] = json!(48);
        p["refund_limits"] = json!([{
            "asset": { "Nep141": { "token": USDC } },
            "window": { "period_s": 86_400, "limit": "300000" }
        }]);
        p
    }
}

async fn token_env() -> TestResult<(Env, AccountId)> {
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
    for who in [&env.purse, &env.owner, &env.shop] {
        Contract(token.clone())
            .call_function("register", json!({ "account_id": who }))
            .transaction()
            .with_signer(env.owner.clone(), env.root.clone())
            .send_to(&env.net)
            .await?
            .assert_success();
    }
    Ok((env, token))
}

async fn ft_balance(env: &Env, token: &AccountId, who: &AccountId) -> TestResult<u128> {
    let b: String = Contract(token.clone())
        .call_function("ft_balance_of", json!({ "account_id": who }))
        .read_only()
        .fetch_from(&env.net)
        .await?
        .data;
    Ok(b.parse()?)
}

async fn buy(env: &Env, token: &AccountId, amount: u128, msg: &str) -> TestResult {
    Contract(token.clone())
        .call_function(
            "ft_transfer_call",
            json!({ "receiver_id": env.purse, "amount": amount.to_string(), "msg": msg }),
        )
        .transaction()
        .deposit(NearToken::from_yoctonear(1))
        .gas(NearGas::from_tgas(300))
        .with_signer(env.attacker.clone(), env.root.clone())
        .send_to(&env.net)
        .await?
        .assert_success();
    env.sandbox.fast_forward(3).await?;
    Ok(())
}

async fn quote(env: &Env, price: &str) -> TestResult<Value> {
    Ok(env
        .agent_call(
            "quote",
            json!({
                "buyer": env.attacker,
                "asset": { "Nep141": { "token": USDC } },
                "price": price,
                "item": "report on alice.near"
            }),
            0,
        )
        .await?
        .assert_success()
        .json()?)
}

#[tokio::test]
async fn a_sale_respects_the_floor_and_is_split_on_delivery() -> TestResult {
    let (env, token) = token_env().await?;

    let haggled = quote(&env, "1999999").await?;
    assert_eq!(
        haggled,
        json!({ "Denied": { "reason": { "BelowFloor": { "floor": "2000000" } } } })
    );

    let q = quote(&env, "2500000").await?;
    assert_eq!(q["Quoted"]["order_id"], 0);
    buy(&env, &token, 2_600_000, "0").await?;

    assert_eq!(
        ft_balance(&env, &token, &env.owner).await?,
        0,
        "held until delivery"
    );
    assert_eq!(ft_balance(&env, &token, &env.purse).await?, 2_500_000);
    assert_eq!(
        ft_balance(&env, &token, &env.attacker).await?,
        7_500_000,
        "the extra 100000 came back"
    );
    let order: Value = env.view("order", json!({ "order_id": 0 })).await?;
    assert_eq!(order["status"], "Paid");
    assert_eq!(order["held"], "2500000");

    buy(&env, &token, 2_500_000, "0").await?;
    assert_eq!(
        ft_balance(&env, &token, &env.attacker).await?,
        7_500_000,
        "paying twice is returned"
    );

    env.agent_call(
        "deliver",
        json!({ "order_id": 0, "receipt": "sha256:abc" }),
        0,
    )
    .await?
    .assert_success();
    env.sandbox.fast_forward(3).await?;
    assert_eq!(ft_balance(&env, &token, &env.owner).await?, 1_750_000);
    assert_eq!(ft_balance(&env, &token, &env.shop).await?, 500_000);
    assert_eq!(ft_balance(&env, &token, &env.purse).await?, 250_000);
    let over: Value = env
        .agent_call(
            "refund",
            json!({ "order_id": 0, "amount": "250001", "reason": "the buyer asked nicely" }),
            0,
        )
        .await?
        .assert_success()
        .json()?;
    assert_eq!(
        over,
        json!({ "Denied": { "reason": { "OverHeld": { "max": "250000" } } } })
    );
    let ok: Value = env
        .agent_call(
            "refund",
            json!({ "order_id": 0, "amount": "250000", "reason": "late" }),
            0,
        )
        .await?
        .assert_success()
        .json()?;
    assert_eq!(ok, json!("Refunded"));
    env.sandbox.fast_forward(3).await?;
    assert_eq!(ft_balance(&env, &token, &env.attacker).await?, 7_750_000);
    assert_eq!(ft_balance(&env, &token, &env.purse).await?, 0);
    Ok(())
}

#[tokio::test]
async fn an_undelivered_payment_goes_back_to_the_buyer_even_when_frozen() -> TestResult {
    let (env, token) = token_env().await?;
    quote(&env, "2000000").await?;
    buy(&env, &token, 2_000_000, "0").await?;
    assert!(
        refused(
            env.call_as(&env.attacker, "reclaim", json!({ "order_id": 0 }), 0)
                .await
        ),
        "the agent still has time"
    );
    env.owner_call("freeze", json!({})).await?.assert_success();
    env.advance(50).await?;
    assert!(
        refused(
            env.call_as(&env.shop, "reclaim", json!({ "order_id": 0 }), 0)
                .await
        ),
        "only the buyer"
    );
    env.call_as(&env.attacker, "reclaim", json!({ "order_id": 0 }), 0)
        .await?
        .assert_success();
    env.sandbox.fast_forward(3).await?;
    assert_eq!(ft_balance(&env, &token, &env.attacker).await?, 10_000_000);
    let order: Value = env.view("order", json!({ "order_id": 0 })).await?;
    assert_eq!(order["status"], "Refunded");
    Ok(())
}

#[tokio::test]
async fn a_frozen_shop_takes_no_orders_or_money() -> TestResult {
    let (env, token) = token_env().await?;
    quote(&env, "2000000").await?;
    env.owner_call("freeze", json!({})).await?.assert_success();
    assert_eq!(
        quote(&env, "2000000").await?,
        json!({ "Denied": { "reason": "Frozen" } })
    );
    buy(&env, &token, 2_000_000, "0").await?;
    assert_eq!(ft_balance(&env, &token, &env.attacker).await?, 10_000_000);
    assert_eq!(ft_balance(&env, &token, &env.purse).await?, 0);
    Ok(())
}

#[tokio::test]
async fn near_payments_split_exactly_and_redirecting_revenue_waits() -> TestResult {
    let env = Env::new(shop_policy("owner.sandbox")).await?;
    let d: Value = env
        .agent_call(
            "quote",
            json!({ "buyer": null, "asset": "Near", "price": NEAR.to_string(), "item": "logo" }),
            0,
        )
        .await?
        .assert_success()
        .json()?;
    assert_eq!(d["Quoted"]["order_id"], 0);
    let (owner0, shop0) = (
        env.balance(&env.owner).await?,
        env.balance(&env.shop).await?,
    );

    assert!(
        refused(
            env.call_as(&env.attacker, "pay", json!({ "order_id": 0 }), NEAR - 1)
                .await
        ),
        "underpaying is refused"
    );
    env.call_as(&env.attacker, "pay", json!({ "order_id": 0 }), NEAR)
        .await?
        .assert_success();
    env.agent_call(
        "deliver",
        json!({ "order_id": 0, "receipt": "logo.svg" }),
        0,
    )
    .await?
    .assert_success();
    env.sandbox.fast_forward(3).await?;
    assert_eq!(env.balance(&env.shop).await? - shop0, NEAR / 10 * 2);
    assert_eq!(env.balance(&env.owner).await? - owner0, NEAR / 10 * 7);

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
        "queued behind the timelock"
    );
    let policy: Value = env.view("policy", json!({})).await?;
    assert_eq!(policy["split"][0]["account"], env.owner.to_string());
    Ok(())
}

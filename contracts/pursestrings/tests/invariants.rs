//! Sandbox tests for security invariants 1 (agent key), 3 (timelock), 4 (budgets) and
//! 6 (kill switch). Each test starts its own sandbox.

mod common;

use common::{Env, NEAR, base_policy, deny_reason, near_spend, refused, status, yocto};
use near_api::types::AccessKeyPermission;
use near_api::{Account, AccountId};
use near_sdk::serde_json::{Value, json};
use testresult::TestResult;

async fn wait_for_status(env: &Env, req_id: u64, want: &str) -> TestResult {
    for _ in 0..20 {
        let req: Value = env.view("request", json!({ "req_id": req_id })).await?;
        if req["status"] == want {
            return Ok(());
        }
        env.sandbox.fast_forward(1).await?;
    }
    Err(format!("request {req_id} never reached {want}").into())
}

fn with(f: impl Fn(&mut Value)) -> impl FnOnce(&AccountId) -> Value {
    move |shop| {
        let mut p = base_policy(shop);
        f(&mut p);
        p
    }
}

async fn used(env: &Env, asset: Value) -> TestResult<u128> {
    let s: Value = env.view("budget_status", json!({ "asset": asset })).await?;
    Ok(s["windows"][0]["used"].as_str().unwrap().parse()?)
}

#[tokio::test]
async fn inv1_agent_key_cannot_move_funds() -> TestResult {
    let env = Env::new(base_policy).await?;

    let key = Account(env.purse.clone())
        .access_key(env.agent_key.public_key())
        .fetch_from(&env.net)
        .await?
        .data;
    let AccessKeyPermission::FunctionCall(fc) = key.permission else {
        return Err("agent key must be a function-call key".into());
    };
    assert_eq!(fc.receiver_id, env.purse.to_string());
    assert_eq!(
        fc.method_names,
        vec!["request_spend".to_string(), "cancel_request".to_string()]
    );
    assert_eq!(fc.allowance.map(|a| a.as_yoctonear()), Some(NEAR));

    let shop_before = env.balance(&env.shop).await?;

    assert!(
        refused(env.agent_transfer(&env.shop, NEAR).await),
        "raw transfer with the agent key"
    );
    let owner_only = [
        (
            "add_agent",
            json!({ "public_key": env.agent_key.public_key(), "allowance": yocto(1_000) }),
        ),
        (
            "propose",
            json!({ "ops": [{ "AddRecipient": { "Near": { "account": env.attacker } } }] }),
        ),
        ("approve_request", json!({ "req_id": 0 })),
        (
            "revoke_agent",
            json!({ "public_key": env.agent_key.public_key() }),
        ),
        ("on_spend_executed", json!({ "req_id": 0 })),
    ];
    for (method, args) in owner_only {
        assert!(
            refused(env.agent_call(method, args.clone(), 0).await),
            "{method} without deposit"
        );
        assert!(
            refused(env.agent_call(method, args, 1).await),
            "{method} with 1 yocto"
        );
    }
    let to_shop = json!({ "request": near_spend(&env.shop, 1_000, "k1") });
    assert!(
        refused(env.agent_call("request_spend", to_shop.clone(), 1).await),
        "deposit on request_spend"
    );

    assert!(
        refused(
            env.call_as(&env.attacker, "request_spend", to_shop, 0)
                .await
        ),
        "outsider request_spend"
    );
    let to_attacker = json!({ "request": near_spend(&env.attacker, 1_000, "k2") });
    let res = env
        .agent_call("request_spend", to_attacker, 0)
        .await?
        .assert_success();
    let event: Value = res
        .logs()
        .into_iter()
        .find_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(near_sdk::serde_json::from_str)
        .expect("denial is logged as an event")?;
    assert_eq!(event["standard"], "pursestrings");
    assert_eq!(event["event"], "spend_requested");
    assert_eq!(
        event["data"]["decision"],
        json!({ "Denied": { "reason": "RecipientNotAllowed" } })
    );
    assert_eq!(deny_reason(&res.json()?), json!("RecipientNotAllowed"));

    assert_eq!(env.balance(&env.shop).await?, shop_before);
    let d = env.spend(near_spend(&env.shop, 1_000, "k3")).await?;
    assert_eq!(status(&d), "Approved");
    wait_for_status(&env, d["Approved"]["req_id"].as_u64().unwrap(), "Done").await?;
    assert_eq!(env.balance(&env.shop).await?, shop_before + NEAR);
    Ok(())
}

#[tokio::test]
async fn inv1_owner_cannot_be_the_account_itself() -> TestResult {
    let env = Env::new(base_policy).await?;
    let selfish: AccountId = "selfish.sandbox".parse()?;
    env.sandbox
        .create_account(selfish.clone())
        .initial_balance(near_api::NearToken::from_near(10))
        .send()
        .await?;
    let res = near_api::Contract::deploy(selfish.clone())
        .use_code(common::wasm())
        .with_init_call(
            "new",
            json!({ "owner": selfish, "mpc": env.mpc, "intents": "intents.sandbox", "ops": common::policy_ops(&base_policy(&env.shop)) }),
        )?
        .with_signer(env.root.clone())
        .send_to(&env.net)
        .await;
    assert!(refused(res.map_err(|e| e.to_string())));

    assert!(refused(
        env.call_as(
            &env.attacker,
            "new",
            json!({ "owner": env.attacker, "mpc": env.mpc, "intents": "intents.sandbox", "ops": common::policy_ops(&base_policy(&env.shop)) }),
            0
        )
        .await
    ));
    let owner: AccountId = env.view("owner", json!({})).await?;
    assert_eq!(owner, env.owner);
    Ok(())
}

#[tokio::test]
async fn inv3_loosening_waits_tightening_is_instant() -> TestResult {
    let env = Env::new(with(|p| p["timelock_s"] = json!(60))).await?;
    let raise = json!({ "ops": [{ "SetAssetRule": {
        "asset": "Near", "per_tx_cap": yocto(10_000),
        "windows": [{ "period_s": 86_400, "limit": yocto(3_000) }],
        "cosign_above": yocto(1_500), "risk_check_above": null
    } }] });

    assert!(
        refused(env.call_as(&env.owner, "propose", raise.clone(), 0).await),
        "owner call without 1 yocto"
    );
    assert!(
        refused(
            env.call_as(&env.attacker, "propose", raise.clone(), 1)
                .await
        ),
        "outsider propose"
    );

    let id: Option<u64> = env
        .owner_call("propose", raise)
        .await?
        .assert_success()
        .json()?;
    let id = id.expect("raise must be queued");
    let policy: Value = env.view("policy", json!({})).await?;
    assert_eq!(policy["assets"][0]["per_tx_cap"], yocto(2_000));
    assert_eq!(policy["version"], 1);
    assert!(
        refused(Ok(env
            .owner_call("apply_proposal", json!({ "id": id }))
            .await?)),
        "apply before eta"
    );

    env.owner_call("cancel_proposal", json!({ "id": id }))
        .await?
        .assert_success();
    let proposals: Vec<Value> = env.view("proposals", json!({})).await?;
    assert!(proposals.is_empty());

    let lower = json!({ "ops": [{ "SetAssetRule": {
        "asset": "Near", "per_tx_cap": yocto(500),
        "windows": [{ "period_s": 86_400, "limit": yocto(3_000) }],
        "cosign_above": yocto(1_500), "risk_check_above": null
    } }] });
    let id: Option<u64> = env
        .owner_call("propose", lower)
        .await?
        .assert_success()
        .json()?;
    assert_eq!(id, None);
    let d = env
        .spend(near_spend(&env.shop, 1_000, "after-lower"))
        .await?;
    assert_eq!(
        deny_reason(&d),
        json!({ "OverPerTxCap": { "cap": yocto(500) } })
    );

    let mixed = json!({ "ops": [
        { "RemoveRecipient": { "Near": { "account": "ghost.sandbox" } } },
        { "AddRecipient": { "Near": { "account": env.attacker } } }
    ] });
    let id: Option<u64> = env
        .owner_call("propose", mixed)
        .await?
        .assert_success()
        .json()?;
    assert!(id.is_some());
    let policy: Value = env.view("policy", json!({})).await?;
    assert_eq!(
        policy["recipients"],
        json!([{ "Near": { "account": env.shop } }])
    );
    assert_eq!(policy["version"], 3);
    let d = env
        .spend(near_spend(&env.attacker, 100, "to-attacker"))
        .await?;
    assert_eq!(deny_reason(&d), json!("RecipientNotAllowed"));

    env.advance(61).await?;
    env.owner_call("apply_proposal", json!({ "id": id.unwrap() }))
        .await?
        .assert_success();
    let d = env
        .spend(near_spend(&env.attacker, 100, "to-attacker-later"))
        .await?;
    assert_eq!(status(&d), "Approved", "{d}");
    let policy: Value = env.view("policy", json!({})).await?;
    assert_eq!(policy["version"], 4);
    Ok(())
}

#[tokio::test]
async fn inv4_per_asset_windows_reserve_and_release() -> TestResult {
    let env = Env::new(base_policy).await?;
    let ghost: AccountId = "ghost.sandbox".parse()?;
    let token = json!({ "Nep141": { "token": "ghost-token.sandbox" } });

    let d = env.spend(near_spend(&ghost, 1_000, "to-ghost")).await?;
    let ghost_req = d["Approved"]["req_id"].as_u64().expect("approved");
    wait_for_status(&env, ghost_req, "Failed").await?;
    assert_eq!(
        used(&env, json!("Near")).await?,
        0,
        "failed transfer releases its reservation"
    );

    for i in 0..3 {
        let d = env
            .spend(near_spend(&env.shop, 1_000, &format!("pay-{i}")))
            .await?;
        assert_eq!(status(&d), "Approved", "payment {i}: {d}");
    }
    assert_eq!(used(&env, json!("Near")).await?, 3 * NEAR);
    let d = env.spend(near_spend(&env.shop, 1_000, "pay-3")).await?;
    assert_eq!(
        deny_reason(&d),
        json!({ "OverWindow": { "period_s": 86_400, "remaining": "0" } })
    );

    let ft = json!({
        "asset": token, "amount": "100",
        "dest": { "Near": { "account": env.shop } },
        "purpose": "other asset", "idempotency_key": "ft-1"
    });
    // The token contract doesn't exist, so the transfer fails and the callback releases both
    // the window and the 1 yocto fee reservation before the transaction returns.
    let d = env.spend(ft.clone()).await?;
    let ft_req = d["Approved"]["req_id"]
        .as_u64()
        .expect("other asset has its own window");
    wait_for_status(&env, ft_req, "Failed").await?;
    assert_eq!(used(&env, token.clone()).await?, 0);
    let fee: Value = env.view("fee_status", json!({})).await?;
    assert_eq!(fee["used"], "0");

    let d = env.spend(ft).await?;
    assert_eq!(
        deny_reason(&d),
        json!({ "DuplicateIdempotencyKey": { "req_id": ft_req } })
    );
    Ok(())
}

#[tokio::test]
async fn inv4_cosign_reserves_until_resolved() -> TestResult {
    let env = Env::new(with(|p| p["pending_ttl_s"] = json!(60))).await?;
    let shop_before = env.balance(&env.shop).await?;

    let d = env.spend(near_spend(&env.shop, 2_000, "big-1")).await?;
    let req = d["NeedsCosign"]["req_id"].as_u64().expect("needs cosign");
    assert_eq!(used(&env, json!("Near")).await?, 2 * NEAR);
    assert!(refused(
        env.call_as(
            &env.attacker,
            "approve_request",
            json!({ "req_id": req }),
            1
        )
        .await
    ));
    env.owner_call("reject_request", json!({ "req_id": req }))
        .await?
        .assert_success();
    assert_eq!(used(&env, json!("Near")).await?, 0);

    let d = env.spend(near_spend(&env.shop, 1_600, "big-2")).await?;
    let req = d["NeedsCosign"]["req_id"].as_u64().expect("needs cosign");
    assert!(
        refused(
            env.call_as(&env.attacker, "expire_request", json!({ "req_id": req }), 0)
                .await
        ),
        "not yet expired"
    );
    env.advance(61).await?;
    assert!(
        refused(Ok(env
            .owner_call("approve_request", json!({ "req_id": req }))
            .await?)),
        "approve after ttl"
    );
    env.call_as(&env.attacker, "expire_request", json!({ "req_id": req }), 0)
        .await?
        .assert_success();
    assert_eq!(used(&env, json!("Near")).await?, 0);

    let d = env.spend(near_spend(&env.shop, 2_000, "big-3")).await?;
    let req = d["NeedsCosign"]["req_id"].as_u64().expect("needs cosign");
    env.owner_call("approve_request", json!({ "req_id": req }))
        .await?
        .assert_success();
    wait_for_status(&env, req, "Done").await?;
    assert_eq!(env.balance(&env.shop).await?, shop_before + 2 * NEAR);
    assert_eq!(used(&env, json!("Near")).await?, 2 * NEAR);
    Ok(())
}

#[tokio::test]
async fn inv4_window_rolls_over() -> TestResult {
    let env = Env::new(with(|p| {
        p["assets"][0]["windows"][0]["period_s"] = json!(240)
    }))
    .await?;
    for i in 0..3 {
        let d = env
            .spend(near_spend(&env.shop, 1_000, &format!("a-{i}")))
            .await?;
        assert_eq!(status(&d), "Approved", "{d}");
    }
    let d = env.spend(near_spend(&env.shop, 1_000, "a-3")).await?;
    assert_eq!(
        deny_reason(&d),
        json!({ "OverWindow": { "period_s": 240, "remaining": "0" } })
    );
    env.advance(250).await?;
    assert_eq!(used(&env, json!("Near")).await?, 0);
    let d = env.spend(near_spend(&env.shop, 1_000, "a-4")).await?;
    assert_eq!(status(&d), "Approved", "{d}");
    Ok(())
}

#[tokio::test]
async fn inv4_velocity_stops_a_drip() -> TestResult {
    let env = Env::new(base_policy).await?;
    let tighten =
        json!({ "ops": [{ "SetVelocity": { "velocity": { "max": 3, "period_s": 3_600 } } }] });
    let id: Option<u64> = env
        .owner_call("propose", tighten)
        .await?
        .assert_success()
        .json()?;
    assert_eq!(id, None);

    let mut decisions = Vec::new();
    for i in 0..5 {
        decisions.push(
            env.spend(near_spend(&env.shop, 10, &format!("drip-{i}")))
                .await?,
        );
    }
    let statuses: Vec<&str> = decisions.iter().map(status).collect();
    assert_eq!(
        statuses,
        ["Approved", "Approved", "Approved", "Denied", "Denied"]
    );
    assert!(
        deny_reason(&decisions[3]).get("Velocity").is_some(),
        "{}",
        decisions[3]
    );
    Ok(())
}

#[tokio::test]
async fn inv6_freeze_and_revoke_in_one_transaction() -> TestResult {
    let env = Env::new(base_policy).await?;
    let d = env.spend(near_spend(&env.shop, 2_000, "pending")).await?;
    let pending = d["NeedsCosign"]["req_id"].as_u64().expect("needs cosign");

    assert!(refused(
        env.call_as(&env.attacker, "freeze", json!({}), 1).await
    ));
    env.owner_call("freeze", json!({})).await?.assert_success();
    let d = env
        .spend(near_spend(&env.shop, 100, "while-frozen"))
        .await?;
    assert_eq!(deny_reason(&d), json!("Frozen"));
    assert!(refused(Ok(env
        .owner_call("approve_request", json!({ "req_id": pending }))
        .await?)));

    let id: Option<u64> = env
        .owner_call("propose", json!({ "ops": ["Unfreeze"] }))
        .await?
        .assert_success()
        .json()?;
    assert!(id.is_some(), "unfreezing is a loosening");
    let policy: Value = env.view("policy", json!({})).await?;
    assert_eq!(policy["frozen"], true);

    assert!(refused(
        env.call_as(
            &env.attacker,
            "revoke_agent",
            json!({ "public_key": env.agent_key.public_key() }),
            1
        )
        .await
    ));
    env.owner_call(
        "revoke_agent",
        json!({ "public_key": env.agent_key.public_key() }),
    )
    .await?
    .assert_success();
    let keys = Account(env.purse.clone())
        .list_keys()
        .fetch_from(&env.net)
        .await?
        .data;
    assert!(
        keys.iter().all(|(pk, _)| *pk != env.agent_key.public_key()),
        "agent key deleted"
    );
    assert!(refused(
        env.agent_call(
            "request_spend",
            json!({ "request": near_spend(&env.shop, 100, "after-revoke") }),
            0
        )
        .await
    ));
    Ok(())
}

#[tokio::test]
async fn nep141_spend_settles_and_counts_the_fee() -> TestResult {
    let token: AccountId = "usdc.sandbox".parse()?;
    let env = Env::new(with(|p| {
        p["assets"][1]["asset"] = json!({ "Nep141": { "token": "usdc.sandbox" } });
    }))
    .await?;
    env.sandbox.create_account(token.clone()).send().await?;
    near_api::Contract::deploy(token.clone())
        .use_code(common::token_wasm())
        .with_init_call(
            "new",
            json!({ "holder": env.purse, "total_supply": "1000" }),
        )?
        .with_signer(env.root.clone())
        .send_to(&env.net)
        .await?
        .assert_success();
    near_api::Contract(token.clone())
        .call_function("register", json!({ "account_id": env.shop }))
        .transaction()
        .with_signer(env.owner.clone(), env.root.clone())
        .send_to(&env.net)
        .await?
        .assert_success();

    let asset = json!({ "Nep141": { "token": token } });
    let d = env
        .spend(json!({
            "asset": asset, "amount": "40",
            "dest": { "Near": { "account": env.shop } },
            "purpose": "api credits", "idempotency_key": "usdc-1"
        }))
        .await?;
    let req = d["Approved"]["req_id"].as_u64().expect("approved");
    wait_for_status(&env, req, "Done").await?;

    let balance = |who: &AccountId| {
        near_api::Contract(token.clone())
            .call_function("ft_balance_of", json!({ "account_id": who }))
            .read_only::<String>()
            .fetch_from(&env.net)
    };
    assert_eq!(balance(&env.shop).await?.data, "40");
    assert_eq!(balance(&env.purse).await?.data, "960");
    assert_eq!(used(&env, asset).await?, 40);
    let fee: Value = env.view("fee_status", json!({})).await?;
    assert_eq!(fee["used"], "1");
    Ok(())
}

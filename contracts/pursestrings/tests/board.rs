//! A community bounty board owned by a real Sputnik DAO: payouts routed by earned trust,
//! one council member for mid-size ones, a DAO vote above that.

mod common;

use common::{Env, NEAR, base_policy, deny_reason, refused, status, yocto};
use near_api::AccountId;
use near_sdk::serde_json::{Value, json};
use testresult::TestResult;

fn board(shop: &AccountId) -> Value {
    let mut p = base_policy(shop);
    p["council"] = json!(["council.sandbox"]);
    p["trust"] = json!([{
        "asset": "Near",
        "tiers": [
            { "points": 0, "auto_up_to": "0", "council_up_to": yocto(500) },
            { "points": 1, "auto_up_to": yocto(300), "council_up_to": yocto(1_000) }
        ]
    }]);
    p
}

async fn as_council(env: &Env, method: &str, args: Value) -> TestResult<Value> {
    let res = env.call_as(&env.council, method, args, 1).await?;
    Ok(res.assert_success().json().unwrap_or(Value::Null))
}

async fn claimed(env: &Env, who: &AccountId, reward_milli: u128) -> TestResult<u64> {
    let id = as_council(
        env,
        "post_bounty",
        json!({ "title": "translate the docs", "asset": "Near", "reward": yocto(reward_milli) }),
    )
    .await?
    .as_u64()
    .expect("bounty id");
    env.call_as(who, "claim_bounty", json!({ "id": id }), 1)
        .await?
        .assert_success();
    env.call_as(
        who,
        "submit_bounty",
        json!({ "id": id, "work": "https://example.com/pr/7" }),
        1,
    )
    .await?
    .assert_success();
    Ok(id)
}

fn payout(id: u64, to: &AccountId, milli: u128) -> Value {
    json!({
        "asset": "Near",
        "amount": yocto(milli),
        "dest": { "Near": { "account": to } },
        "purpose": "bounty",
        "idempotency_key": format!("bounty-{id}"),
        "bounty": id
    })
}

async fn settle(env: &Env) -> TestResult {
    env.sandbox.fast_forward(4).await?;
    Ok(())
}

#[tokio::test]
async fn a_dao_owned_board_pays_by_earned_trust() -> TestResult {
    let env = Env::new_dao(board).await?;
    assert_eq!(env.view::<String>("owner", json!({})).await?, "dao.sandbox");
    let alice: AccountId = "alice.sandbox".parse()?;
    env.sandbox.create_account(alice.clone()).send().await?;

    let first = claimed(&env, &alice, 300).await?;
    let d = env.spend(payout(first, &env.attacker, 300)).await?;
    assert_eq!(
        deny_reason(&d),
        json!("BountyMismatch"),
        "only the claimant"
    );
    let d = env.spend(payout(first, &alice, 300)).await?;
    assert_eq!(
        status(&d),
        "NeedsCouncil",
        "a newcomer needs one council member"
    );
    let req = d["NeedsCouncil"]["req_id"].as_u64().unwrap();
    assert!(refused(
        env.call_as(
            &env.attacker,
            "council_approve",
            json!({ "req_id": req }),
            1
        )
        .await
    ));
    let before = env.balance(&alice).await?;
    as_council(&env, "council_approve", json!({ "req_id": req })).await?;
    settle(&env).await?;
    assert_eq!(env.balance(&alice).await? - before, NEAR * 3 / 10);
    let record: Value = env.view("record", json!({ "account": alice })).await?;
    assert_eq!(record, json!({ "points": 1, "bounties": [first] }));

    let second = claimed(&env, &alice, 300).await?;
    let d = env.spend(payout(second, &alice, 300)).await?;
    assert_eq!(
        status(&d),
        "Approved",
        "one paid bounty earns auto-approval up to 0.3"
    );

    let big = claimed(&env, &alice, 1_200).await?;
    let d = env.spend(payout(big, &alice, 1_200)).await?;
    assert_eq!(
        status(&d),
        "NeedsCosign",
        "above the council tier the DAO votes"
    );
    let req = d["NeedsCosign"]["req_id"].as_u64().unwrap();
    assert!(refused(
        env.call_as(&env.council, "council_approve", json!({ "req_id": req }), 1)
            .await
    ));
    let before = env.balance(&alice).await?;
    env.owner_call("approve_request", json!({ "req_id": req }))
        .await?
        .assert_success();
    settle(&env).await?;
    assert_eq!(env.balance(&alice).await? - before, NEAR * 12 / 10);
    let record: Value = env.view("record", json!({ "account": alice })).await?;
    assert_eq!(record["points"], 3);
    Ok(())
}

#[tokio::test]
async fn any_council_member_freezes_and_only_the_dao_loosens_after_the_timelock() -> TestResult {
    let env = Env::new_dao(board).await?;
    as_council(&env, "freeze", json!({})).await?;
    let d = env.spend(common::near_spend(&env.shop, 100, "k")).await?;
    assert_eq!(deny_reason(&d), json!("Frozen"));
    assert!(refused(
        env.call_as(&env.council, "propose", json!({ "ops": ["Unfreeze"] }), 1)
            .await
    ));
    env.owner_call("propose", json!({ "ops": ["Unfreeze"] }))
        .await?
        .assert_success();
    let proposals: Value = env.view("proposals", json!({})).await?;
    assert_eq!(
        proposals[0][1]["ops"],
        json!(["Unfreeze"]),
        "queued, not applied"
    );
    let policy: Value = env.view("policy", json!({})).await?;
    assert_eq!(policy["frozen"], true);
    Ok(())
}

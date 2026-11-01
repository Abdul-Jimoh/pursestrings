//! Sandbox tests for the Intents path, run against the `intents.near` code deployed on mainnet
//! (v0.4.5, `tests/fixtures/intents-0.4.5.wasm`), so payloads, nonces and signatures are
//! checked by the real verifier.

mod common;

use common::{Env, base_policy, deny_reason, refused};
use ed25519_dalek::{Signer as _, SigningKey};
use near_api::{AccountId, Contract, NearGas, NearToken};
use near_sdk::base64::Engine;
use near_sdk::base64::engine::general_purpose::STANDARD as BASE64;
use near_sdk::serde_json::{Value, json};
use testresult::TestResult;

const INTENTS_WASM: &[u8] = include_bytes!("fixtures/intents-0.4.5.wasm");
/// `code_hash` of `intents.near` on mainnet at block 222599941.
const INTENTS_CODE_HASH: &str = "BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk";
const TOK_A: &str = "nep141:tok-a.sandbox";
const TOK_B: &str = "nep141:tok-b.sandbox";
const SWAP_TTL_S: u64 = 300;

fn intents_policy(shop: &AccountId) -> Value {
    let mut p = base_policy(shop);
    let rule = |token: &str| {
        json!({
            "asset": { "Intents": { "token": token } },
            "per_tx_cap": "100",
            "windows": [{ "period_s": 86_400, "limit": "150" }],
            "cosign_above": null,
            "risk_check_above": null
        })
    };
    let mut ft = rule(TOK_A);
    ft["asset"] = json!({ "Nep141": { "token": "tok-a.sandbox" } });
    p["assets"]
        .as_array_mut()
        .unwrap()
        .extend([rule(TOK_A), rule(TOK_B), ft]);
    p["recipients"].as_array_mut().unwrap().extend([
        json!({ "Intents": { "account": shop } }),
        json!({ "Withdraw": { "receiver": shop, "memo": null } }),
        json!({ "Withdraw": { "receiver": "unregistered.sandbox", "memo": null } }),
    ]);
    p["intent_kinds"] = json!(["Transfer", "Withdraw", "Swap"]);
    p["min_rates"] = json!([{
        "sell": TOK_A,
        "buy": TOK_B,
        "rate": { "num": "19", "den": "10" }
    }]);
    p
}

struct Intents {
    env: Env,
    intents: AccountId,
    solver: AccountId,
}

impl Intents {
    async fn new() -> TestResult<Self> {
        let env = Env::new(intents_policy).await?;
        let intents: AccountId = "intents.sandbox".parse()?;
        let solver: AccountId = "solver.sandbox".parse()?;
        assert_eq!(
            near_api::types::CryptoHash::hash(INTENTS_WASM).to_string(),
            INTENTS_CODE_HASH
        );
        env.sandbox
            .create_account(intents.clone())
            .initial_balance(NearToken::from_near(30))
            .send()
            .await?;
        env.sandbox.create_account(solver.clone()).send().await?;
        Contract::deploy(intents.clone())
            .use_code(INTENTS_WASM.to_vec())
            .with_init_call(
                "new",
                json!({ "config": {
                    "wnear_id": "wrap.sandbox",
                    "fees": { "fee": 0, "fee_collector": "fees.sandbox" },
                    "roles": {}
                }}),
            )?
            .with_signer(env.root.clone())
            .send_to(&env.net)
            .await?
            .assert_success();
        let s = Self {
            env,
            intents,
            solver,
        };
        for token in ["tok-a.sandbox", "tok-b.sandbox"] {
            let id: AccountId = token.parse()?;
            s.env.sandbox.create_account(id.clone()).send().await?;
            Contract::deploy(id.clone())
                .use_code(common::token_wasm())
                .with_init_call(
                    "new",
                    json!({ "holder": s.env.owner, "total_supply": "1000000" }),
                )?
                .with_signer(s.env.root.clone())
                .send_to(&s.env.net)
                .await?
                .assert_success();
            for who in [&s.intents, &s.env.shop, &s.solver] {
                s.call(
                    &id,
                    &s.env.owner,
                    "register",
                    json!({ "account_id": who }),
                    0,
                )
                .await?
                .assert_success();
            }
        }
        s.deposit(
            "tok-a.sandbox",
            &s.env.owner.clone(),
            &s.env.purse.clone(),
            300,
        )
        .await?;
        s.call(
            &"tok-b.sandbox".parse()?,
            &s.env.owner,
            "ft_transfer",
            json!({ "receiver_id": s.solver, "amount": "1000" }),
            1,
        )
        .await?
        .assert_success();
        s.deposit("tok-b.sandbox", &s.solver.clone(), &s.solver.clone(), 1000)
            .await?;
        Ok(s)
    }

    async fn call(
        &self,
        contract: &AccountId,
        who: &AccountId,
        method: &str,
        args: Value,
        deposit: u128,
    ) -> TestResult<near_api::types::transaction::result::TransactionResult> {
        Ok(Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(NearGas::from_tgas(300))
            .with_signer(who.clone(), self.env.root.clone())
            .send_to(&self.env.net)
            .await?)
    }

    async fn deposit(
        &self,
        token: &str,
        from: &AccountId,
        to: &AccountId,
        amount: u128,
    ) -> TestResult {
        self.call(
            &token.parse()?,
            from,
            "ft_transfer_call",
            json!({ "receiver_id": self.intents, "amount": amount.to_string(), "msg": to }),
            1,
        )
        .await?
        .assert_success();
        Ok(())
    }

    async fn view_on<T: near_sdk::serde::de::DeserializeOwned + Send + Sync>(
        &self,
        contract: &AccountId,
        method: &str,
        args: Value,
    ) -> TestResult<T> {
        Ok(Contract(contract.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.env.net)
            .await?
            .data)
    }

    async fn mt_balance(&self, who: &AccountId, token: &str) -> TestResult<u128> {
        let b: String = self
            .view_on(
                &self.intents,
                "mt_balance_of",
                json!({ "account_id": who, "token_id": token }),
            )
            .await?;
        Ok(b.parse()?)
    }

    async fn used(&self, token: &str) -> TestResult<u128> {
        let s: Value = self
            .env
            .view(
                "budget_status",
                json!({ "asset": { "Intents": { "token": token } } }),
            )
            .await?;
        Ok(s["windows"][0]["used"].as_str().unwrap().parse()?)
    }

    async fn request(&self, req_id: u64) -> TestResult<Value> {
        self.env.view("request", json!({ "req_id": req_id })).await
    }

    async fn settle(
        &self,
        req_id: u64,
    ) -> TestResult<near_api::types::transaction::result::TransactionResult> {
        self.call(
            &self.env.purse,
            &self.env.shop,
            "settle_intent",
            json!({ "req_id": req_id }),
            0,
        )
        .await
    }
}

fn spend(token: &str, amount: u128, dest: Value, key: &str) -> Value {
    json!({
        "asset": { "Intents": { "token": token } },
        "amount": amount.to_string(),
        "dest": { "Intent": dest },
        "purpose": "test",
        "idempotency_key": key
    })
}

fn req_id(decision: &Value) -> u64 {
    decision["Approved"]["req_id"]
        .as_u64()
        .unwrap_or_else(|| panic!("not approved: {decision}"))
}

#[tokio::test]
async fn intents_transfer_and_withdraw_go_through_the_policy() -> TestResult {
    let s = Intents::new().await?;
    let (env, purse, shop) = (&s.env, &s.env.purse, &s.env.shop);
    let tok_a: AccountId = "tok-a.sandbox".parse()?;

    let d = env
        .spend(spend(
            TOK_A,
            40,
            json!({ "Transfer": { "receiver": shop } }),
            "t1",
        ))
        .await?;
    assert_eq!(s.request(req_id(&d)).await?["status"], "Done");
    assert_eq!(s.mt_balance(shop, TOK_A).await?, 40);

    let to_shop = json!({ "Withdraw": { "receiver": shop, "memo": null } });
    let d = env.spend(spend(TOK_A, 30, to_shop, "w1")).await?;
    assert_eq!(s.request(req_id(&d)).await?["status"], "Done");
    let held: String = s
        .view_on(&tok_a, "ft_balance_of", json!({ "account_id": shop }))
        .await?;
    assert_eq!(held, "30");
    assert_eq!(s.mt_balance(purse, TOK_A).await?, 230);
    assert_eq!(s.used(TOK_A).await?, 70);

    let smuggled = json!({ "Withdraw": { "receiver": shop, "memo": "WITHDRAW_TO:0xattacker" } });
    let d = env.spend(spend(TOK_A, 5, smuggled, "w2")).await?;
    assert_eq!(deny_reason(&d), "RecipientNotAllowed");
    let d = env
        .spend(spend(
            TOK_A,
            5,
            json!({ "Transfer": { "receiver": env.attacker } }),
            "t2",
        ))
        .await?;
    assert_eq!(deny_reason(&d), "RecipientNotAllowed");

    // The purse holds no tok-b, so intents.near refuses the transfer and the budget comes back.
    let d = env
        .spend(spend(
            TOK_B,
            10,
            json!({ "Transfer": { "receiver": shop } }),
            "t3",
        ))
        .await?;
    assert_eq!(s.request(req_id(&d)).await?["status"], "Failed");
    assert_eq!(s.used(TOK_B).await?, 0);

    // ft_transfer bounces, intents.near refunds the purse, and the budget comes back.
    let bounce = json!({ "Withdraw": { "receiver": "unregistered.sandbox", "memo": null } });
    let d = env.spend(spend(TOK_A, 5, bounce, "w3")).await?;
    assert_eq!(s.request(req_id(&d)).await?["status"], "Failed");
    assert_eq!(s.mt_balance(purse, TOK_A).await?, 230);
    assert_eq!(s.used(TOK_A).await?, 70);
    Ok(())
}

fn solver_payload(s: &Intents, key: &SigningKey, deadline: &str) -> Value {
    let nonce = BASE64.encode([0x11; 32]);
    let payload = json!({
        "signer_id": s.solver,
        "verifying_contract": s.intents,
        "deadline": deadline,
        "nonce": nonce,
        "intents": [{ "intent": "token_diff", "diff": { TOK_A: "100", TOK_B: "-190" } }]
    })
    .to_string();
    let sig = key.sign(payload.as_bytes());
    json!({
        "standard": "raw_ed25519",
        "payload": payload,
        "public_key": format!("ed25519:{}", near_sdk::bs58::encode(key.verifying_key().as_bytes()).into_string()),
        "signature": format!("ed25519:{}", near_sdk::bs58::encode(sig.to_bytes()).into_string()),
    })
}

fn signed_entry(req: &Value, key: &str) -> Value {
    json!({
        "standard": "raw_ed25519",
        "payload": req["intent"]["payload"],
        "public_key": key,
        "signature": req["intent"]["signature"],
    })
}

#[tokio::test]
async fn inv2_intents_swap_is_built_signed_and_settled_by_the_contract() -> TestResult {
    let s = Intents::new().await?;
    let (env, purse) = (&s.env, &s.env.purse);
    let swap = |amount: u128, min_out: u128, key: &str| {
        spend(
            TOK_A,
            amount,
            json!({ "Swap": { "buy": TOK_B, "min_out": min_out.to_string() } }),
            key,
        )
    };

    let d = env.spend(swap(100, 190, "s0")).await?;
    assert_eq!(deny_reason(&d), "IntentsKeyMissing");

    env.owner_call("register_intents_key", json!({}))
        .await?
        .assert_success();
    let key: String = env.view("intents_key", json!({})).await?;
    let registered: Vec<String> = s
        .view_on(&s.intents, "public_keys_of", json!({ "account_id": purse }))
        .await?;
    assert_eq!(registered, vec![key.clone()]);

    let d = env.spend(swap(100, 189, "s1")).await?;
    assert_eq!(deny_reason(&d), "RateBelowFloor");

    let now = env.now_s().await?;
    let res = env
        .agent_call(
            "request_spend",
            json!({ "request": swap(100, 190, "s2") }),
            0,
        )
        .await?
        .assert_success();
    let decision: Value = res.json()?;
    let id = req_id(&decision);
    assert!(
        res.logs()
            .iter()
            .any(|l| l.contains(r#""event":"signed_intent""#)),
        "{:?}",
        res.logs()
    );
    let req = s.request(id).await?;
    assert_eq!(req["status"], "Signed");

    let payload: Value =
        near_sdk::serde_json::from_str(req["intent"]["payload"].as_str().unwrap())?;
    assert_eq!(payload["signer_id"], purse.to_string());
    assert_eq!(payload["verifying_contract"], s.intents.to_string());
    assert_eq!(
        payload["intents"],
        json!([{ "intent": "token_diff", "diff": { TOK_A: "-100", TOK_B: "190" } }])
    );
    let deadline = payload["deadline"].as_str().unwrap().to_string();
    let nonce = BASE64.decode(payload["nonce"].as_str().unwrap())?;
    let salt: String = s.view_on(&s.intents, "current_salt", json!({})).await?;
    assert_eq!(&nonce[..5], &[0x56, 0x28, 0xf6, 0xc6, 0]);
    assert_eq!(near_sdk_hex(&nonce[5..9]), salt);
    let nonce_deadline_s = u64::from_le_bytes(nonce[9..17].try_into()?) / 1_000_000_000;
    let deadline_s = req["intent"]["deadline_ns"].as_u64().unwrap() / 1_000_000_000;
    assert!((now + SWAP_TTL_S..now + SWAP_TTL_S + 10).contains(&deadline_s));
    assert_eq!(nonce_deadline_s, deadline_s + 86_400);
    assert_eq!(s.used(TOK_A).await?, 100, "reserved while signed");

    let solver_key = SigningKey::from_bytes(&[42; 32]);
    let solver_pk = format!(
        "ed25519:{}",
        near_sdk::bs58::encode(solver_key.verifying_key().as_bytes()).into_string()
    );
    s.call(
        &s.intents,
        &s.solver,
        "add_public_key",
        json!({ "public_key": solver_pk }),
        1,
    )
    .await?
    .assert_success();
    let bundle =
        json!({ "signed": [signed_entry(&req, &key), solver_payload(&s, &solver_key, &deadline)] });
    s.call(&s.intents, &env.shop, "execute_intents", bundle.clone(), 0)
        .await?
        .assert_success();
    assert_eq!(s.mt_balance(purse, TOK_A).await?, 200);
    assert_eq!(s.mt_balance(purse, TOK_B).await?, 190);
    assert!(
        refused(Ok(s
            .call(&s.intents, &env.shop, "execute_intents", bundle, 0)
            .await?)),
        "the nonce is spent"
    );

    let early = s.settle(id).await?;
    assert!(refused(Ok(early)), "the swap can still execute");

    let d = env.spend(swap(40, 76, "s3")).await?;
    let unfilled = req_id(&d);
    assert_eq!(s.used(TOK_A).await?, 140);

    env.advance(SWAP_TTL_S + 5).await?;
    let settled: Option<String> = s.settle(id).await?.assert_success().json()?;
    assert_eq!(settled.as_deref(), Some("Done"));
    let settled: Option<String> = s.settle(unfilled).await?.assert_success().json()?;
    assert_eq!(settled.as_deref(), Some("Expired"));
    assert_eq!(
        s.used(TOK_A).await?,
        100,
        "the unfilled swap's budget is back"
    );
    let open: Vec<Value> = env.view("intents_open", json!({})).await?;
    assert!(open.is_empty());
    assert!(refused(Ok(s.settle(id).await?)), "settled once");
    Ok(())
}

fn near_sdk_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test]
async fn owner_withdraws_only_to_itself_even_while_frozen() -> TestResult {
    let s = Intents::new().await?;
    let (env, purse, owner) = (&s.env, &s.env.purse, &s.env.owner);
    let tok_a: AccountId = "tok-a.sandbox".parse()?;
    s.call(&tok_a, owner, "register", json!({ "account_id": purse }), 0)
        .await?
        .assert_success();
    s.call(
        &tok_a,
        owner,
        "ft_transfer",
        json!({ "receiver_id": purse, "amount": "20" }),
        1,
    )
    .await?
    .assert_success();
    let withdraw = |asset: Value, amount: &str| json!({ "asset": asset, "amount": amount });

    let near = withdraw(json!("Near"), &common::yocto(1_000));
    assert!(refused(
        env.call_as(&env.attacker, "withdraw", near.clone(), 1)
            .await
    ));
    assert!(
        refused(env.agent_call("withdraw", near.clone(), 1).await),
        "the agent key can't call it"
    );

    env.owner_call("freeze", json!({})).await?.assert_success();
    let before = env.balance(owner).await?;
    env.owner_call("withdraw", near).await?.assert_success();
    let gained = env.balance(owner).await? - before;
    assert!(gained > common::NEAR * 99 / 100, "{gained}");

    let ft = withdraw(json!({ "Nep141": { "token": tok_a } }), "20");
    env.owner_call("withdraw", ft).await?.assert_success();
    let held: String = s
        .view_on(&tok_a, "ft_balance_of", json!({ "account_id": purse }))
        .await?;
    assert_eq!(held, "0");

    let inside = withdraw(json!({ "Intents": { "token": TOK_A } }), "50");
    env.owner_call("withdraw", inside).await?.assert_success();
    assert_eq!(s.mt_balance(owner, TOK_A).await?, 50);
    assert_eq!(s.mt_balance(purse, TOK_A).await?, 250);
    Ok(())
}

#[tokio::test]
async fn one_group_budget_spans_near_and_intents() -> TestResult {
    let s = Intents::new().await?;
    let (env, purse, owner, shop) = (&s.env, &s.env.purse, &s.env.owner, &s.env.shop);
    let tok_a: AccountId = "tok-a.sandbox".parse()?;
    s.call(&tok_a, owner, "register", json!({ "account_id": purse }), 0)
        .await?
        .assert_success();
    s.call(
        &tok_a,
        owner,
        "ft_transfer",
        json!({ "receiver_id": purse, "amount": "100" }),
        1,
    )
    .await?
    .assert_success();
    let group = json!({ "SetGroup": {
        "name": "tok-a",
        "decimals": 0,
        "members": [
            { "asset": { "Nep141": { "token": tok_a } }, "decimals": 0 },
            { "asset": { "Intents": { "token": TOK_A } }, "decimals": 0 }
        ],
        "windows": [{ "period_s": 86_400, "limit": "60" }]
    }});
    let queued: Option<u64> = env
        .owner_call("propose", json!({ "ops": [group] }))
        .await?
        .assert_success()
        .json()?;
    assert_eq!(
        queued, None,
        "a new group only adds limits, so it applies now"
    );

    let on_near = json!({
        "asset": { "Nep141": { "token": tok_a } },
        "amount": "20",
        "dest": { "Near": { "account": shop } },
        "purpose": "test",
        "idempotency_key": "n1"
    });
    let d = env.spend(on_near).await?;
    assert_eq!(s.request(req_id(&d)).await?["status"], "Done");
    let transfer = |amount: u128, key: &str| {
        spend(
            TOK_A,
            amount,
            json!({ "Transfer": { "receiver": shop } }),
            key,
        )
    };
    let d = env.spend(transfer(40, "i1")).await?;
    assert_eq!(s.request(req_id(&d)).await?["status"], "Done");

    let d = env.spend(transfer(1, "i2")).await?;
    assert_eq!(
        deny_reason(&d),
        json!({ "OverGroupWindow": { "group": "tok-a", "period_s": 86_400, "remaining": "0" } })
    );
    let status: Vec<Value> = env.view("group_status", json!({ "name": "tok-a" })).await?;
    assert_eq!(status[0]["used"], "60");
    assert_eq!(
        s.used(TOK_A).await?,
        40,
        "the asset's own window counts only its own spends"
    );
    Ok(())
}

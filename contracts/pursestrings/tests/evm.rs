//! Sandbox tests for invariant 2 (no blind signing) and the EVM budget rules. The expected
//! transactions are encoded here from the EIP-1559 spec, independently of omni-transaction.

mod common;

use common::{Env, base_policy, refused, status};
use near_api::AccountId;
use near_sdk::serde_json::{Value, json};
use sha3::{Digest, Keccak256};
use testresult::TestResult;

const CHAIN: u64 = 84532;
const USDC: &str = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const MERCHANT: &str = "0x00000000000000000000000000000000000dead1";
const GAS_LIMIT: u128 = 100_000;
const MAX_FEE: u128 = 2_000_000_000;
const PRIORITY: u128 = 1_000_000_000;
const MAX_GAS_COST: u128 = GAS_LIMIT * MAX_FEE;
/// The mock MPC contract's fixed signature (see contracts/test-mpc).
const SIG_R: &str = "0033333333333333333333333333333333333333333333333333333333333333";
const SIG_S: &str = "0000444444444444444444444444444444444444444444444444444444444444";

fn evm_policy(shop: &AccountId) -> Value {
    let mut p = base_policy(shop);
    p["chains"] = json!([CHAIN]);
    p["assets"].as_array_mut().unwrap().extend([
        json!({
            "asset": { "Evm": { "chain_id": CHAIN, "token": USDC } },
            "per_tx_cap": "50000000",
            "windows": [{ "period_s": 86_400, "limit": "200000000" }],
            "cosign_above": null, "risk_check_above": null
        }),
        json!({
            "asset": { "Evm": { "chain_id": CHAIN, "token": null } },
            "per_tx_cap": "0",
            "windows": [{ "period_s": 86_400, "limit": (5 * MAX_GAS_COST).to_string() }],
            "cosign_above": null, "risk_check_above": null
        }),
    ]);
    p["recipients"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "Evm": { "chain_id": CHAIN, "address": MERCHANT } }));
    p["evm_gas"] = json!([{ "chain_id": CHAIN, "caps": {
        "max_gas_limit": GAS_LIMIT as u64,
        "max_fee_per_gas": MAX_FEE.to_string(),
        "max_priority_fee_per_gas": PRIORITY.to_string()
    } }]);
    p
}

fn usdc_spend(amount: u128, key: &str) -> Value {
    json!({
        "asset": { "Evm": { "chain_id": CHAIN, "token": USDC } },
        "amount": amount.to_string(),
        "dest": { "Evm": { "chain_id": CHAIN, "to": MERCHANT } },
        "purpose": "api credits",
        "idempotency_key": key
    })
}

fn hex(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn trim(b: &[u8]) -> &[u8] {
    &b[b.iter().position(|x| *x != 0).unwrap_or(b.len())..]
}

fn rlp_prefix(base: u8, len: usize) -> Vec<u8> {
    if len < 56 {
        vec![base + len as u8]
    } else {
        let be = len.to_be_bytes();
        let l = trim(&be);
        let mut out = vec![base + 55 + l.len() as u8];
        out.extend_from_slice(l);
        out
    }
}

fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    let mut out = rlp_prefix(0x80, b.len());
    out.extend_from_slice(b);
    out
}

fn rlp_uint(v: u128) -> Vec<u8> {
    rlp_bytes(trim(&v.to_be_bytes()))
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let body: Vec<u8> = items.concat();
    let mut out = rlp_prefix(0xc0, body.len());
    out.extend(body);
    out
}

struct Tx {
    nonce: u128,
    gas_limit: u128,
    max_fee: u128,
    priority: u128,
    to: Vec<u8>,
    value: u128,
    data: Vec<u8>,
}

impl Tx {
    fn usdc(nonce: u128, amount: u128) -> Self {
        let mut data = hex("a9059cbb");
        data.extend([0u8; 12]);
        data.extend(hex(MERCHANT));
        data.extend([0u8; 16]);
        data.extend(amount.to_be_bytes());
        Self {
            nonce,
            gas_limit: GAS_LIMIT,
            max_fee: MAX_FEE,
            priority: PRIORITY,
            to: hex(USDC),
            value: 0,
            data,
        }
    }

    fn cancel(nonce: u128) -> Self {
        Self {
            nonce,
            gas_limit: 21_000,
            max_fee: MAX_FEE + MAX_FEE / 8,
            priority: PRIORITY + PRIORITY / 8,
            to: hex(MERCHANT),
            value: 0,
            data: Vec::new(),
        }
    }

    fn fields(&self) -> Vec<Vec<u8>> {
        vec![
            rlp_uint(u128::from(CHAIN)),
            rlp_uint(self.nonce),
            rlp_uint(self.priority),
            rlp_uint(self.max_fee),
            rlp_uint(self.gas_limit),
            rlp_bytes(&self.to),
            rlp_uint(self.value),
            rlp_bytes(&self.data),
            rlp_list(&[]),
        ]
    }

    fn signing_hash(&self) -> String {
        let mut unsigned = vec![2u8];
        unsigned.extend(rlp_list(&self.fields()));
        to_hex(&Keccak256::digest(&unsigned))
    }

    /// With the mock signature: v = 1 and `r`, `s` without their leading zeros.
    fn signed(&self) -> String {
        let mut fields = self.fields();
        fields.push(rlp_uint(1));
        fields.push(rlp_bytes(trim(&hex(SIG_R))));
        fields.push(rlp_bytes(trim(&hex(SIG_S))));
        let mut raw = vec![2u8];
        raw.extend(rlp_list(&fields));
        format!("0x{}", to_hex(&raw))
    }
}

async fn request(env: &Env, req_id: u64) -> TestResult<Value> {
    env.view("request", json!({ "req_id": req_id })).await
}

async fn used(env: &Env, asset: Value) -> TestResult<u128> {
    let s: Value = env.view("budget_status", json!({ "asset": asset })).await?;
    Ok(s["windows"][0]["used"].as_str().unwrap().parse()?)
}

fn usdc_asset() -> Value {
    json!({ "Evm": { "chain_id": CHAIN, "token": USDC } })
}

fn gas_asset() -> Value {
    json!({ "Evm": { "chain_id": CHAIN, "token": null } })
}

async fn spend_id(env: &Env, amount: u128, key: &str) -> TestResult<u64> {
    let d = env.spend(usdc_spend(amount, key)).await?;
    Ok(d["Approved"]["req_id"]
        .as_u64()
        .ok_or(format!("not approved: {d}"))?)
}

#[tokio::test]
async fn inv2_contract_signs_only_what_it_built() -> TestResult {
    let env = Env::new(evm_policy).await?;

    let res = env
        .agent_call(
            "request_spend",
            json!({ "request": usdc_spend(40_000_000, "pay-1") }),
            0,
        )
        .await?
        .assert_success();
    assert!(
        res.logs()
            .iter()
            .any(|l| l.contains(r#""event":"signed_tx""#)),
        "{:?}",
        res.logs()
    );
    let id = res.json::<Value>()?["Approved"]["req_id"]
        .as_u64()
        .expect("approved");

    let seen = env.mpc_seen().await?;
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["predecessor"], env.purse.to_string());
    assert_eq!(seen[0]["path"], "evm");
    assert_eq!(seen[0]["domain_id"], 0);
    assert_eq!(seen[0]["payload"], Tx::usdc(0, 40_000_000).signing_hash());

    let req = request(&env, id).await?;
    assert_eq!(req["status"], "Signed");
    assert_eq!(req["evm"]["raw_tx"], Tx::usdc(0, 40_000_000).signed());
    assert_eq!(used(&env, usdc_asset()).await?, 40_000_000);
    assert_eq!(
        used(&env, gas_asset()).await?,
        MAX_GAS_COST,
        "worst-case gas is reserved"
    );

    let id2 = spend_id(&env, 1_000_000, "pay-2").await?;
    assert_eq!(
        env.mpc_seen().await?[1]["payload"],
        Tx::usdc(1, 1_000_000).signing_hash()
    );
    let open: Vec<Value> = env.view("evm_open", json!({})).await?;
    assert_eq!(open.len(), 2);
    assert_eq!(
        open.iter()
            .map(|o| o[0].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [id, id2]
    );

    // Hash smuggling: there is no field for a hash or a prebuilt transaction, and extra fields
    // are refused rather than ignored.
    let mut smuggled = usdc_spend(1, "smuggle-1");
    smuggled["raw_tx"] = json!(Tx::usdc(9, 1).signed());
    let mut payload = usdc_spend(1, "smuggle-2");
    payload["payload"] = json!(Tx::usdc(9, 1).signing_hash());
    let mut data = usdc_spend(1, "smuggle-3");
    data["dest"]["Evm"]["data"] = json!("0xdeadbeef");
    let mut gas = usdc_spend(1, "smuggle-4");
    gas["dest"]["Evm"]["max_fee_per_gas"] = json!("1");
    for (name, req) in [
        ("raw_tx", smuggled),
        ("payload", payload),
        ("data", data),
        ("gas", gas),
    ] {
        assert!(
            refused(
                env.agent_call("request_spend", json!({ "request": req }), 0)
                    .await
            ),
            "{name}"
        );
    }
    let cb = json!({ "req_id": id, "cancel": false });
    assert!(
        refused(env.agent_call("on_evm_signed", cb, 0).await),
        "agent can't reach the callback"
    );
    assert!(refused(
        env.agent_call("cancel_evm", json!({ "req_id": id }), 0)
            .await
    ));
    assert!(refused(
        env.call_as(&env.attacker, "cancel_evm", json!({ "req_id": id }), 1)
            .await
    ));
    assert_eq!(
        env.mpc_seen().await?.len(),
        2,
        "nothing else reached the signer"
    );

    let mut wrong_chain = usdc_spend(1, "chain");
    wrong_chain["dest"]["Evm"]["chain_id"] = json!(1);
    let d = env.spend(wrong_chain).await?;
    assert_eq!(common::deny_reason(&d), json!("AssetDestMismatch"));
    Ok(())
}

#[tokio::test]
async fn evm_gas_budget_stops_fee_spam() -> TestResult {
    let env = Env::new(evm_policy).await?;
    for i in 0..5 {
        spend_id(&env, 1, &format!("tiny-{i}")).await?;
    }
    let d = env.spend(usdc_spend(1, "tiny-5")).await?;
    assert_eq!(
        common::deny_reason(&d),
        json!({ "OverWindow": { "period_s": 86_400, "remaining": "0" } }),
        "the sixth 1-unit transfer would exceed the native gas budget"
    );
    assert_eq!(used(&env, usdc_asset()).await?, 5);
    Ok(())
}

#[tokio::test]
async fn evm_budget_is_held_until_a_cancel_is_confirmed() -> TestResult {
    let env = Env::new(evm_policy).await?;
    let mpc = near_api::Contract(env.mpc.clone());
    let set_fail = |fail: bool| {
        mpc.call_function("set_fail", json!({ "fail": fail }))
            .transaction()
            .with_signer(env.owner.clone(), env.root.clone())
            .send_to(&env.net)
    };

    set_fail(true).await?.assert_success();
    let failed = spend_id(&env, 30_000_000, "fails").await?;
    assert_eq!(request(&env, failed).await?["status"], "SigningFailed");
    assert_eq!(
        used(&env, usdc_asset()).await?,
        30_000_000,
        "a failed signing keeps its budget"
    );
    let nonce: u64 = env.view("evm_nonce", json!({ "chain_id": CHAIN })).await?;
    assert_eq!(nonce, 1, "the nonce is never handed out again");

    set_fail(false).await?.assert_success();
    let ok = spend_id(&env, 10_000_000, "works").await?;
    assert_eq!(request(&env, ok).await?["evm"]["nonce"], 1);
    assert_eq!(
        env.mpc_seen().await?[0]["payload"],
        Tx::usdc(1, 10_000_000).signing_hash()
    );

    let resolve = |req_id: u64, replaced: bool| json!({ "req_id": req_id, "replaced": replaced });
    assert!(
        refused(Ok(env
            .owner_call("resolve_evm", resolve(failed, true))
            .await?)),
        "needs a cancel first"
    );
    assert!(refused(
        env.call_as(&env.attacker, "resolve_evm", resolve(failed, true), 1)
            .await
    ));

    env.owner_call("cancel_evm", json!({ "req_id": failed }))
        .await?
        .assert_success();
    let seen = env.mpc_seen().await?;
    assert_eq!(
        seen[1]["payload"],
        Tx::cancel(0).signing_hash(),
        "same nonce, 0 value, fees +12.5%"
    );
    assert_eq!(
        request(&env, failed).await?["evm"]["cancel_tx"],
        Tx::cancel(0).signed()
    );

    env.owner_call("resolve_evm", resolve(failed, true))
        .await?
        .assert_success();
    assert_eq!(request(&env, failed).await?["status"], "Replaced");
    assert_eq!(used(&env, usdc_asset()).await?, 10_000_000);
    assert_eq!(used(&env, gas_asset()).await?, MAX_GAS_COST);

    env.owner_call("resolve_evm", resolve(ok, false))
        .await?
        .assert_success();
    assert_eq!(
        status(&json!({ request(&env, ok).await?["status"].as_str().unwrap(): 0 })),
        "Done"
    );
    assert_eq!(
        used(&env, usdc_asset()).await?,
        10_000_000,
        "a confirmed spend keeps its budget"
    );
    let open: Vec<Value> = env.view("evm_open", json!({})).await?;
    assert!(open.is_empty());
    Ok(())
}

fn tx_id(raw: &str) -> String {
    to_hex(&Keccak256::digest(hex(raw)))
}

#[tokio::test]
async fn evm_confirm_and_release_need_mpc_verification_not_trust() -> TestResult {
    let env = Env::new(evm_policy).await?;
    let mpc = near_api::Contract(env.mpc.clone());
    let mark_final = |id: String| {
        mpc.call_function("mark_final", json!({ "tx_id": id }))
            .transaction()
            .with_signer(env.owner.clone(), env.root.clone())
            .send_to(&env.net)
    };
    let anyone = |method: &'static str, req_id: u64, deposit: u128| {
        env.call_as(&env.attacker, method, json!({ "req_id": req_id }), deposit)
    };

    let a = spend_id(&env, 40_000_000, "confirm-me").await?;
    let raw_a = request(&env, a).await?["evm"]["raw_tx"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        refused(anyone("confirm_evm", a, 0).await),
        "needs the 1 yocto MPC deposit"
    );
    assert!(
        !anyone("confirm_evm", a, 1)
            .await?
            .assert_success()
            .json::<bool>()?,
        "MPC did not verify"
    );
    assert_eq!(
        request(&env, a).await?["status"],
        "Signed",
        "not final yet: nothing changes"
    );

    mark_final(tx_id(&raw_a)).await?.assert_success();
    anyone("confirm_evm", a, 1).await?.assert_success();
    assert_eq!(request(&env, a).await?["status"], "Done");
    assert_eq!(
        used(&env, usdc_asset()).await?,
        40_000_000,
        "a confirmed spend keeps its budget"
    );
    assert!(
        refused(anyone("confirm_evm", a, 1).await),
        "already resolved"
    );

    let verify: Vec<String> = mpc
        .call_function("verify_requests", ())
        .read_only()
        .fetch_from(&env.net)
        .await?
        .data;
    let sent: Value = near_sdk::serde_json::from_str(verify.last().unwrap())?;
    assert_eq!(
        sent,
        json!({
            "request": { "Base": { "tx_id": tx_id(&raw_a), "extractors": ["BlockHash"], "finality": "Finalized" } },
            "domain_id": 3,
            "payload_version": 1
        })
    );

    let b = spend_id(&env, 10_000_000, "release-me").await?;
    assert!(
        refused(anyone("release_evm", b, 1).await),
        "no cancel signed yet"
    );
    env.owner_call("cancel_evm", json!({ "req_id": b }))
        .await?
        .assert_success();
    let cancel_b = request(&env, b).await?["evm"]["cancel_tx"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        !anyone("release_evm", b, 1)
            .await?
            .assert_success()
            .json::<bool>()?,
        "MPC did not verify"
    );
    assert_eq!(
        used(&env, usdc_asset()).await?,
        50_000_000,
        "unconfirmed cancel releases nothing"
    );

    mark_final(tx_id(&cancel_b)).await?.assert_success();
    anyone("release_evm", b, 1).await?.assert_success();
    assert_eq!(request(&env, b).await?["status"], "Replaced");
    assert_eq!(used(&env, usdc_asset()).await?, 40_000_000);
    let open: Vec<Value> = env.view("evm_open", json!({})).await?;
    assert!(open.is_empty());
    Ok(())
}

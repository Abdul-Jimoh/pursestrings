#![allow(dead_code)]

use std::sync::{Arc, OnceLock};

use near_api::types::transaction::result::TransactionResult;
use near_api::{
    AccountId, Chain, Contract, NearGas, NearToken, NetworkConfig, SecretKey, Signer, Tokens,
};
use near_sandbox::Sandbox;
use near_sdk::serde_json::{Value, json};
use testresult::TestResult;

pub const NEAR: u128 = 10u128.pow(24);

/// near-sdk links the gas-key host functions (protocol 85), which the 2.13 node bundled with
/// near-sandbox 0.3 rejects at deploy time.
pub const SANDBOX_VERSION: &str = "2.14.0";

/// `status` on rpc.mainnet.near.org, 2026-11-01 (testnet is on 88). Every sandbox test runs at
/// this version so tested behaviour is mainnet behaviour; `tests/protocol.rs` also covers 88.
pub const MAINNET_PROTOCOL_VERSION: u32 = 86;

/// `None` runs the node's latest protocol version.
pub async fn start_sandbox_at(protocol_version: Option<u32>) -> TestResult<Sandbox> {
    let config = near_sandbox::SandboxConfig {
        additional_genesis: protocol_version.map(|v| json!({ "protocol_version": v })),
        ..Default::default()
    };
    Ok(Sandbox::start_sandbox_with_config_and_version(config, SANDBOX_VERSION).await?)
}

pub async fn start_sandbox() -> TestResult<Sandbox> {
    start_sandbox_at(Some(MAINNET_PROTOCOL_VERSION)).await
}

pub async fn protocol_version(sandbox: &Sandbox) -> TestResult<u64> {
    let body = json!({ "jsonrpc": "2.0", "id": 0, "method": "status", "params": [] });
    let out = tokio::process::Command::new("curl")
        .args([
            "-s",
            &sandbox.rpc_addr,
            "-H",
            "content-type: application/json",
            "-d",
            &body.to_string(),
        ])
        .output()
        .await?;
    let status: Value = near_sdk::serde_json::from_slice(&out.stdout)?;
    status["result"]["protocol_version"]
        .as_u64()
        .ok_or_else(|| "no protocol_version".into())
}

static WASM: OnceLock<Vec<u8>> = OnceLock::new();
static TOKEN_WASM: OnceLock<Vec<u8>> = OnceLock::new();
static FACTORY_WASM: OnceLock<Vec<u8>> = OnceLock::new();
static MPC_WASM: OnceLock<Vec<u8>> = OnceLock::new();

pub fn wasm() -> Vec<u8> {
    WASM.get_or_init(|| {
        let path = cargo_near_build::build_with_cli(Default::default()).expect("contract build");
        std::fs::read(path).expect("read wasm")
    })
    .clone()
}

fn build(manifest: &str) -> Vec<u8> {
    let opts = cargo_near_build::BuildOpts::builder()
        .manifest_path(manifest)
        .build();
    let path = cargo_near_build::build_with_cli(opts).expect("contract build");
    std::fs::read(path).expect("read wasm")
}

pub fn token_wasm() -> Vec<u8> {
    TOKEN_WASM
        .get_or_init(|| build("../test-token/Cargo.toml"))
        .clone()
}

pub fn mpc_wasm() -> Vec<u8> {
    MPC_WASM
        .get_or_init(|| build("../test-mpc/Cargo.toml"))
        .clone()
}

pub fn factory_wasm() -> Vec<u8> {
    FACTORY_WASM
        .get_or_init(|| build("../factory/Cargo.toml"))
        .clone()
}

pub fn yocto(near_milli: u128) -> String {
    (near_milli * NEAR / 1_000).to_string()
}

/// 2 NEAR per payment, 3 NEAR a day, co-sign above 1.5 NEAR, 10 requests an hour.
pub fn base_policy(shop: &AccountId) -> Value {
    json!({
        "version": 0,
        "frozen": false,
        "assets": [
            {
                "asset": "Near",
                "per_tx_cap": yocto(2_000),
                "windows": [{ "period_s": 86_400, "limit": yocto(3_000) }],
                "cosign_above": yocto(1_500),
                "risk_check_above": null
            },
            {
                "asset": { "Nep141": { "token": "ghost-token.sandbox" } },
                "per_tx_cap": "100",
                "windows": [{ "period_s": 86_400, "limit": "150" }],
                "cosign_above": null,
                "risk_check_above": null
            }
        ],
        "recipients": [
            { "Near": { "account": shop } },
            { "Near": { "account": "ghost.sandbox" } }
        ],
        "chains": [],
        "intent_kinds": [],
        "cooldown_s": 0,
        "velocity": { "max": 10, "period_s": 3_600 },
        "min_rates": [],
        "evm_gas": [],
        "fee_budget": { "period_s": 86_400, "limit": "1000" },
        "pending_ttl_s": 600,
        "timelock_s": 3_600
    })
}

/// The ops that build `policy` from an empty one, in the shape `new` takes.
pub fn policy_ops(policy: &Value) -> Value {
    let mut ops = Vec::new();
    let list = |k: &str| policy[k].as_array().cloned().unwrap_or_default();
    for rule in list("assets") {
        ops.push(json!({ "SetAssetRule": rule }));
    }
    for r in list("recipients") {
        ops.push(json!({ "AddRecipient": r }));
    }
    for c in list("chains") {
        ops.push(json!({ "AddChain": { "chain_id": c } }));
    }
    for k in list("intent_kinds") {
        ops.push(json!({ "AddIntentKind": { "kind": k } }));
    }
    for m in list("min_rates") {
        ops.push(json!({ "SetMinRate": m }));
    }
    for g in list("evm_gas") {
        ops.push(json!({ "SetEvmGas": g }));
    }
    ops.push(json!({ "SetCooldown": { "seconds": policy["cooldown_s"] } }));
    ops.push(json!({ "SetVelocity": { "velocity": policy["velocity"] } }));
    ops.push(json!({ "SetFeeBudget": policy["fee_budget"] }));
    ops.push(json!({ "SetPendingTtl": { "seconds": policy["pending_ttl_s"] } }));
    ops.push(json!({ "SetTimelock": { "seconds": policy["timelock_s"] } }));
    Value::Array(ops)
}

pub struct Env {
    pub sandbox: Sandbox,
    pub net: NetworkConfig,
    pub root: Arc<Signer>,
    pub owner: AccountId,
    pub shop: AccountId,
    pub attacker: AccountId,
    pub purse: AccountId,
    pub mpc: AccountId,
    pub agent_key: SecretKey,
    pub agent: Arc<Signer>,
}

pub type Sent = Result<TransactionResult, String>;

/// The transaction was refused by the protocol or its receipt failed.
pub fn refused(res: Sent) -> bool {
    match res {
        Err(_) => true,
        Ok(r) => r.into_result().is_err(),
    }
}

impl Env {
    pub async fn new(policy: impl FnOnce(&AccountId) -> Value) -> TestResult<Self> {
        let sandbox = start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let root = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
        )?;
        let owner: AccountId = "owner.sandbox".parse()?;
        let shop: AccountId = "shop.sandbox".parse()?;
        let attacker: AccountId = "attacker.sandbox".parse()?;
        let purse: AccountId = "purse.sandbox".parse()?;
        let mpc: AccountId = "mpc.sandbox".parse()?;
        for id in [&owner, &shop, &attacker, &mpc] {
            sandbox.create_account(id.clone()).send().await?;
        }
        Contract::deploy(mpc.clone())
            .use_code(mpc_wasm())
            .without_init_call()
            .with_signer(root.clone())
            .send_to(&net)
            .await?
            .assert_success();
        sandbox
            .create_account(purse.clone())
            .initial_balance(NearToken::from_near(50))
            .send()
            .await?;

        Contract::deploy(purse.clone())
            .use_code(wasm())
            .with_init_call(
                "new",
                json!({ "owner": owner, "mpc": mpc, "ops": policy_ops(&policy(&shop)) }),
            )?
            .with_signer(root.clone())
            .send_to(&net)
            .await?
            .assert_success();

        let agent_key = near_api::signer::generate_secret_key()?;
        let agent = Signer::from_secret_key(agent_key.clone())?;
        let env = Self {
            sandbox,
            net,
            root,
            owner,
            shop,
            attacker,
            purse,
            mpc,
            agent_key,
            agent,
        };
        env.owner_call(
            "add_agent",
            json!({ "public_key": env.agent_key.public_key(), "allowance": yocto(1_000) }),
        )
        .await?
        .assert_success();
        Ok(env)
    }

    pub async fn call_as(&self, who: &AccountId, method: &str, args: Value, deposit: u128) -> Sent {
        Contract(self.purse.clone())
            .call_function(method, args)
            .transaction()
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(NearGas::from_tgas(100))
            .with_signer(who.clone(), self.root.clone())
            .send_to(&self.net)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn owner_call(&self, method: &str, args: Value) -> TestResult<TransactionResult> {
        Ok(self.call_as(&self.owner, method, args, 1).await?)
    }

    /// Signed by the agent's function-call key on the purse account.
    pub async fn agent_call(&self, method: &str, args: Value, deposit: u128) -> Sent {
        Contract(self.purse.clone())
            .call_function(method, args)
            .transaction()
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(NearGas::from_tgas(200))
            .with_signer(self.purse.clone(), self.agent.clone())
            .send_to(&self.net)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn spend(&self, request: Value) -> TestResult<Value> {
        let res = self
            .agent_call("request_spend", json!({ "request": request }), 0)
            .await?;
        Ok(res.assert_success().json()?)
    }

    pub async fn agent_transfer(&self, to: &AccountId, yocto: u128) -> Sent {
        Tokens::account(self.purse.clone())
            .send_to(to.clone())
            .near(NearToken::from_yoctonear(yocto))
            .with_signer(self.agent.clone())
            .send_to(&self.net)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn view<T: near_sdk::serde::de::DeserializeOwned + Send + Sync>(
        &self,
        method: &str,
        args: Value,
    ) -> TestResult<T> {
        Ok(Contract(self.purse.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    pub async fn balance(&self, who: &AccountId) -> TestResult<u128> {
        Ok(Tokens::account(who.clone())
            .near_balance()
            .fetch_from(&self.net)
            .await?
            .total
            .as_yoctonear())
    }

    /// Every signing request the mock MPC contract has received.
    pub async fn mpc_seen(&self) -> TestResult<Vec<Value>> {
        Ok(Contract(self.mpc.clone())
            .call_function("seen", ())
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    pub async fn now_s(&self) -> TestResult<u64> {
        Ok(Chain::block().fetch_from(&self.net).await?.header.timestamp / 1_000_000_000)
    }

    /// Sandbox blocks advance chain time by roughly 0.3 s each.
    pub async fn advance(&self, secs: u64) -> TestResult {
        let target = self.now_s().await? + secs;
        self.sandbox.fast_forward(secs * 3).await?;
        while self.now_s().await? < target {
            self.sandbox.fast_forward(20).await?;
        }
        Ok(())
    }
}

pub fn near_spend(to: &AccountId, near_milli: u128, key: &str) -> Value {
    json!({
        "asset": "Near",
        "amount": yocto(near_milli),
        "dest": { "Near": { "account": to } },
        "purpose": "test",
        "idempotency_key": key
    })
}

pub fn status(decision: &Value) -> &str {
    decision
        .as_object()
        .and_then(|o| o.keys().next())
        .map_or("", String::as_str)
}

pub fn deny_reason(decision: &Value) -> Value {
    decision["Denied"]["reason"].clone()
}

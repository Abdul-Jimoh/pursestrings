//! Deploys the contract on a sandbox pinned to mainnet's current protocol version, so an SDK
//! upgrade that imports host functions mainnet hasn't enabled yet fails here first.

mod common;

use common::{SANDBOX_VERSION, base_policy, factory_wasm, policy_ops, wasm};
use near_api::{AccountId, Contract, NearToken, NetworkConfig, Signer};
use near_sandbox::{Sandbox, SandboxConfig};
use near_sdk::serde_json::json;
use testresult::TestResult;

/// `status` on rpc.mainnet.near.org, 2026-11-01.
const MAINNET_PROTOCOL_VERSION: u32 = 86;

#[tokio::test]
/// Imports are linked when the module is instantiated, so a successful init covers all of them.
async fn deploys_at_mainnet_protocol_version() -> TestResult {
    let config = SandboxConfig {
        additional_genesis: Some(json!({ "protocol_version": MAINNET_PROTOCOL_VERSION })),
        ..Default::default()
    };
    let sandbox = Sandbox::start_sandbox_with_config_and_version(config, SANDBOX_VERSION).await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let status: near_sdk::serde_json::Value = rpc_status(&sandbox.rpc_addr).await?;
    assert_eq!(status["protocol_version"], MAINNET_PROTOCOL_VERSION);

    let root = Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
    )?;
    let owner: AccountId = "owner.sandbox".parse()?;
    let shop: AccountId = "shop.sandbox".parse()?;
    let purse: AccountId = "purse.sandbox".parse()?;
    sandbox.create_account(owner.clone()).send().await?;
    sandbox
        .create_account(purse.clone())
        .initial_balance(NearToken::from_near(20))
        .send()
        .await?;

    Contract::deploy(purse.clone())
        .use_code(wasm())
        .with_init_call(
            "new",
            json!({ "owner": owner, "ops": policy_ops(&base_policy(&shop)) }),
        )?
        .with_signer(root.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let factory: AccountId = "factory.sandbox".parse()?;
    sandbox.create_account(factory.clone()).send().await?;
    Contract::deploy(factory)
        .use_code(factory_wasm())
        .with_init_call("new", json!({ "admin": owner }))?
        .with_signer(root)
        .send_to(&net)
        .await?
        .assert_success();
    Ok(())
}

async fn rpc_status(rpc: &str) -> TestResult<near_sdk::serde_json::Value> {
    let body = json!({ "jsonrpc": "2.0", "id": 0, "method": "status", "params": [] });
    let out = tokio::process::Command::new("curl")
        .args([
            "-s",
            rpc,
            "-H",
            "content-type: application/json",
            "-d",
            &body.to_string(),
        ])
        .output()
        .await?;
    Ok(
        near_sdk::serde_json::from_slice::<near_sdk::serde_json::Value>(&out.stdout)?["result"]
            .clone(),
    )
}

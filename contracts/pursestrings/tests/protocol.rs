//! Deploys both contracts at mainnet's protocol version and at the node's latest (testnet's),
//! so an SDK upgrade that imports host functions a network hasn't enabled fails here first.
//! Imports are linked when the module is instantiated, so a successful init covers all of them.

mod common;

use common::{
    MAINNET_PROTOCOL_VERSION, base_policy, factory_wasm, policy_ops, protocol_version,
    start_sandbox_at, wasm,
};
use near_api::{AccountId, Contract, NearToken, NetworkConfig, Signer};
use near_sandbox::Sandbox;
use near_sdk::serde_json::json;
use testresult::TestResult;

const TESTNET_PROTOCOL_VERSION: u64 = 88;

async fn deploy_both(sandbox: &Sandbox) -> TestResult {
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let root = Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
    )?;
    let owner: AccountId = "owner.sandbox".parse()?;
    let shop: AccountId = "shop.sandbox".parse()?;
    let purse: AccountId = "purse.sandbox".parse()?;
    let factory: AccountId = "factory.sandbox".parse()?;
    sandbox.create_account(owner.clone()).send().await?;
    sandbox
        .create_account(purse.clone())
        .initial_balance(NearToken::from_near(20))
        .send()
        .await?;
    sandbox.create_account(factory.clone()).send().await?;

    Contract::deploy(purse)
        .use_code(wasm())
        .with_init_call(
            "new",
            json!({ "owner": owner, "ops": policy_ops(&base_policy(&shop)) }),
        )?
        .with_signer(root.clone())
        .send_to(&net)
        .await?
        .assert_success();
    Contract::deploy(factory)
        .use_code(factory_wasm())
        .with_init_call("new", json!({ "admin": owner }))?
        .with_signer(root)
        .send_to(&net)
        .await?
        .assert_success();
    Ok(())
}

#[tokio::test]
async fn deploys_at_mainnet_protocol_version() -> TestResult {
    let sandbox = start_sandbox_at(Some(MAINNET_PROTOCOL_VERSION)).await?;
    assert_eq!(
        protocol_version(&sandbox).await?,
        u64::from(MAINNET_PROTOCOL_VERSION)
    );
    deploy_both(&sandbox).await
}

#[tokio::test]
async fn deploys_at_testnet_protocol_version() -> TestResult {
    let sandbox = start_sandbox_at(None).await?;
    assert!(protocol_version(&sandbox).await? >= TESTNET_PROTOCOL_VERSION);
    deploy_both(&sandbox).await
}

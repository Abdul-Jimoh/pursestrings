use near_api::{AccountId, Contract, NetworkConfig, Signer};
use near_sandbox::Sandbox;
use near_sdk::serde_json::json;
use testresult::TestResult;

#[tokio::test]
async fn deploys_and_cannot_be_reinitialised() -> TestResult {
    let wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let wasm = std::fs::read(wasm_path)?;

    let sandbox = Sandbox::start_sandbox().await?;
    let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
    )?;

    let owner: AccountId = "owner.sandbox".parse()?;
    let attacker: AccountId = "attacker.sandbox".parse()?;
    let contract_id: AccountId = "purse.sandbox".parse()?;
    for id in [&owner, &attacker, &contract_id] {
        sandbox.create_account(id.clone()).send().await?;
    }

    Contract::deploy(contract_id.clone())
        .use_code(wasm)
        .with_init_call("new", json!({ "owner": owner }))?
        .with_signer(signer.clone())
        .send_to(&network)
        .await?
        .assert_success();

    let contract = Contract(contract_id);
    let got: AccountId = contract
        .call_function("owner", ())
        .read_only()
        .fetch_from(&network)
        .await?
        .data;
    assert_eq!(got, owner);

    contract
        .call_function("new", json!({ "owner": attacker }))
        .transaction()
        .with_signer(attacker.clone(), signer)
        .send_to(&network)
        .await?
        .assert_failure();

    let got: AccountId = contract
        .call_function("owner", ())
        .read_only()
        .fetch_from(&network)
        .await?
        .data;
    assert_eq!(got, owner);
    Ok(())
}

//! Sandbox tests for invariant 7: accounts made by the factory run published code, have no
//! access keys, and change code only through a timelocked, factory-checked migration.

mod common;

use std::sync::Arc;

use common::{base_policy, factory_wasm, policy_ops, refused, token_wasm, wasm};
use near_api::types::CryptoHash;
use near_api::types::account::ContractState;
use near_api::{Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::Sandbox;
use near_sdk::serde_json::{Value, json};
use testresult::TestResult;

type TxResult = near_api::types::transaction::result::TransactionResult;

struct Setup {
    sandbox: Sandbox,
    net: NetworkConfig,
    root: Arc<Signer>,
    factory: AccountId,
    admin: AccountId,
    creator: AccountId,
    owner: AccountId,
    code: Vec<u8>,
    hash: CryptoHash,
}

impl Setup {
    async fn new() -> TestResult<Self> {
        let sandbox = common::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let root = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
        )?;
        let factory: AccountId = "factory.sandbox".parse()?;
        let admin: AccountId = "admin.sandbox".parse()?;
        let creator: AccountId = "creator.sandbox".parse()?;
        let owner: AccountId = "owner.sandbox".parse()?;
        sandbox
            .create_account(factory.clone())
            .initial_balance(NearToken::from_near(20))
            .send()
            .await?;
        sandbox
            .create_account(creator.clone())
            .initial_balance(NearToken::from_near(50))
            .send()
            .await?;
        for id in [&admin, &owner] {
            sandbox.create_account(id.clone()).send().await?;
        }
        Contract::deploy(factory.clone())
            .use_code(factory_wasm())
            .with_init_call("new", json!({ "admin": admin }))?
            .with_signer(root.clone())
            .send_to(&net)
            .await?
            .assert_success();
        // Locks the factory the way a real deployment does: once its only key is gone, nobody
        // can redeploy it.
        let genesis_pk = near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
            .parse::<near_api::SecretKey>()?
            .public_key();
        Account(factory.clone())
            .delete_key(genesis_pk)
            .with_signer(root.clone())
            .send_to(&net)
            .await?
            .assert_success();
        let code = wasm();
        let hash = CryptoHash::hash(&code);
        let s = Self {
            sandbox,
            net,
            root,
            factory,
            admin,
            creator,
            owner,
            code,
            hash,
        };
        s.call(
            &s.admin.clone(),
            "publish",
            json!({ "code_hash": hash.to_string(), "version": "0.1.0" }),
            1,
        )
        .await?
        .assert_success();
        Ok(s)
    }

    async fn call(
        &self,
        who: &AccountId,
        method: &str,
        args: Value,
        deposit: u128,
    ) -> TestResult<near_api::types::transaction::result::TransactionResult> {
        self.call_on(&self.factory, who, method, args, deposit)
            .await
    }

    async fn call_on(
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
            .with_signer(who.clone(), self.root.clone())
            .send_to(&self.net)
            .await?)
    }

    fn new_args(&self, policy: Value) -> Vec<u8> {
        json!({ "owner": self.owner, "mpc": "mpc.sandbox", "intents": "intents.sandbox", "ops": policy_ops(&policy) })
            .to_string()
            .into_bytes()
    }

    async fn create(&self, name: &str, code: &[u8], policy: Value) -> TestResult<TxResult> {
        let args = near_sdk::borsh::to_vec(&(name, code, self.new_args(policy)))?;
        Ok(Contract(self.factory.clone())
            .call_function_raw("create", args)
            .transaction()
            .deposit(NearToken::from_near(7))
            .gas(NearGas::from_tgas(300))
            .with_signer(self.creator.clone(), self.root.clone())
            .send_to(&self.net)
            .await?)
    }

    async fn code_of(&self, id: &AccountId) -> TestResult<ContractState> {
        Ok(Account(id.clone())
            .view()
            .fetch_from(&self.net)
            .await?
            .data
            .contract_state)
    }

    async fn now_s(&self) -> TestResult<u64> {
        Ok(near_api::Chain::block()
            .fetch_from(&self.net)
            .await?
            .header
            .timestamp
            / 1_000_000_000)
    }

    async fn advance(&self, secs: u64) -> TestResult {
        let target = self.now_s().await? + secs;
        self.sandbox.fast_forward(secs * 3).await?;
        while self.now_s().await? < target {
            self.sandbox.fast_forward(20).await?;
        }
        Ok(())
    }
}

fn shop() -> AccountId {
    "shop.sandbox".parse().unwrap()
}

/// Whether the transaction's last receipt (the factory's `on_create` callback) returned true.
fn created(res: near_api::types::transaction::result::TransactionResult) -> TestResult<bool> {
    Ok(res.assert_success().json::<bool>()?)
}

#[tokio::test]
async fn inv7_factory_accounts_have_no_keys_and_published_code() -> TestResult {
    let s = Setup::new().await?;
    let factory_keys = Account(s.factory.clone())
        .list_keys()
        .fetch_from(&s.net)
        .await?
        .data;
    assert!(
        factory_keys.is_empty(),
        "factory is locked: {factory_keys:?}"
    );
    let unpublished = CryptoHash::hash(b"anything");
    assert!(refused(Ok(s
        .call(
            &s.creator.clone(),
            "publish",
            json!({ "code_hash": unpublished.to_string(), "version": "x" }),
            1
        )
        .await?)));

    assert!(created(
        s.create("alice", &s.code, base_policy(&shop())).await?
    )?);
    let alice: AccountId = "alice.factory.sandbox".parse()?;

    let keys = Account(alice.clone())
        .list_keys()
        .fetch_from(&s.net)
        .await?
        .data;
    assert!(
        keys.is_empty(),
        "factory account must have no access keys: {keys:?}"
    );
    assert_eq!(s.code_of(&alice).await?, ContractState::LocalHash(s.hash));
    let owner: AccountId = Contract(alice.clone())
        .call_function("owner", ())
        .read_only()
        .fetch_from(&s.net)
        .await?
        .data;
    assert_eq!(owner, s.owner);
    let factory: AccountId = Contract(alice.clone())
        .call_function("factory", ())
        .read_only()
        .fetch_from(&s.net)
        .await?
        .data;
    assert_eq!(factory, s.factory);
    assert!(
        refused(Ok(s
            .call_on(
                &alice,
                &s.creator.clone(),
                "new",
                json!({ "owner": s.creator, "ops": [] }),
                0
            )
            .await?)),
        "re-init"
    );

    let before = near_api::Tokens::account(s.creator.clone())
        .near_balance()
        .fetch_from(&s.net)
        .await?
        .total
        .as_yoctonear();
    assert!(
        refused(Ok(s
            .create("bob", &token_wasm(), base_policy(&shop()))
            .await?)),
        "unpublished code"
    );
    assert!(
        !created(s.create("alice", &s.code, base_policy(&shop())).await?)?,
        "existing name"
    );
    let after = near_api::Tokens::account(s.creator.clone())
        .near_balance()
        .fetch_from(&s.net)
        .await?
        .total
        .as_yoctonear();
    assert!(
        before - after < common::NEAR / 10,
        "failed creates refund the deposit (spent {})",
        before - after
    );
    assert!(
        Account("bob.factory.sandbox".parse()?)
            .view()
            .fetch_from(&s.net)
            .await
            .is_err()
    );
    assert!(
        refused(Ok(s.create("a.b", &s.code, base_policy(&shop())).await?)),
        "dotted name"
    );
    Ok(())
}

#[tokio::test]
async fn inv7_migration_is_timelocked_and_factory_checked() -> TestResult {
    let s = Setup::new().await?;
    let mut policy = base_policy(&shop());
    policy["timelock_s"] = json!(60);
    assert!(created(s.create("alice", &s.code, policy).await?)?);
    let alice: AccountId = "alice.factory.sandbox".parse()?;
    let owner = s.owner.clone();
    let call = |method: &'static str, args: Value| {
        let (s, alice, owner) = (&s, alice.clone(), owner.clone());
        async move { s.call_on(&alice, &owner, method, args, 1).await }
    };
    let apply_migration_as = |signer: AccountId, id: u64, code: Vec<u8>| {
        let (s, alice) = (&s, alice.clone());
        async move {
            let args = near_sdk::borsh::to_vec(&(id, code))?;
            Ok::<_, Box<dyn std::error::Error>>(
                Contract(alice)
                    .call_function_raw("apply_migration", args)
                    .transaction()
                    .deposit(NearToken::from_yoctonear(1))
                    .gas(NearGas::from_tgas(300))
                    .with_signer(signer, s.root.clone())
                    .send_to(&s.net)
                    .await?,
            )
        }
    };
    let apply_migration = |id: u64, code: Vec<u8>| apply_migration_as(owner.clone(), id, code);

    let migrate = json!({ "ops": [{ "Migrate": { "code_hash": s.hash.to_string() } }] });
    let migrate = &migrate;
    let mixed = json!({ "ops": [{ "Migrate": { "code_hash": s.hash.to_string() } }, { "AddChain": { "chain_id": 1 } }] });
    assert!(
        refused(Ok(call("propose", mixed).await?)),
        "migration must be alone"
    );
    let id: Option<u64> = call("propose", migrate.clone())
        .await?
        .assert_success()
        .json()?;
    let id = id.expect("migration is a loosening");
    assert!(refused(Ok(
        call("apply_proposal", json!({ "id": id })).await?
    )));
    assert!(
        refused(Ok(apply_migration(id, s.code.clone()).await?)),
        "before eta"
    );

    let token = token_wasm();
    let rogue =
        json!({ "ops": [{ "Migrate": { "code_hash": CryptoHash::hash(&token).to_string() } }] });
    let rogue_id: Option<u64> = call("propose", rogue).await?.assert_success().json()?;
    s.advance(61).await?;

    assert!(
        refused(Ok(apply_migration(id, token.clone()).await?)),
        "code must match the hash"
    );
    assert!(
        refused(Ok(apply_migration(rogue_id.unwrap(), token).await?)),
        "unpublished hash"
    );
    assert_eq!(s.code_of(&alice).await?, ContractState::LocalHash(s.hash));

    call("freeze", json!({})).await?.assert_success();
    assert!(
        refused(Ok(apply_migration_as(
            s.creator.clone(),
            id,
            s.code.clone()
        )
        .await?)),
        "a freeze cancels a due migration"
    );
    let queued: Vec<Value> = Contract(alice.clone())
        .call_function("proposals", ())
        .read_only()
        .fetch_from(&s.net)
        .await?
        .data;
    assert!(queued.is_empty(), "a freeze cancels everything queued");
    let unfreeze: Option<u64> = call("propose", json!({ "ops": ["Unfreeze"] }))
        .await?
        .assert_success()
        .json()?;
    s.advance(61).await?;
    call("apply_proposal", json!({ "id": unfreeze.expect("queued") }))
        .await?
        .assert_success();
    let id: Option<u64> = call("propose", migrate.clone())
        .await?
        .assert_success()
        .json()?;
    let id = id.expect("queued again");
    s.advance(61).await?;

    let res = apply_migration_as(s.creator.clone(), id, s.code.clone())
        .await?
        .assert_success();
    assert!(
        res.receipt_failures().is_empty(),
        "deploy + migrate batch succeeded"
    );
    assert!(
        res.logs()
            .iter()
            .any(|l| l.contains(r#""event":"migrating""#)),
        "{:?}",
        res.logs()
    );
    assert_eq!(s.code_of(&alice).await?, ContractState::LocalHash(s.hash));
    let proposals: Vec<Value> = Contract(alice.clone())
        .call_function("proposals", ())
        .read_only()
        .fetch_from(&s.net)
        .await?
        .data;
    assert!(
        proposals.is_empty(),
        "the freeze cancelled the rogue proposal too"
    );
    let p: Value = Contract(alice.clone())
        .call_function("policy", ())
        .read_only()
        .fetch_from(&s.net)
        .await?
        .data;
    assert_eq!(p["timelock_s"], 60, "state survives the migration");

    // Once a newer build is published, the older one stays published but can't be moved back to.
    let newer = CryptoHash::hash(&token_wasm());
    s.call(
        &s.admin.clone(),
        "publish",
        json!({ "code_hash": newer.to_string(), "version": "0.2.0" }),
        1,
    )
    .await?
    .assert_success();
    let back: Option<u64> = call("propose", migrate.clone())
        .await?
        .assert_success()
        .json()?;
    s.advance(61).await?;
    assert!(
        refused(Ok(apply_migration_as(
            s.creator.clone(),
            back.expect("queued"),
            s.code.clone()
        )
        .await?)),
        "no downgrades: only the factory's newest release"
    );
    assert_eq!(s.code_of(&alice).await?, ContractState::LocalHash(s.hash));
    Ok(())
}

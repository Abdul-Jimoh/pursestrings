//! A local NEAR sandbox with everything Pursestrings talks to: the factory, keyless accounts made
//! by it (a procurement agent's, a shop's and a community bounty board's), the `intents.near` and
//! Sputnik DAO code deployed on mainnet, two test tokens and a stand-in MPC signer. Writes what
//! clients need to `.devnet/devnet.json`, then runs until stopped.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use near_api::types::CryptoHash;
use near_api::{Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::Sandbox;
use serde_json::{Value, json};

type Result<T = ()> = std::result::Result<T, Box<dyn Error>>;

/// The node near-sdk 5.29 wasm needs, at the protocol version mainnet runs.
const SANDBOX_VERSION: &str = "2.14.0";
const PROTOCOL_VERSION: u32 = 86;
const BASE_SEPOLIA: u64 = 84_532;
/// Circle's USDC on Base Sepolia.
const BASE_USDC: &str = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
/// "MERCHANT" in ASCII; the demo's allowlisted Base payee.
const MERCHANT: &str = "0x4d45524348414e54000000000000000000000001";
const USDC: u128 = 1_000_000;
const WNEAR: u128 = 10u128.pow(24);
const MILLI_NEAR: u128 = 10u128.pow(21);
const DAY: u32 = 86_400;

struct Net {
    sandbox: Sandbox,
    net: NetworkConfig,
    root: Arc<Signer>,
}

impl Net {
    fn id(name: &str) -> AccountId {
        format!("{name}.sandbox").parse().expect("account id")
    }

    async fn account(&self, name: &str, near: u128) -> Result<AccountId> {
        let id = Self::id(name);
        self.sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(near))
            .send()
            .await?;
        Ok(id)
    }

    async fn deploy(&self, id: &AccountId, code: Vec<u8>, init: Option<Value>) -> Result {
        let deploy = Contract::deploy(id.clone()).use_code(code);
        let res = match init {
            Some(args) => {
                deploy
                    .with_init_call("new", args)?
                    .with_signer(self.root.clone())
                    .send_to(&self.net)
                    .await?
            }
            None => {
                deploy
                    .without_init_call()
                    .with_signer(self.root.clone())
                    .send_to(&self.net)
                    .await?
            }
        };
        res.assert_success();
        Ok(())
    }

    async fn call(
        &self,
        who: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> Result<Value> {
        let res = Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(NearGas::from_tgas(300))
            .with_signer(who.clone(), self.root.clone())
            .send_to(&self.net)
            .await?
            .assert_success();
        Ok(res.json().unwrap_or(Value::Null))
    }
}

fn root_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn build(contract: &str) -> Result<Vec<u8>> {
    let manifest = root_dir()
        .join("contracts")
        .join(contract)
        .join("Cargo.toml");
    let opts = cargo_near_build::BuildOpts::builder()
        .manifest_path(manifest.to_string_lossy().into_owned())
        .build();
    let path = cargo_near_build::build_with_cli(opts)?;
    Ok(std::fs::read(path)?)
}

fn usdc(n: u128) -> String {
    (n * USDC).to_string()
}

fn milli(n: u128) -> String {
    (n * MILLI_NEAR).to_string()
}

/// A shop selling "Check before you pay": a price floor the agent can't quote under, 70% of each
/// sale to the owner and 20% to the community DAO, refunds capped per day.
fn shop_ops(owner: &AccountId, dao: &AccountId) -> Value {
    json!([
        { "SetAssetRule": {
            "asset": "Near",
            "per_tx_cap": milli(200),
            "windows": [{ "period_s": DAY, "limit": milli(500) }],
            "cosign_above": milli(100),
            "risk_check_above": null
        }},
        { "SetPriceFloor": { "asset": "Near", "min": milli(50) } },
        { "SetSplit": { "shares": [
            { "account": owner, "bps": 7_000 },
            { "account": dao, "bps": 2_000 }
        ]}},
        { "SetRefundLimit": { "asset": "Near", "window": { "period_s": DAY, "limit": milli(300) } } },
        { "SetVelocity": { "velocity": { "max": 20, "period_s": 3_600 } } },
        { "SetFeeBudget": { "period_s": DAY, "limit": "1000" } },
        { "SetPendingTtl": { "seconds": 1_800 } },
        { "SetDeliveryWindow": { "seconds": 600 } },
        { "SetTimelock": { "seconds": 3_600 } }
    ])
}

/// The DAO's bounty board: who approves a payout depends on the claimant's earned points.
fn board_ops(council: &[&AccountId]) -> Value {
    let mut ops = vec![json!({ "SetAssetRule": {
        "asset": "Near",
        "per_tx_cap": milli(1_000),
        "windows": [{ "period_s": DAY, "limit": milli(3_000) }],
        "cosign_above": null,
        "risk_check_above": null
    }})];
    ops.extend(
        council
            .iter()
            .map(|a| json!({ "AddCouncil": { "account": a } })),
    );
    ops.extend([
        json!({ "SetTrust": { "asset": "Near", "tiers": [
            { "points": 0, "auto_up_to": "0", "council_up_to": milli(300) },
            { "points": 1, "auto_up_to": milli(100), "council_up_to": milli(500) },
            { "points": 3, "auto_up_to": milli(300), "council_up_to": milli(1_000) }
        ]}}),
        json!({ "SetVelocity": { "velocity": { "max": 20, "period_s": 3_600 } } }),
        json!({ "SetPendingTtl": { "seconds": DAY } }),
        json!({ "SetTimelock": { "seconds": 3_600 } }),
    ]);
    Value::Array(ops)
}

/// The demo procurement agent's policy: $150 a day of USDC wherever it's spent, at most $100 a
/// day and $50 a payment on each rail, the owner co-signs anything over $40, ten payments an
/// hour.
fn policy_ops() -> Value {
    let usdc_near = json!({ "Nep141": { "token": "usdc.sandbox" } });
    let usdc_base = json!({ "Evm": { "chain_id": BASE_SEPOLIA, "token": BASE_USDC } });
    let usdc_intents = json!({ "Intents": { "token": "nep141:usdc.sandbox" } });
    let eth_base = json!({ "Evm": { "chain_id": BASE_SEPOLIA, "token": null } });
    let usd_rule = |asset: &Value| {
        json!({ "SetAssetRule": {
            "asset": asset,
            "per_tx_cap": usdc(50),
            "windows": [{ "period_s": DAY, "limit": usdc(100) }],
            "cosign_above": usdc(40),
            "risk_check_above": null
        }})
    };
    let member = |asset: &Value| json!({ "asset": asset, "decimals": 6 });
    json!([
        usd_rule(&usdc_near),
        usd_rule(&usdc_base),
        usd_rule(&usdc_intents),
        { "SetAssetRule": {
            "asset": eth_base,
            "per_tx_cap": "0",
            "windows": [{ "period_s": DAY, "limit": "1000000000000000" }],
            "cosign_above": null,
            "risk_check_above": null
        }},
        { "SetGroup": {
            "name": "usd",
            "decimals": 6,
            "members": [member(&usdc_near), member(&usdc_base), member(&usdc_intents)],
            "windows": [{ "period_s": DAY, "limit": usdc(150) }]
        }},
        { "AddRecipient": { "Near": { "account": "shop.sandbox" } } },
        { "AddRecipient": { "Evm": { "chain_id": BASE_SEPOLIA, "address": MERCHANT } } },
        { "AddChain": { "chain_id": BASE_SEPOLIA } },
        { "AddIntentKind": { "kind": "Swap" } },
        { "SetMinRate": {
            "sell": "nep141:usdc.sandbox",
            "buy": "nep141:wrap.sandbox",
            "rate": { "num": (WNEAR / 5 / USDC).to_string(), "den": "1" }
        }},
        { "SetEvmGas": { "chain_id": BASE_SEPOLIA, "caps": {
            "max_gas_limit": 100_000,
            "max_fee_per_gas": "1000000000",
            "max_priority_fee_per_gas": "100000000"
        }}},
        { "SetVelocity": { "velocity": { "max": 10, "period_s": 3_600 } } },
        { "SetFeeBudget": { "period_s": DAY, "limit": "1000" } },
        { "SetPendingTtl": { "seconds": 3_600 } },
        { "SetTimelock": { "seconds": DAY } }
    ])
}

#[tokio::main]
async fn main() -> Result {
    let out = root_dir().join(".devnet");
    std::fs::create_dir_all(&out)?;
    let ready = out.join("devnet.json");
    let _ = std::fs::remove_file(&ready);

    eprintln!("building contracts…");
    let (purse_code, factory_code) = (build("pursestrings")?, build("factory")?);
    let (token_code, mpc_code) = (build("test-token")?, build("test-mpc")?);
    let intents_code =
        std::fs::read(root_dir().join("contracts/pursestrings/tests/fixtures/intents-0.4.5.wasm"))?;

    eprintln!("starting sandbox {SANDBOX_VERSION} at protocol {PROTOCOL_VERSION}…");
    let config = near_sandbox::SandboxConfig {
        additional_genesis: Some(json!({ "protocol_version": PROTOCOL_VERSION })),
        ..Default::default()
    };
    let sandbox = Sandbox::start_sandbox_with_config_and_version(config, SANDBOX_VERSION).await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let secret = near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY;
    let root = Signer::from_secret_key(secret.parse()?)?;
    let n = Net { sandbox, net, root };
    let one_yocto = NearToken::from_yoctonear(1);
    let zero = NearToken::from_yoctonear(0);

    let owner = n.account("owner", 100).await?;
    let factory = n.account("factory", 20).await?;
    let intents = n.account("intents", 30).await?;
    let mpc = n.account("mpc", 10).await?;
    let usdc_token = n.account("usdc", 10).await?;
    let wrap = n.account("wrap", 10).await?;
    let shop = n.account("shop", 10).await?;
    let solver = n.account("solver", 10).await?;
    let attacker = n.account("attacker", 10).await?;

    n.deploy(&mpc, mpc_code, None).await?;
    n.call(&owner, &mpc, "use_real_ecdsa", json!({}), zero)
        .await?;
    n.deploy(
        &intents,
        intents_code,
        Some(json!({ "config": {
            "wnear_id": wrap,
            "fees": { "fee": 0, "fee_collector": owner },
            "roles": {}
        }})),
    )
    .await?;
    let supply = |holder: &AccountId, amount: u128| json!({ "holder": holder, "total_supply": amount.to_string() });
    n.deploy(
        &usdc_token,
        token_code.clone(),
        Some(supply(&owner, 1_000_000 * USDC)),
    )
    .await?;
    n.deploy(&wrap, token_code, Some(supply(&solver, 1_000 * WNEAR)))
        .await?;

    eprintln!("creating a locked factory and a keyless account…");
    n.deploy(&factory, factory_code, Some(json!({ "admin": owner })))
        .await?;
    let genesis_pk = secret.parse::<near_api::SecretKey>()?.public_key();
    Account(factory.clone())
        .delete_key(genesis_pk)
        .with_signer(n.root.clone())
        .send_to(&n.net)
        .await?
        .assert_success();
    let code_hash = CryptoHash::hash(&purse_code).to_string();
    n.call(
        &owner,
        &factory,
        "publish",
        json!({ "code_hash": code_hash, "version": env!("CARGO_PKG_VERSION") }),
        one_yocto,
    )
    .await?;
    let create = |name: &'static str, account_owner: &AccountId, ops: Value| {
        let new_args =
            json!({ "owner": account_owner, "mpc": mpc, "intents": intents, "ops": ops });
        let args = borsh::to_vec(&(name, &purse_code, new_args.to_string().into_bytes()));
        let (n, factory, owner) = (&n, factory.clone(), owner.clone());
        async move {
            Contract(factory.clone())
                .call_function_raw("create", args?)
                .transaction()
                .deposit(NearToken::from_near(8))
                .gas(NearGas::from_tgas(300))
                .with_signer(owner, n.root.clone())
                .send_to(&n.net)
                .await?
                .assert_success();
            Ok::<AccountId, Box<dyn Error>>(format!("{name}.{factory}").parse()?)
        }
    };
    let purse = create("procurement", &owner, policy_ops()).await?;

    let agent_key = near_api::signer::generate_secret_key()?;
    n.call(
        &owner,
        &purse,
        "add_agent",
        json!({ "public_key": agent_key.public_key(), "allowance": NearToken::from_near(1).as_yoctonear().to_string() }),
        one_yocto,
    )
    .await?;
    n.call(&owner, &purse, "register_intents_key", json!({}), one_yocto)
        .await?;

    eprintln!("funding the account…");
    for (token, who) in [
        (&usdc_token, &intents),
        (&usdc_token, &shop),
        (&usdc_token, &purse),
        (&usdc_token, &solver),
        (&wrap, &intents),
        (&wrap, &purse),
        (&wrap, &owner),
    ] {
        n.call(
            &owner,
            token,
            "register",
            json!({ "account_id": who }),
            zero,
        )
        .await?;
    }
    n.call(
        &owner,
        &usdc_token,
        "ft_transfer",
        json!({ "receiver_id": purse, "amount": usdc(200) }),
        one_yocto,
    )
    .await?;
    for (from, token, to, amount) in [
        (&owner, &usdc_token, &purse, 200 * USDC),
        (&solver, &wrap, &solver, 100 * WNEAR),
    ] {
        n.call(
            from,
            token,
            "ft_transfer_call",
            json!({ "receiver_id": intents, "amount": amount.to_string(), "msg": to }),
            one_yocto,
        )
        .await?;
    }

    eprintln!("creating the shop, the community DAO and its bounty board…");
    let dao = n.account("community", 20).await?;
    let council = n.account("council", 10).await?;
    let steward = n.account("steward", 10).await?;
    let buyer = n.account("buyer", 10).await?;
    let newcomer = n.account("newcomer", 10).await?;
    n.deploy(
        &dao,
        std::fs::read(
            root_dir().join("contracts/pursestrings/tests/fixtures/sputnikdao2-3.2.wasm"),
        )?,
        Some(json!({
            "config": { "name": "community", "purpose": "grows the scam list", "metadata": "" },
            "policy": [council, steward]
        })),
    )
    .await?;
    let shop_account = create("checks", &owner, shop_ops(&owner, &dao)).await?;
    let shop_agent = near_api::signer::generate_secret_key()?;
    n.call(
        &owner,
        &shop_account,
        "add_agent",
        json!({ "public_key": shop_agent.public_key(), "allowance": milli(1_000) }),
        one_yocto,
    )
    .await?;
    let board = create("bounties", &dao, board_ops(&[&council, &steward])).await?;
    let board_agent = near_api::signer::generate_secret_key()?;
    // The DAO owns the board, so adding its agent takes a proposal and the council's vote.
    let add_agent = json!({ "public_key": board_agent.public_key(), "allowance": milli(1_000) });
    let kind = json!({ "FunctionCall": {
        "receiver_id": board,
        "actions": [{
            "method_name": "add_agent",
            "args": near_api::types::json::Base64VecU8(add_agent.to_string().into_bytes()),
            "deposit": "1",
            "gas": "100000000000000"
        }]
    }});
    let id = n
        .call(
            &council,
            &dao,
            "add_proposal",
            json!({ "proposal": { "description": "add the bounty agent", "kind": kind } }),
            NearToken::from_near(1),
        )
        .await?;
    for member in [&council, &steward] {
        n.call(
            member,
            &dao,
            "act_proposal",
            json!({ "id": id, "action": "VoteApprove", "proposal": kind }),
            zero,
        )
        .await?;
    }

    let derived_evm: String = Contract(mpc.clone())
        .call_function(
            "derived_public_key",
            json!({ "path": "evm", "domain_id": 0 }),
        )
        .read_only()
        .fetch_from(&n.net)
        .await?
        .data;
    let info = json!({
        "rpc": n.sandbox.rpc_addr,
        "genesis_secret_key": secret,
        "agent_secret_key": agent_key.to_string(),
        "shop_agent_secret_key": shop_agent.to_string(),
        "board_agent_secret_key": board_agent.to_string(),
        "accounts": {
            "owner": owner, "purse": purse, "factory": factory, "mpc": mpc,
            "intents": intents, "usdc": usdc_token, "wrap": wrap, "shop": shop,
            "solver": solver, "attacker": attacker,
            "checks": shop_account, "dao": dao, "bounties": board, "council": council,
            "steward": steward, "buyer": buyer, "newcomer": newcomer
        },
        "evm": {
            "chain_id": BASE_SEPOLIA,
            "usdc": BASE_USDC,
            "merchant": MERCHANT,
            "derived_public_key": derived_evm
        },
        "code_hash": code_hash
    });
    let tmp = out.join("devnet.json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&info)?)?;
    std::fs::rename(&tmp, &ready)?;
    eprintln!(
        "devnet ready: {} ({purse}). Ctrl-C to stop.",
        n.sandbox.rpc_addr
    );

    tokio::signal::ctrl_c().await?;
    let _ = std::fs::remove_file(&ready);
    Ok(())
}

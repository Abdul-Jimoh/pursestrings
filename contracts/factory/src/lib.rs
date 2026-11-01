use near_sdk::json_types::Base58CryptoHash;
use near_sdk::{
    AccountId, CryptoHash, Gas, NearToken, PanicOnDefault, Promise, assert_one_yocto, env,
    is_promise_success, near, require,
};

const INIT_GAS: Gas = Gas::from_tgas(50);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub code_hash: Base58CryptoHash,
    pub version: String,
    pub published_at: u64,
}

#[near(event_json(standard = "pursestrings-factory"))]
pub enum Event {
    #[event_version("1.0.0")]
    Published { release: Release },
    #[event_version("1.0.0")]
    Created {
        account_id: AccountId,
        code_hash: Base58CryptoHash,
    },
    #[event_version("1.0.0")]
    CreateFailed {
        account_id: AccountId,
        refunded_to: AccountId,
    },
}

/// The factory account is meant to have no access keys once deployed, so this code can't be
/// replaced. The admin can only append code hashes; it can never change an existing account.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    admin: AccountId,
    /// Append-only.
    releases: Vec<Release>,
}

#[near]
impl Factory {
    #[init]
    pub fn new(admin: AccountId) -> Self {
        Self {
            admin,
            releases: Vec::new(),
        }
    }

    #[payable]
    pub fn publish(&mut self, code_hash: Base58CryptoHash, version: String) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.admin, "admin only");
        require!(version.len() <= 32, "version too long");
        require!(!self.published(&code_hash.into()), "already published");
        let release = Release {
            code_hash,
            version,
            published_at: env::block_timestamp() / 1_000_000_000,
        };
        self.releases.push(release.clone());
        Event::Published { release }.emit();
    }

    #[payable]
    pub fn set_admin(&mut self, admin: AccountId) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.admin, "admin only");
        self.admin = admin;
    }

    /// Creates `<name>.<factory>`, funds it with the attached deposit, deploys `code` and calls
    /// `new(new_args)` in one batch, so nobody else can initialise it. No access key is added.
    /// Takes borsh arguments `(String, Vec<u8>, Vec<u8>)`; `new_args` is the JSON for `new`.
    #[payable]
    pub fn create(
        &mut self,
        #[serializer(borsh)] name: String,
        #[serializer(borsh)] code: Vec<u8>,
        #[serializer(borsh)] new_args: Vec<u8>,
    ) -> Promise {
        require!(
            !name.is_empty() && !name.contains('.'),
            "name must be a single label"
        );
        let account_id: AccountId = format!("{name}.{}", env::current_account_id())
            .parse()
            .expect("invalid account name");
        let code_hash = env::sha256_array(&code);
        require!(self.published(&code_hash), "code hash not published");
        let deposit = env::attached_deposit();
        require!(!deposit.is_zero(), "attach the new account's balance");

        Promise::new(account_id.clone())
            .create_account()
            .transfer(deposit)
            .deploy_contract(code)
            .function_call("new", new_args, NearToken::from_yoctonear(0), INIT_GAS)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_create(
                        account_id,
                        env::predecessor_account_id(),
                        deposit,
                        code_hash.into(),
                    ),
            )
    }

    #[private]
    pub fn on_create(
        &mut self,
        account_id: AccountId,
        creator: AccountId,
        deposit: NearToken,
        code_hash: Base58CryptoHash,
    ) -> bool {
        if is_promise_success() {
            Event::Created {
                account_id,
                code_hash,
            }
            .emit();
            return true;
        }
        Event::CreateFailed {
            account_id,
            refunded_to: creator.clone(),
        }
        .emit();
        Promise::new(creator).transfer(deposit).detach();
        false
    }

    /// Lets a Pursestrings account confirm a migration target in a cross-contract call.
    pub fn assert_published(&self, code_hash: Base58CryptoHash) {
        require!(self.published(&code_hash.into()), "code hash not published");
    }

    pub fn is_published(&self, code_hash: Base58CryptoHash) -> bool {
        self.published(&code_hash.into())
    }

    pub fn releases(&self) -> Vec<Release> {
        self.releases.clone()
    }

    pub fn admin(&self) -> AccountId {
        self.admin.clone()
    }
}

impl Factory {
    fn published(&self, hash: &CryptoHash) -> bool {
        self.releases
            .iter()
            .any(|r| CryptoHash::from(r.code_hash) == *hash)
    }
}

use near_sdk::json_types::U128;
use near_sdk::{AccountId, PublicKey, near, require};

pub const MAX_PURPOSE_BYTES: usize = 256;
pub const MAX_IDEMPOTENCY_KEY_BYTES: usize = 64;
pub const MAX_TOKEN_ID_BYTES: usize = 128;

#[near(serializers = [borsh, json])]
#[serde(try_from = "String", into = "String")]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EvmAddress(pub [u8; 20]);

pub fn hex_decode(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

impl TryFrom<String> for EvmAddress {
    type Error = &'static str;

    fn try_from(s: String) -> Result<Self, Self::Error> {
        let hex = s
            .strip_prefix("0x")
            .ok_or("evm address must start with 0x")?;
        let bytes = hex_decode(hex).ok_or("bad hex")?;
        Ok(Self(
            bytes
                .try_into()
                .map_err(|_| "evm address must be 20 bytes")?,
        ))
    }
}

impl From<EvmAddress> for String {
    fn from(a: EvmAddress) -> Self {
        let mut s = String::with_capacity(42);
        s.push_str("0x");
        s.push_str(&hex_encode(&a.0));
        s
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Asset {
    Near,
    Nep141 {
        token: AccountId,
    },
    /// `token: None` is the chain's native gas token.
    Evm {
        chain_id: u64,
        token: Option<EvmAddress>,
    },
    /// An `intents.near` token id such as `nep141:wrap.near`.
    Intents {
        token: String,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IntentDest {
    Transfer {
        receiver: AccountId,
    },
    Swap {
        buy: String,
        min_out: U128,
    },
    /// `ft_withdraw` of a NEP-141 token. Bridged tokens read the real destination from the memo
    /// (`WITHDRAW_TO:<address>`), so the allowlist entry covers the memo too.
    Withdraw {
        receiver: AccountId,
        memo: Option<String>,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum IntentKind {
    Transfer,
    Swap,
    Withdraw,
}

impl IntentDest {
    pub const fn kind(&self) -> IntentKind {
        match self {
            Self::Transfer { .. } => IntentKind::Transfer,
            Self::Swap { .. } => IntentKind::Swap,
            Self::Withdraw { .. } => IntentKind::Withdraw,
        }
    }
}

#[near(serializers = [borsh, json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Dest {
    Near { account: AccountId },
    Evm { chain_id: u64, to: EvmAddress },
    Intent(IntentDest),
}

/// Everything the agent can say about a spend. There is deliberately no field for a hash,
/// raw transaction, calldata, nonce or gas price: the contract builds those itself, and an
/// unknown field is an error rather than silently ignored.
#[near(serializers = [borsh, json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpendRequest {
    pub asset: Asset,
    pub amount: U128,
    pub dest: Dest,
    pub purpose: String,
    pub idempotency_key: String,
}

impl SpendRequest {
    pub fn assert_well_formed(&self) {
        require!(self.amount.0 > 0, "amount must be positive");
        require!(self.purpose.len() <= MAX_PURPOSE_BYTES, "purpose too long");
        require!(
            !self.idempotency_key.is_empty()
                && self.idempotency_key.len() <= MAX_IDEMPOTENCY_KEY_BYTES,
            "idempotency_key must be 1..=64 bytes"
        );
        if let Asset::Intents { token } = &self.asset {
            require!(valid_token_id(token), "bad intents token id");
            if let Dest::Intent(IntentDest::Swap { buy, .. }) = &self.dest {
                require!(valid_token_id(buy), "bad intents token id");
                require!(buy != token, "a swap needs two different tokens");
            }
        }
        if let Dest::Intent(IntentDest::Withdraw { memo, .. }) = &self.dest {
            require!(
                memo.as_ref().is_none_or(|m| m.len() <= MAX_PURPOSE_BYTES),
                "memo too long"
            );
        }
    }
}

/// An `intents.near` fungible token id. The charset keeps ids inert inside the signed payload.
pub fn valid_token_id(t: &str) -> bool {
    t.len() <= MAX_TOKEN_ID_BYTES
        && (t.starts_with("nep141:") || t.starts_with("nep245:"))
        && t.len() > "nep141:".len()
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':'))
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Recipient {
    Near {
        account: AccountId,
    },
    Evm {
        chain_id: u64,
        address: EvmAddress,
    },
    Intents {
        account: AccountId,
    },
    Withdraw {
        receiver: AccountId,
        memo: Option<String>,
    },
}

impl Dest {
    /// `None` for swaps, which pay the account itself.
    pub fn recipient(&self) -> Option<Recipient> {
        match self {
            Self::Near { account } => Some(Recipient::Near {
                account: account.clone(),
            }),
            Self::Evm { chain_id, to } => Some(Recipient::Evm {
                chain_id: *chain_id,
                address: *to,
            }),
            Self::Intent(IntentDest::Transfer { receiver }) => Some(Recipient::Intents {
                account: receiver.clone(),
            }),
            Self::Intent(IntentDest::Withdraw { receiver, memo }) => Some(Recipient::Withdraw {
                receiver: receiver.clone(),
                memo: memo.clone(),
            }),
            Self::Intent(IntentDest::Swap { .. }) => None,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DenyReason {
    Frozen,
    DuplicateIdempotencyKey {
        req_id: u64,
    },
    AssetNotAllowed,
    AssetDestMismatch,
    ChainNotAllowed,
    IntentKindNotAllowed,
    RecipientNotAllowed,
    PairNotAllowed,
    RateBelowFloor,
    OverPerTxCap {
        cap: U128,
    },
    Cooldown {
        retry_at: u64,
    },
    Velocity {
        retry_after_s: u32,
    },
    OverWindow {
        period_s: u32,
        remaining: U128,
    },
    FeeBudgetExhausted,
    /// The owner hasn't set gas caps for this chain.
    GasCapsMissing,
    /// EVM gas is paid in the chain's native token, which needs its own asset rule.
    NoGasBudget,
    /// A swap needs the account's MPC key registered on `intents.near` first.
    IntentsKeyMissing,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Approved { req_id: u64 },
    NeedsCosign { req_id: u64, expires_at: u64 },
    NeedsRisk { req_id: u64, expires_at: u64 },
    Denied { reason: DenyReason },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestStatus {
    PendingCosign,
    PendingRisk,
    Executing,
    /// EVM or swap: signed; the budget stays reserved until the outcome is proven.
    Signed,
    /// EVM or swap: the MPC call failed from our side, but a signature may still exist, so the
    /// budget stays held until the nonce is shown to be dead.
    SigningFailed,
    Done,
    /// EVM only: a cancel at the same nonce was confirmed, so the budget was released.
    Replaced,
    Failed,
    Cancelled,
    Rejected,
    Expired,
}

impl RequestStatus {
    pub const fn is_pending(self) -> bool {
        matches!(self, Self::PendingCosign | Self::PendingRisk)
    }

    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Done
                | Self::Failed
                | Self::Cancelled
                | Self::Rejected
                | Self::Expired
                | Self::Replaced
        )
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum UsageKey {
    Spend { asset: Asset, period_s: u32 },
    Velocity { period_s: u32 },
    Fee { period_s: u32 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reservation {
    pub key: UsageKey,
    pub bucket: u64,
    pub amount: U128,
}

/// The exact fields the contract signed, so the transaction can be rebuilt byte for byte.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmTx {
    pub nonce: u64,
    pub gas_limit: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub raw_tx: Option<String>,
    pub cancel_tx: Option<String>,
}

/// A `token_diff` swap the contract built and sent for signing.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentTx {
    /// Base64, as `intents.near` takes it.
    pub nonce: String,
    pub deadline_ns: u64,
    /// The deadline inside the versioned nonce, after which `intents.near` may forget it.
    pub nonce_deadline_ns: u64,
    pub payload: String,
    pub signature: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub agent: PublicKey,
    pub spend: SpendRequest,
    pub status: RequestStatus,
    pub created_at: u64,
    pub expires_at: Option<u64>,
    pub reservations: Vec<Reservation>,
    pub evm: Option<EvmTx>,
    pub intent: Option<IntentTx>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evm_address_round_trip() {
        let s = "0x9d7ac751235b819991b3050d3f19e58a8e66ae03".to_string();
        let a = EvmAddress::try_from(s.clone()).unwrap();
        assert_eq!(String::from(a), s);
        let upper = EvmAddress::try_from("0x9D7AC751235B819991b3050d3f19e58a8E66Ae03".to_string());
        assert_eq!(upper.unwrap(), a);
    }

    #[test]
    fn token_ids_are_inert_in_json() {
        for ok in [
            "nep141:wrap.near",
            "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
            "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
        ] {
            assert!(valid_token_id(ok), "{ok}");
        }
        for bad in [
            "",
            "nep141:",
            "wrap.near",
            "nep171:nft.near:1",
            r#"nep141:a","nep141:b":"-1"#,
            "nep141:a\\u0022",
            "nep141:a b",
        ] {
            assert!(!valid_token_id(bad), "{bad}");
        }
        assert!(!valid_token_id(&format!("nep141:{}", "a".repeat(122))));
    }

    #[test]
    fn evm_address_rejects_malformed() {
        for bad in [
            "9d7ac751235b819991b3050d3f19e58a8e66ae03",
            "0x1234",
            "0xzz7ac751235b819991b3050d3f19e58a8e66ae03",
        ] {
            assert!(EvmAddress::try_from(bad.to_string()).is_err(), "{bad}");
        }
    }
}

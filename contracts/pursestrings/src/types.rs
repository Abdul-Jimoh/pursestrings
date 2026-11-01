use near_sdk::json_types::U128;
use near_sdk::{AccountId, PublicKey, near, require};

pub const MAX_PURPOSE_BYTES: usize = 256;
pub const MAX_IDEMPOTENCY_KEY_BYTES: usize = 64;
pub const MAX_TOKEN_ID_BYTES: usize = 128;

#[near(serializers = [borsh, json])]
#[serde(try_from = "String", into = "String")]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EvmAddress(pub [u8; 20]);

impl TryFrom<String> for EvmAddress {
    type Error = &'static str;

    fn try_from(s: String) -> Result<Self, Self::Error> {
        let hex = s
            .strip_prefix("0x")
            .ok_or("evm address must start with 0x")?;
        if hex.len() != 40 {
            return Err("evm address must be 20 bytes");
        }
        let mut out = [0u8; 20];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).map_err(|_| "bad hex")?;
        }
        Ok(Self(out))
    }
}

impl From<EvmAddress> for String {
    fn from(a: EvmAddress) -> Self {
        let mut s = String::with_capacity(42);
        s.push_str("0x");
        for b in a.0 {
            s.push_str(&format!("{b:02x}"));
        }
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
    Withdraw {
        receiver: String,
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
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Dest {
    Near { account: AccountId },
    Evm { chain_id: u64, to: EvmAddress },
    Intent(IntentDest),
}

/// Everything the agent can say about a spend. There is deliberately no field for a hash,
/// raw transaction, calldata, nonce or gas price: the contract builds those itself.
#[near(serializers = [borsh, json])]
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
        let token_ok = |t: &str| !t.is_empty() && t.len() <= MAX_TOKEN_ID_BYTES;
        if let Asset::Intents { token } = &self.asset {
            require!(token_ok(token), "bad intents token id");
        }
        if let Dest::Intent(d) = &self.dest {
            match d {
                IntentDest::Swap { buy, .. } => require!(token_ok(buy), "bad intents token id"),
                IntentDest::Withdraw { receiver, memo } => {
                    require!(token_ok(receiver), "bad withdraw receiver");
                    require!(
                        memo.as_ref().is_none_or(|m| m.len() <= MAX_PURPOSE_BYTES),
                        "memo too long"
                    );
                }
                IntentDest::Transfer { .. } => {}
            }
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Recipient {
    Near { account: AccountId },
    Evm { chain_id: u64, address: EvmAddress },
    Intents { account: AccountId },
    Withdraw { receiver: String },
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
            Self::Intent(IntentDest::Withdraw { receiver, .. }) => Some(Recipient::Withdraw {
                receiver: receiver.clone(),
            }),
            Self::Intent(IntentDest::Swap { .. }) => None,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DenyReason {
    Frozen,
    DuplicateIdempotencyKey { req_id: u64 },
    AssetNotAllowed,
    AssetDestMismatch,
    ChainNotAllowed,
    IntentKindNotAllowed,
    RecipientNotAllowed,
    PairNotAllowed,
    RateBelowFloor,
    OverPerTxCap { cap: U128 },
    Cooldown { retry_at: u64 },
    Velocity { retry_after_s: u32 },
    OverWindow { period_s: u32, remaining: U128 },
    FeeBudgetExhausted,
    PathUnavailable,
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
    Done,
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
            Self::Done | Self::Failed | Self::Cancelled | Self::Rejected | Self::Expired
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

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub agent: PublicKey,
    pub spend: SpendRequest,
    pub status: RequestStatus,
    pub created_at: u64,
    pub expires_at: Option<u64>,
    pub reservations: Vec<Reservation>,
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

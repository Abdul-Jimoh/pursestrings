use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{
    Gas, NearToken, Promise, PromiseError, assert_one_yocto, env, is_promise_success, near, require,
};
use omni_transaction::evm::EVMTransaction;
use omni_transaction::evm::types::Signature;

use crate::events::Event;
use crate::policy::GasCaps;
use crate::types::{
    Asset, Dest, EvmAddress, EvmTx, RequestStatus, SpendRequest, hex_decode, hex_encode,
};
use crate::{Pursestrings, PursestringsExt};

/// One derivation path per account, so the account has the same address on every EVM chain.
pub const EVM_PATH: &str = "evm";
const SECP256K1_DOMAIN: u64 = 0;
const MPC_SIGN_GAS: Gas = Gas::from_tgas(50);
const EVM_CALLBACK_GAS: Gas = Gas::from_tgas(20);
const ERC20_TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
const CANCEL_GAS_LIMIT: u64 = 21_000;
/// The MPC domain for foreign-transaction verification (`state` on v1.signer and
/// v1.signer-prod.testnet, Nov 2026).
const FOREIGN_TX_DOMAIN: u64 = 3;
const VERIFY_GAS: Gas = Gas::from_tgas(50);
const VERIFY_CALLBACK_GAS: Gas = Gas::from_tgas(15);

/// The MPC network's name for an EVM chain. Mainnet MPC checks mainnets and testnet MPC checks
/// testnets under the same names; a transaction hash commits to its chain id, so mapping both
/// ids to one name can't confuse the two.
const fn mpc_chain(chain_id: u64) -> Option<&'static str> {
    match chain_id {
        1 | 11_155_111 => Some("Ethereum"),
        8453 | 84_532 => Some("Base"),
        42_161 | 421_614 => Some("Arbitrum"),
        137 | 80_002 => Some("Polygon"),
        56 | 97 => Some("Bnb"),
        43_114 | 43_113 => Some("Avalanche"),
        _ => None,
    }
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct SignArgs<'a> {
    request: SignRequest<'a>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct SignRequest<'a> {
    path: &'a str,
    payload_v2: Payload,
    domain_id: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
enum Payload {
    Ecdsa(String),
}

#[near(serializers = [json])]
pub struct EcdsaSignature {
    big_r: AffinePoint,
    s: Scalar,
    recovery_id: u8,
}

#[near(serializers = [json])]
struct AffinePoint {
    affine_point: String,
}

#[near(serializers = [json])]
struct Scalar {
    scalar: String,
}

pub fn erc20_transfer(to: &EvmAddress, amount: u128) -> Vec<u8> {
    let mut data = Vec::with_capacity(68);
    data.extend_from_slice(&ERC20_TRANSFER);
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(&to.0);
    data.extend_from_slice(&[0u8; 16]);
    data.extend_from_slice(&amount.to_be_bytes());
    data
}

/// Worst-case fee in the chain's native token, which is what the gas budget reserves.
pub fn max_gas_cost(caps: &GasCaps) -> Option<u128> {
    u128::from(caps.max_gas_limit).checked_mul(caps.max_fee_per_gas.0)
}

/// The only transactions this contract ever signs: an ERC-20 `transfer` or a native transfer
/// built from a policy-checked request, or a 0-value cancel at the same nonce.
fn build(spend: &SpendRequest, tx: &EvmTx, cancel: bool) -> EVMTransaction {
    let (Asset::Evm { chain_id, token }, Dest::Evm { to, .. }) = (&spend.asset, &spend.dest) else {
        env::panic_str("not an evm spend")
    };
    let (target, value, input) = match (cancel, token) {
        (true, _) => (to.0, 0, Vec::new()),
        (false, Some(token)) => (token.0, 0, erc20_transfer(to, spend.amount.0)),
        (false, None) => (to.0, spend.amount.0, Vec::new()),
    };
    EVMTransaction {
        chain_id: *chain_id,
        nonce: tx.nonce,
        to: Some(target),
        value,
        input,
        gas_limit: u128::from(tx.gas_limit),
        max_fee_per_gas: tx.max_fee_per_gas.0,
        max_priority_fee_per_gas: tx.max_priority_fee_per_gas.0,
        access_list: Vec::new(),
    }
}

/// Same nonce, 21k gas and fees 12.5% above the original (replacement needs at least 10%).
fn cancel_of(tx: &EvmTx) -> EvmTx {
    let bump = |v: U128| U128(v.0 + v.0 / 8);
    EvmTx {
        gas_limit: CANCEL_GAS_LIMIT,
        max_fee_per_gas: bump(tx.max_fee_per_gas),
        max_priority_fee_per_gas: bump(tx.max_priority_fee_per_gas),
        ..tx.clone()
    }
}

/// RLP integers must not have leading zero bytes, or nodes reject the transaction.
fn minimal(bytes: &[u8]) -> Vec<u8> {
    let start = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    bytes[start..].to_vec()
}

fn signed_raw(unsigned: &EVMTransaction, sig: &EcdsaSignature) -> Option<String> {
    let big_r = hex_decode(&sig.big_r.affine_point)?;
    let s = hex_decode(&sig.s.scalar)?;
    if big_r.len() != 33 || s.len() != 32 || sig.recovery_id > 1 {
        return None;
    }
    let signature = Signature {
        v: u64::from(sig.recovery_id),
        r: minimal(&big_r[1..]),
        s: minimal(&s),
    };
    Some(format!(
        "0x{}",
        hex_encode(&unsigned.build_with_signature(&signature))
    ))
}

#[near]
impl Pursestrings {
    /// Signs a 0-value transaction at the same nonce with fees 12.5% above the original, so the
    /// original can be replaced. Only a confirmed cancel lets the owner release the budget.
    #[payable]
    pub fn cancel_evm(&mut self, req_id: u64) -> Promise {
        self.assert_owner();
        let req = self.requests.get(&req_id).expect("unknown request");
        require!(
            matches!(
                req.status,
                RequestStatus::Signed | RequestStatus::SigningFailed
            ),
            "not an open evm request"
        );
        let tx = req.evm.as_ref().expect("evm request");
        require!(tx.cancel_tx.is_none(), "already cancelled");
        let cancel = cancel_of(tx);
        let spend = req.spend.clone();
        self.sign_evm(req_id, &spend, &cancel, true)
    }

    /// The owner reports what happened on the EVM chain. `replaced` releases the reservation
    /// and needs a signed cancel; otherwise the spend counts as done and keeps its budget.
    #[payable]
    pub fn resolve_evm(&mut self, req_id: u64, replaced: bool) {
        self.assert_owner();
        let req = self.requests.get_mut(&req_id).expect("unknown request");
        require!(
            matches!(
                req.status,
                RequestStatus::Signed | RequestStatus::SigningFailed
            ),
            "not an open evm request"
        );
        if replaced {
            require!(
                req.evm.as_ref().is_some_and(|t| t.cancel_tx.is_some()),
                "sign a cancel first"
            );
        }
        self.finish_evm(req_id, replaced);
    }

    /// Anyone can ask the MPC network to confirm that the signed transaction is finalized and
    /// succeeded; the spend is then done without trusting the owner or the relayer. Attach 1
    /// yoctoNEAR for the MPC deposit. Calling before finality just times out.
    #[payable]
    pub fn confirm_evm(&mut self, req_id: u64) -> Promise {
        self.verify_evm(req_id, false)
    }

    /// Like `confirm_evm`, for the same-nonce cancel: once the cancel is finalized the original
    /// can never be included, so the reservation is released.
    #[payable]
    pub fn release_evm(&mut self, req_id: u64) -> Promise {
        self.verify_evm(req_id, true)
    }

    #[private]
    pub fn on_evm_verified(&mut self, req_id: u64, replaced: bool) -> bool {
        let open = self.requests.get(&req_id).is_some_and(|r| {
            matches!(
                r.status,
                RequestStatus::Signed | RequestStatus::SigningFailed
            )
        });
        if !is_promise_success() || !open {
            return false;
        }
        self.finish_evm(req_id, replaced);
        true
    }

    #[private]
    pub fn on_evm_signed(
        &mut self,
        req_id: u64,
        cancel: bool,
        #[callback_result] sig: Result<EcdsaSignature, PromiseError>,
    ) -> Option<String> {
        let req = self.requests.get_mut(&req_id).expect("unknown request");
        let stored = req.evm.as_ref().expect("evm request");
        let tx = if cancel {
            cancel_of(stored)
        } else {
            stored.clone()
        };
        let raw = sig
            .ok()
            .and_then(|sig| signed_raw(&build(&req.spend, &tx, cancel), &sig));
        let evm = req.evm.as_mut().expect("evm request");
        if cancel {
            evm.cancel_tx.clone_from(&raw);
        } else {
            evm.raw_tx.clone_from(&raw);
            req.status = if raw.is_some() {
                RequestStatus::Signed
            } else {
                RequestStatus::SigningFailed
            };
            Event::RequestStatus {
                req_id,
                status: req.status,
            }
            .emit();
        }
        if let (Some(raw_tx), Asset::Evm { chain_id, .. }) = (&raw, &req.spend.asset) {
            Event::SignedTx {
                req_id,
                chain_id: *chain_id,
                nonce: tx.nonce,
                raw_tx: raw_tx.clone(),
                cancel,
            }
            .emit();
        }
        raw
    }
}

impl Pursestrings {
    fn finish_evm(&mut self, req_id: u64, replaced: bool) {
        let req = self.requests.get_mut(&req_id).expect("unknown request");
        let status = if replaced {
            RequestStatus::Replaced
        } else {
            RequestStatus::Done
        };
        req.status = status;
        let reservations = if replaced {
            std::mem::take(&mut req.reservations)
        } else {
            Vec::new()
        };
        self.release(&reservations);
        self.evm_open.remove(&req_id);
        Event::RequestStatus { req_id, status }.emit();
    }

    fn verify_evm(&self, req_id: u64, replaced: bool) -> Promise {
        assert_one_yocto();
        let req = self.requests.get(&req_id).expect("unknown request");
        require!(
            matches!(
                req.status,
                RequestStatus::Signed | RequestStatus::SigningFailed
            ),
            "not an open evm request"
        );
        let tx = req.evm.as_ref().expect("evm request");
        let raw = if replaced { &tx.cancel_tx } else { &tx.raw_tx };
        let raw = raw.as_deref().expect("no signed transaction to verify");
        let Asset::Evm { chain_id, .. } = req.spend.asset else {
            env::panic_str("not an evm spend")
        };
        let chain = mpc_chain(chain_id).expect("the MPC network can't verify this chain");
        let bytes = hex_decode(raw.trim_start_matches("0x")).expect("stored tx is hex");
        let tx_id = hex_encode(&env::keccak256_array(&bytes));
        let args = format!(
            r#"{{"request":{{"request":{{"{chain}":{{"tx_id":"{tx_id}","extractors":["BlockHash"],"finality":"Finalized"}}}},"domain_id":{FOREIGN_TX_DOMAIN},"payload_version":1}}}}"#
        );
        Promise::new(self.mpc.clone())
            .function_call(
                "verify_foreign_transaction",
                args.into_bytes(),
                NearToken::from_yoctonear(1),
                VERIFY_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(VERIFY_CALLBACK_GAS)
                    .on_evm_verified(req_id, replaced),
            )
    }

    /// Assigns the next nonce for the chain (never reused, see `SigningFailed`) and asks the MPC
    /// signer for a signature over the transaction built from the stored request.
    pub(crate) fn start_evm(&mut self, req_id: u64, spend: &SpendRequest) -> Promise {
        let Asset::Evm { chain_id, .. } = spend.asset else {
            env::panic_str("not an evm spend")
        };
        let caps = *self.policy.gas_caps(chain_id).expect("checked in evaluate");
        let next = self.evm_nonces.get(&chain_id).copied().unwrap_or(0);
        self.evm_nonces.insert(chain_id, next + 1);
        let tx = EvmTx {
            nonce: next,
            gas_limit: caps.max_gas_limit,
            max_fee_per_gas: caps.max_fee_per_gas,
            max_priority_fee_per_gas: caps.max_priority_fee_per_gas,
            raw_tx: None,
            cancel_tx: None,
        };
        let req = self.requests.get_mut(&req_id).expect("unknown request");
        req.evm = Some(tx.clone());
        self.evm_open.insert(req_id);
        self.sign_evm(req_id, spend, &tx, false)
    }

    fn sign_evm(&self, req_id: u64, spend: &SpendRequest, tx: &EvmTx, cancel: bool) -> Promise {
        let hash = env::keccak256_array(build(spend, tx, cancel).build_for_signing());
        let args = SignArgs {
            request: SignRequest {
                path: EVM_PATH,
                payload_v2: Payload::Ecdsa(hex_encode(&hash)),
                domain_id: SECP256K1_DOMAIN,
            },
        };
        Promise::new(self.mpc.clone())
            .function_call(
                "sign",
                near_sdk::serde_json::to_vec(&args).expect("sign args"),
                NearToken::from_yoctonear(1),
                MPC_SIGN_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(EVM_CALLBACK_GAS)
                    .on_evm_signed(req_id, cancel),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erc20_calldata_layout() {
        let to = EvmAddress([0xab; 20]);
        let data = erc20_transfer(&to, 40_000_000);
        assert_eq!(data.len(), 68);
        assert_eq!(&data[..4], &ERC20_TRANSFER);
        assert_eq!(&data[16..36], &[0xab; 20]);
        assert_eq!(
            u128::from_be_bytes(data[52..68].try_into().unwrap()),
            40_000_000
        );
        assert!(data[4..16].iter().chain(&data[36..52]).all(|b| *b == 0));
    }

    #[test]
    fn minimal_strips_leading_zeros() {
        assert_eq!(minimal(&[0, 0, 1, 0]), vec![1, 0]);
        assert_eq!(minimal(&[0, 0]), Vec::<u8>::new());
    }
}

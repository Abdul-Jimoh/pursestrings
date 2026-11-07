use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{
    AccountId, Gas, NearToken, Promise, PromiseError, PublicKey, env, is_promise_success, near,
    require,
};

use crate::events::Event;
use crate::evm::{MPC_SIGN_GAS, Payload, SignArgs, SignRequest};
use crate::types::{
    Asset, Dest, IntentDest, IntentTx, RequestStatus, SpendRequest, hex_decode, valid_token_id,
};
use crate::{Pursestrings, PursestringsExt};

pub const INTENTS_PATH: &str = "intents";
const ED25519_DOMAIN: u64 = 1;
/// How long a signed swap can be executed. Solvers fill within seconds of a quote.
pub const SWAP_TTL_S: u64 = 300;
/// `intents.near` may garbage-collect a versioned nonce once the deadline inside it passes, after
/// which `is_nonce_used` forgets it. That deadline is set this long after the payload's own, so
/// there's a day in which an unused nonce proves the swap can never run.
pub const NONCE_GRACE_S: u64 = 86_400;
/// The largest payload the MPC EdDSA domain signs.
const MAX_PAYLOAD_BYTES: usize = 1232;
const VERSIONED_NONCE_MAGIC: [u8; 4] = [0x56, 0x28, 0xf6, 0xc6];
const NS: u64 = 1_000_000_000;

const VIEW_GAS: Gas = Gas::from_tgas(5);
const ADD_KEY_GAS: Gas = Gas::from_tgas(10);
/// `ft_withdraw` runs `ft_transfer` plus its own 15 Tgas resolver.
const FT_WITHDRAW_GAS: Gas = Gas::from_tgas(60);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const SIGNED_CALLBACK_GAS: Gas = Gas::from_tgas(20);
const SALT_CALLBACK_GAS: Gas = Gas::from_tgas(85);

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct FtWithdrawArgs<'a> {
    token: &'a str,
    receiver_id: &'a AccountId,
    amount: U128,
    memo: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct DerivedKeyArgs<'a> {
    path: &'a str,
    predecessor: AccountId,
    domain_id: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct PublicKeyArgs<'a> {
    public_key: &'a PublicKey,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct NonceArgs<'a> {
    account_id: AccountId,
    nonce: &'a str,
}

#[near(serializers = [json])]
pub struct EddsaSignature {
    signature: Vec<u8>,
}

/// UTC, to the second, in the form `intents.near` parses (`2026-11-01T12:00:00Z`).
pub fn iso8601(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// `VersionedNonce::V1`: magic, version 0, salt, the nonce's own deadline (i64 ns, LE), then 15
/// bytes that make it unique.
pub fn versioned_nonce(salt: [u8; 4], nonce_deadline_ns: u64, unique: &[u8; 32]) -> [u8; 32] {
    let mut n = [0u8; 32];
    n[..4].copy_from_slice(&VERSIONED_NONCE_MAGIC);
    n[5..9].copy_from_slice(&salt);
    n[9..17].copy_from_slice(&nonce_deadline_ns.to_le_bytes());
    n[17..].copy_from_slice(&unique[..15]);
    n
}

/// The only intent this contract ever signs: give exactly `amount` of the asset's token for
/// exactly `min_out` of `buy`, as checked against the owner's rate floor. The `raw_ed25519`
/// signature covers these JSON bytes. Every value spliced in is an account id, a validated token
/// id, digits or base64, none of which can contain a quote or backslash.
fn swap_payload(
    signer: AccountId,
    verifier: &AccountId,
    spend: &SpendRequest,
    deadline_s: u64,
    nonce: &str,
) -> Option<String> {
    let (Asset::Intents { token }, Dest::Intent(IntentDest::Swap { buy, min_out })) =
        (&spend.asset, &spend.dest)
    else {
        return None;
    };
    if !valid_token_id(token)
        || !valid_token_id(buy)
        || token == buy
        || !nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
    {
        return None;
    }
    let sell = i128::try_from(spend.amount.0).ok()?;
    let out = i128::try_from(min_out.0).ok()?;
    let deadline = iso8601(deadline_s);
    let payload = format!(
        r#"{{"signer_id":"{signer}","verifying_contract":"{verifier}","deadline":"{deadline}","nonce":"{nonce}","intents":[{{"intent":"token_diff","diff":{{"{token}":"-{sell}","{buy}":"{out}"}}}}]}}"#
    );
    (payload.len() <= MAX_PAYLOAD_BYTES).then_some(payload)
}

fn signature_string(sig: &EddsaSignature) -> Option<String> {
    (sig.signature.len() == 64).then(|| {
        format!(
            "ed25519:{}",
            near_sdk::bs58::encode(&sig.signature).into_string()
        )
    })
}

fn is_open(status: RequestStatus) -> bool {
    matches!(status, RequestStatus::Signed | RequestStatus::SigningFailed)
}

#[near]
impl Pursestrings {
    /// Registers this account's MPC-derived Ed25519 key on `intents.near`, which swaps need.
    /// The key comes from the MPC contract itself, so no caller can substitute one.
    #[payable]
    pub fn register_intents_key(&mut self) -> Promise {
        self.assert_owner();
        let args = DerivedKeyArgs {
            path: INTENTS_PATH,
            predecessor: env::current_account_id(),
            domain_id: ED25519_DOMAIN,
        };
        Promise::new(self.mpc.clone())
            .function_call(
                "derived_public_key",
                near_sdk::serde_json::to_vec(&args).expect("args"),
                NearToken::from_yoctonear(0),
                VIEW_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ADD_KEY_GAS.saturating_add(CALLBACK_GAS.saturating_mul(2)))
                    .on_derived_key(),
            )
    }

    #[private]
    pub fn on_derived_key(
        &mut self,
        #[callback_result] key: Result<PublicKey, PromiseError>,
    ) -> Promise {
        let key = key.expect("derived_public_key failed");
        Promise::new(self.intents.clone())
            .function_call(
                "add_public_key",
                near_sdk::serde_json::to_vec(&PublicKeyArgs { public_key: &key }).expect("args"),
                NearToken::from_yoctonear(1),
                ADD_KEY_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_intents_key_added(key),
            )
    }

    #[private]
    pub fn on_intents_key_added(&mut self, public_key: PublicKey) -> bool {
        let ok = is_promise_success();
        if ok {
            Event::IntentsKeyRegistered {
                public_key: public_key.clone(),
            }
            .emit();
            self.intents_key = Some(public_key);
        }
        ok
    }

    /// `ft_withdraw` returns how much left the account; 0 means the transfer bounced and
    /// `intents.near` refunded it.
    #[private]
    pub fn on_intents_withdrawn(
        &mut self,
        req_id: u64,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> bool {
        let ok = used.is_ok_and(|u| u.0 > 0);
        self.finish_execution(req_id, ok);
        ok
    }

    #[private]
    pub fn on_intents_salt(
        &mut self,
        req_id: u64,
        #[callback_result] salt: Result<String, PromiseError>,
    ) -> Option<Promise> {
        let salt: Option<[u8; 4]> = salt
            .ok()
            .and_then(|s| hex_decode(&s))
            .and_then(|b| b.try_into().ok());
        let now = env::block_timestamp() / NS;
        let deadline_s = now + SWAP_TTL_S;
        let nonce_deadline_ns = (deadline_s + NONCE_GRACE_S) * NS;
        let req = self.requests.get(&req_id).expect("unknown request");
        let built = salt.and_then(|salt| {
            let mut seed = env::random_seed_array().to_vec();
            seed.extend_from_slice(&req_id.to_le_bytes());
            let nonce = versioned_nonce(salt, nonce_deadline_ns, &env::sha256_array(&seed));
            let nonce = base64(&nonce);
            let payload = swap_payload(
                env::current_account_id(),
                &self.intents,
                &req.spend,
                deadline_s,
                &nonce,
            )?;
            Some(IntentTx {
                nonce,
                deadline_ns: deadline_s * NS,
                nonce_deadline_ns,
                payload,
                signature: None,
            })
        });
        // Nothing was signed, so the reservation can go back.
        let Some(tx) = built else {
            self.finish_execution(req_id, false);
            return None;
        };
        let args = SignArgs {
            request: SignRequest {
                path: INTENTS_PATH,
                payload_v2: Payload::Eddsa(crate::types::hex_encode(tx.payload.as_bytes())),
                domain_id: ED25519_DOMAIN,
            },
        };
        self.requests
            .get_mut(&req_id)
            .expect("unknown request")
            .intent = Some(tx);
        self.intents_open.insert(req_id);
        Some(
            Promise::new(self.mpc.clone())
                .function_call(
                    "sign",
                    near_sdk::serde_json::to_vec(&args).expect("sign args"),
                    NearToken::from_yoctonear(1),
                    MPC_SIGN_GAS,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(SIGNED_CALLBACK_GAS)
                        .on_intent_signed(req_id),
                ),
        )
    }

    /// Keeps the signature only if it verifies against the registered key, so the relayer is
    /// never handed something `intents.near` would reject.
    #[private]
    pub fn on_intent_signed(
        &mut self,
        req_id: u64,
        #[callback_result] sig: Result<EddsaSignature, PromiseError>,
    ) -> Option<String> {
        let key = self.intents_key.clone().expect("checked in evaluate");
        let req = self.requests.get_mut(&req_id).expect("unknown request");
        let tx = req.intent.as_mut().expect("swap request");
        let signature = sig.ok().filter(|s| {
            s.signature.len() == 64
                && env::ed25519_verify(
                    s.signature.as_slice().try_into().expect("64 bytes"),
                    tx.payload.as_bytes(),
                    key.as_bytes()[1..].try_into().expect("ed25519 key"),
                )
        });
        tx.signature = signature.as_ref().and_then(signature_string);
        req.status = if tx.signature.is_some() {
            RequestStatus::Signed
        } else {
            RequestStatus::SigningFailed
        };
        Event::RequestStatus {
            req_id,
            status: req.status,
        }
        .emit();
        if let Some(signature) = &tx.signature {
            Event::SignedIntent {
                req_id,
                payload: tx.payload.clone(),
                public_key: key,
                signature: signature.clone(),
            }
            .emit();
        }
        tx.signature.clone()
    }

    /// Anyone can settle a swap once its deadline has passed. A used nonce means it ran; an
    /// unused one, checked while `intents.near` must still remember it, means it never can, so
    /// the reservation is released.
    pub fn settle_intent(&mut self, req_id: u64) -> Promise {
        let req = self.requests.get(&req_id).expect("unknown request");
        require!(is_open(req.status), "not an open swap");
        let tx = req.intent.as_ref().expect("swap request");
        require!(
            env::block_timestamp() > tx.deadline_ns,
            "the swap can still execute"
        );
        let args = NonceArgs {
            account_id: env::current_account_id(),
            nonce: &tx.nonce,
        };
        Promise::new(self.intents.clone())
            .function_call(
                "is_nonce_used",
                near_sdk::serde_json::to_vec(&args).expect("args"),
                NearToken::from_yoctonear(0),
                VIEW_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_intent_settled(req_id),
            )
    }

    /// The view ran before this callback, so a callback still inside the nonce's lifetime
    /// means the answer came from a time when `intents.near` couldn't have forgotten it.
    #[private]
    pub fn on_intent_settled(
        &mut self,
        req_id: u64,
        #[callback_result] used: Result<bool, PromiseError>,
    ) -> Option<RequestStatus> {
        let req = self.requests.get(&req_id).expect("unknown request");
        if !is_open(req.status) {
            return None;
        }
        let tx = req.intent.as_ref().expect("swap request");
        let status = match used {
            Ok(true) => RequestStatus::Done,
            Ok(false) if env::block_timestamp() < tx.nonce_deadline_ns => RequestStatus::Expired,
            _ => return None,
        };
        self.finish_intent(req_id, status);
        Some(status)
    }

    /// The owner's fallback once `intents.near` may have forgotten the nonce.
    #[payable]
    pub fn resolve_intent(&mut self, req_id: u64, executed: bool) {
        self.assert_owner();
        let req = self.requests.get(&req_id).expect("unknown request");
        require!(is_open(req.status), "not an open swap");
        let tx = req.intent.as_ref().expect("swap request");
        require!(
            env::block_timestamp() >= tx.nonce_deadline_ns,
            "settle_intent can still prove it"
        );
        let status = if executed {
            RequestStatus::Done
        } else {
            RequestStatus::Expired
        };
        self.finish_intent(req_id, status);
    }
}

impl Pursestrings {
    pub(crate) fn start_intent(&mut self, req_id: u64, spend: &SpendRequest) -> Promise {
        let (Asset::Intents { token }, Dest::Intent(dest)) = (&spend.asset, &spend.dest) else {
            env::panic_str("not an intents spend")
        };
        let callback = Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS);
        match dest {
            IntentDest::Transfer { .. } => env::panic_str("a plain transfer"),
            IntentDest::Withdraw { receiver, memo } => {
                let args = FtWithdrawArgs {
                    token: token.strip_prefix("nep141:").expect("checked in evaluate"),
                    receiver_id: receiver,
                    amount: spend.amount,
                    memo: memo.as_deref(),
                };
                Promise::new(self.intents.clone())
                    .function_call(
                        "ft_withdraw",
                        near_sdk::serde_json::to_vec(&args).expect("args"),
                        NearToken::from_yoctonear(1),
                        FT_WITHDRAW_GAS,
                    )
                    .then(callback.on_intents_withdrawn(req_id))
            }
            IntentDest::Swap { .. } => Promise::new(self.intents.clone())
                .function_call(
                    "current_salt",
                    b"{}".to_vec(),
                    NearToken::from_yoctonear(0),
                    VIEW_GAS,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(SALT_CALLBACK_GAS)
                        .on_intents_salt(req_id),
                ),
        }
    }

    fn finish_intent(&mut self, req_id: u64, status: RequestStatus) {
        let req = self.requests.get_mut(&req_id).expect("unknown request");
        req.status = status;
        let reservations = if status == RequestStatus::Done {
            Vec::new()
        } else {
            std::mem::take(&mut req.reservations)
        };
        self.release(&reservations);
        self.intents_open.remove(&req_id);
        Event::RequestStatus { req_id, status }.emit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::IntentDest;

    #[test]
    fn iso8601_matches_known_dates() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_793_361_600), "2026-10-30T12:00:00Z");
        assert_eq!(iso8601(1_835_481_599), "2028-02-29T23:59:59Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn base64_matches_rfc4648() {
        for (input, out) in [
            (&b""[..], ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"fooba", "Zm9vYmE="),
            (b"foobar", "Zm9vYmFy"),
            (&[0xfb, 0xff], "+/8="),
        ] {
            assert_eq!(base64(input), out);
        }
    }

    #[test]
    fn versioned_nonce_layout() {
        let n = versioned_nonce([1, 2, 3, 4], 0x0102_0304_0506_0708, &[9; 32]);
        assert_eq!(&n[..4], &VERSIONED_NONCE_MAGIC);
        assert_eq!(n[4], 0);
        assert_eq!(&n[5..9], &[1, 2, 3, 4]);
        assert_eq!(&n[9..17], &[8, 7, 6, 5, 4, 3, 2, 1]);
        assert_eq!(&n[17..], &[9; 15]);
    }

    fn swap(sell: &str, buy: &str, amount: u128, min_out: u128) -> SpendRequest {
        SpendRequest {
            asset: Asset::Intents { token: sell.into() },
            amount: U128(amount),
            dest: Dest::Intent(IntentDest::Swap {
                buy: buy.into(),
                min_out: U128(min_out),
            }),
            purpose: String::new(),
            idempotency_key: "k".into(),
            bounty: None,
        }
    }

    #[test]
    fn swap_payload_is_exact() {
        let payload = swap_payload(
            "purse.near".parse().unwrap(),
            &"intents.near".parse().unwrap(),
            &swap("nep141:wrap.near", "nep141:usdc.near", 100, 190),
            1_793_361_600,
            "Vij2xg==",
        )
        .unwrap();
        assert_eq!(
            payload,
            r#"{"signer_id":"purse.near","verifying_contract":"intents.near","deadline":"2026-10-30T12:00:00Z","nonce":"Vij2xg==","intents":[{"intent":"token_diff","diff":{"nep141:wrap.near":"-100","nep141:usdc.near":"190"}}]}"#
        );
    }

    #[test]
    fn largest_swap_payload_fits_the_mpc_limit() {
        let token = |c: char| format!("nep141:{}", c.to_string().repeat(121));
        let account = "a".repeat(64).parse().unwrap();
        let payload = swap_payload(
            account,
            &"b".repeat(64).parse().unwrap(),
            &swap(
                &token('x'),
                &token('y'),
                i128::MAX as u128,
                i128::MAX as u128,
            ),
            u64::MAX / NS,
            &base64(&[0xff; 32]),
        )
        .unwrap();
        assert!(payload.len() <= MAX_PAYLOAD_BYTES, "{}", payload.len());
    }

    #[test]
    fn amounts_beyond_i128_are_not_signed() {
        let req = swap("nep141:a.near", "nep141:b.near", u128::MAX, 1);
        let p = swap_payload(
            "p.near".parse().unwrap(),
            &"i.near".parse().unwrap(),
            &req,
            0,
            "",
        );
        assert!(p.is_none());
    }
}

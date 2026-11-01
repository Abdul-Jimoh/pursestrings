use ed25519_dalek::{Signer, SigningKey};
use near_sdk::serde_json::{Value, json};
use near_sdk::{AccountId, NearToken, env, near, require};

/// Stands in for every derived Ed25519 key, so signatures verify like real MPC ones.
const EDDSA_SECRET: [u8; 32] = [7; 32];
/// Stands in for every derived secp256k1 key once `use_real_ecdsa` is on.
const ECDSA_SECRET: [u8; 32] = [9; 32];

/// `r` and `s` both start with zero bytes, so callers must encode them minimally.
const BIG_R: &str = "020033333333333333333333333333333333333333333333333333333333333333";
const S: &str = "0000444444444444444444444444444444444444444444444444444444444444";

#[near(serializers = [json])]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Seen {
    pub predecessor: AccountId,
    pub path: String,
    pub payload: String,
    pub domain_id: u64,
}

#[near(serializers = [json])]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
pub struct Scalar {
    pub scalar: String,
}

#[near(serializers = [json])]
pub struct EcdsaResponse {
    pub scheme: String,
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

#[near(contract_state)]
#[derive(Default)]
pub struct TestMpc {
    seen: Vec<Seen>,
    fail: bool,
    /// Transaction ids `verify_foreign_transaction` treats as finalized and successful.
    final_txs: Vec<String>,
    verify_requests: Vec<String>,
    /// Off by default: the fixed signature above exercises leading-zero handling.
    real_ecdsa: bool,
}

#[near]
impl TestMpc {
    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> Value {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "deposit required"
        );
        require!(!self.fail, "signing failed");
        let (payload, eddsa) = match request.payload_v2 {
            Payload::Ecdsa(p) => (p, false),
            Payload::Eddsa(p) => (p, true),
        };
        let response = if eddsa {
            let bytes = hex_decode(&payload);
            let sig = SigningKey::from_bytes(&EDDSA_SECRET).sign(&bytes);
            json!({ "scheme": "Ed25519", "signature": sig.to_bytes().to_vec() })
        } else if self.real_ecdsa {
            let hash: [u8; 32] = hex_decode(&payload).try_into().expect("32-byte hash");
            let key = k256::ecdsa::SigningKey::from_bytes(&ECDSA_SECRET.into()).unwrap();
            let (sig, recid) = key.sign_prehash_recoverable(&hash).expect("sign");
            let (r, s) = sig.split_bytes();
            near_sdk::serde_json::to_value(EcdsaResponse {
                scheme: "Secp256k1".into(),
                big_r: AffinePoint {
                    affine_point: format!("{:02x}{}", 2 + u8::from(recid.is_y_odd()), hex(&r)),
                },
                s: Scalar { scalar: hex(&s) },
                recovery_id: recid.to_byte(),
            })
            .unwrap()
        } else {
            near_sdk::serde_json::to_value(EcdsaResponse {
                scheme: "Secp256k1".into(),
                big_r: AffinePoint {
                    affine_point: BIG_R.into(),
                },
                s: Scalar { scalar: S.into() },
                recovery_id: 1,
            })
            .unwrap()
        };
        self.seen.push(Seen {
            predecessor: env::predecessor_account_id(),
            path: request.path,
            payload,
            domain_id: request.domain_id,
        });
        response
    }

    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String {
        let _ = (path, predecessor);
        match domain_id {
            Some(1) => {
                let pk = SigningKey::from_bytes(&EDDSA_SECRET).verifying_key();
                format!(
                    "ed25519:{}",
                    near_sdk::bs58::encode(pk.as_bytes()).into_string()
                )
            }
            Some(0) | None => {
                let key = k256::ecdsa::SigningKey::from_bytes(&ECDSA_SECRET.into()).unwrap();
                let point = key.verifying_key().to_encoded_point(false);
                format!(
                    "secp256k1:{}",
                    near_sdk::bs58::encode(&point.as_bytes()[1..]).into_string()
                )
            }
            Some(d) => env::panic_str(&format!("domain {d} is not mocked")),
        }
    }

    pub fn use_real_ecdsa(&mut self) {
        self.real_ecdsa = true;
    }

    /// Succeeds only for ids marked final; anything else fails, as a real request times out.
    #[payable]
    pub fn verify_foreign_transaction(&mut self, request: Value) -> Value {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "deposit required"
        );
        self.verify_requests.push(request.to_string());
        let tx_id = request["request"]
            .as_object()
            .and_then(|chains| chains.values().next())
            .and_then(|r| r["tx_id"].as_str())
            .unwrap_or_default()
            .to_string();
        require!(self.final_txs.contains(&tx_id), "Request has timed out.");
        json!({ "payload_hash": "00".repeat(32), "signature": {} })
    }

    pub fn mark_final(&mut self, tx_id: String) {
        self.final_txs.push(tx_id);
    }

    pub fn verify_requests(&self) -> Vec<String> {
        self.verify_requests.clone()
    }

    pub fn set_fail(&mut self, fail: bool) {
        self.fail = fail;
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.clone()
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex payload"))
        .collect()
}

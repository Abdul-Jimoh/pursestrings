use near_sdk::{AccountId, NearToken, env, near, require};

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
}

#[near]
impl TestMpc {
    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> EcdsaResponse {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "deposit required"
        );
        require!(!self.fail, "signing failed");
        let payload = match request.payload_v2 {
            Payload::Ecdsa(p) | Payload::Eddsa(p) => p,
        };
        self.seen.push(Seen {
            predecessor: env::predecessor_account_id(),
            path: request.path,
            payload,
            domain_id: request.domain_id,
        });
        EcdsaResponse {
            scheme: "Secp256k1".into(),
            big_r: AffinePoint {
                affine_point: BIG_R.into(),
            },
            s: Scalar { scalar: S.into() },
            recovery_id: 1,
        }
    }

    pub fn set_fail(&mut self, fail: bool) {
        self.fail = fail;
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.clone()
    }
}

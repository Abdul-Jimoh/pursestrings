use near_sdk::{AccountId, PanicOnDefault, near};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pursestrings {
    owner: AccountId,
}

#[near]
impl Pursestrings {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { owner }
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::accounts;

    #[test]
    fn new_sets_owner() {
        let c = Pursestrings::new(accounts(1));
        assert_eq!(c.owner(), accounts(1));
    }
}

# Threat model

Pursestrings assumes the agent is compromised. A prompt injection, a poisoned tool result or a
stolen agent key should all lead to the same place: the agent asks, and a contract on NEAR
decides. This file lists what the contract promises, where each promise is enforced, and the
test that checks it. It also lists what the contract doesn't protect against.

Run the tests with `make test`. Sandbox tests start a local NEAR node at mainnet's protocol
version, deploy the real contracts and drive them through signed transactions.

## Who can do what

| Actor | Holds | Can | Can't |
|---|---|---|---|
| Agent | A function-call key on the Pursestrings account, limited to `request_spend`, `cancel_request`, `quote`, `deliver` and `refund`, with a capped gas allowance | Ask for a payment; cancel its own pending request; quote a price at or above the owner's floor; record a delivery; refund a buyer in full before delivery, or from the kept share after it, within the refund window | Attach a deposit, call any other method, sign anything, change the policy, quote under the floor, change where sales go |
| Owner | Their own NEAR account (a wallet) | Approve co-signs, tighten the policy instantly, propose loosening, freeze, revoke agents, withdraw to itself | Loosen anything before the timelock ends; change the code to a hash the factory didn't publish |
| Council member | Their own NEAR account | Approve bounty payouts their tier allows, post bounties, freeze | Approve payouts above the council tier, unfreeze, change the policy |
| Buyer or contributor | A NEAR account | Pay a quote (a wrong payment comes back in full); claim and submit a bounty | Get paid for a bounty they didn't claim, or more than its reward |
| Relayer | Nothing | Broadcast signed EVM transactions and intents the contract already approved | Change what was signed; mark a payment done (only an MPC proof can) |
| Anyone | A NEAR account | Call `confirm_evm`, `release_evm`, `settle_intent`, `expire_request`, `prune_requests`; deliver the code for a migration the owner proposed, once it's due | Make any of those succeed without the on-chain evidence each one checks; deploy code the owner didn't propose, before the timelock ends, or while frozen |

## Invariants

### 1. The agent's key can't move funds

`add_agent` creates a function-call key whose receiver is the account itself and whose methods are
only `request_spend`, `cancel_request`, `quote`, `deliver` and `refund`
([admin.rs:28](contracts/pursestrings/src/admin.rs#L28)). NEAR's protocol rejects any other use
of the key, including transfers. Owner methods call `assert_owner`, which needs exactly 1
yoctoNEAR attached, and a function-call key can't attach a deposit
([lib.rs:313](contracts/pursestrings/src/lib.rs#L313)). The one selling method that pays anything out, `refund`, can only
pay whoever paid that order, only within the owner's refund window, and only as all of the
payment before delivery or from the part of the price the account kept after it
([sales.rs](contracts/pursestrings/src/sales.rs)).

Test: [`inv1_agent_key_cannot_move_funds`](contracts/pursestrings/tests/invariants.rs#L37) checks
the key's receiver, methods and allowance on-chain. It then has the agent try a raw transfer,
five owner-only methods (with and without 1 yocto), a deposit on `request_spend`, and a
`request_spend` from an outside account. The protocol refuses every one, and the shop's balance
doesn't move. A spend to a recipient that isn't allowlisted is denied and logged as a NEP-297
event. [`inv1_owner_cannot_be_the_account_itself`](contracts/pursestrings/tests/invariants.rs#L136)
checks that an account can't be its own owner (agent calls arrive with the account itself as the
caller) and that nobody can run `new` a second time.

### 2. No blind signing

A `SpendRequest` has an asset, an amount, a destination, a purpose and an idempotency key, and
nothing else. Unknown fields are refused, not ignored
([types.rs:125](contracts/pursestrings/src/types.rs#L125)). The contract builds the EIP-1559
transaction or the intent payload itself from those fields and the owner's gas caps, then asks
the MPC network to sign it. There is no way to hand it a hash or a raw transaction.

Tests:
- [`inv2_contract_signs_only_what_it_built`](contracts/pursestrings/tests/evm.rs#L207) checks
  that the one signing request the MPC contract received is the hash of the transaction the
  contract built. That hash is compared with an independent RLP encoder in the test. The test
  then tries `raw_tx` and `payload_hash` fields, a direct call to the signing callback and a
  direct call to the MPC signer with the agent key, and all of them are refused.
- [`inv2_intents_swap_is_built_signed_and_settled_by_the_contract`](contracts/pursestrings/tests/intents.rs#L337)
  does the same for a swap intent. It runs against the mainnet `intents.near` v0.4.5 wasm.

### 3. Loosening is time-locked; tightening, revoking and freezing are instant

`propose` splits a batch with `classify`
([policy.rs:337](contracts/pursestrings/src/policy.rs#L337)): an op that isn't provably at least
as strict as the current policy goes into the queue with an `eta`; the rest apply at once
([admin.rs:88](contracts/pursestrings/src/admin.rs#L88)). Unfreezing and adding recipients count
as loosening.

Test: [`inv3_loosening_waits_tightening_is_instant`](contracts/pursestrings/tests/invariants.rs#L170)
queues a limit raise, fails to apply it early, and cancels it. It lowers a cap and sees it
enforced on the next spend. In a mixed batch, the removal applies now and the new recipient
waits, and payments to the new recipient are denied until the timelock passes.

### 4. Budgets are deterministic, per-asset rolling windows

Each window is a ring of time buckets ([ring.rs:9](contracts/pursestrings/src/ring.rs#L9)). An
approval reserves its amount, a failed execution releases it, and a signed EVM transaction keeps
its reservation until it's proven settled or replaced. There's no price oracle: amounts are in
each asset's own units, and a budget group joins assets the owner declares to be the same unit.

Tests:
- [`inv4_per_asset_windows_reserve_and_release`](contracts/pursestrings/tests/invariants.rs#L266)
- [`inv4_cosign_reserves_until_resolved`](contracts/pursestrings/tests/invariants.rs#L318)
- [`inv4_window_rolls_over`](contracts/pursestrings/tests/invariants.rs#L372)
- [`inv4_velocity_stops_a_drip`](contracts/pursestrings/tests/invariants.rs#L396)
- [`evm_budget_is_held_until_a_cancel_is_confirmed`](contracts/pursestrings/tests/evm.rs#L327)
- [`one_group_budget_spans_near_and_intents`](contracts/pursestrings/tests/intents.rs#L509)

### 5. The screener can only add restrictions

Not built. There's no risk screener in this version. A rule's `risk_check_above` threshold routes
the request to the owner's co-sign instead
([spend.rs:438](contracts/pursestrings/src/spend.rs#L438)), so nothing is approved on a
screener's say-so.

### 6. Kill switch

`freeze` ([admin.rs:79](contracts/pursestrings/src/admin.rs#L79)) makes every request fail with
`Frozen` and blocks approving pending ones. `revoke_agent`
([admin.rs:53](contracts/pursestrings/src/admin.rs#L53)) deletes the key in the same
transaction. Each is one owner transaction.

Test: [`inv6_freeze_and_revoke_in_one_transaction`](contracts/pursestrings/tests/invariants.rs#L428)
freezes the account, sees requests and approvals refused, sees that unfreezing is queued rather
than applied, and checks that a revoked key is gone from the account and can't call
`request_spend`.

### 7. Nobody can swap the code

The factory creates `<name>.<factory>`, deploys the code and calls `new` in one batch, and adds no
access key ([factory lib.rs:80](contracts/factory/src/lib.rs#L80)). The account can only change
its code through `Migrate`: the owner proposes a code hash, it waits out the timelock like any
loosening, and `apply_migration`
([admin.rs:177](contracts/pursestrings/src/admin.rs#L177)) checks with the factory that the hash
was published before deploying it. Once the proposal is due, anyone can deliver code matching the
hash, so a DAO owner never has to store the wasm in a proposal of its own. That makes a due
migration final unless the owner cancels it before the timelock ends, or the account is frozen:
`apply_migration` refuses while frozen, and any council member can freeze. The factory's own keys
are deleted after init, and its admin can only append hashes.

Tests:
- [`inv7_factory_accounts_have_no_keys_and_published_code`](contracts/pursestrings/tests/factory.rs#L181)
- [`inv7_migration_is_timelocked_and_factory_checked`](contracts/pursestrings/tests/factory.rs#L286)

## What this doesn't protect against

- **Spending inside the policy.** A fooled agent can still pay an allowlisted recipient up to the
  limits. The policy bounds the damage; it doesn't judge intent.
- **A stolen owner key.** The thief can't loosen anything quickly, but they can approve pending
  co-signs and withdraw the account's NEAR and NEP-141 balances to the owner account, which they
  then control. Use a wallet you'd trust with the same funds directly, or a DAO as owner
  (the bounty board is owned by a Sputnik DAO: [board.rs](contracts/pursestrings/tests/board.rs)).
- **The MPC network.** EVM and intent signatures, and `confirm_evm` / `release_evm` proofs, trust
  NEAR's Chain Signatures network.
- **Reverted EVM transactions and chains the MPC can't verify.** These fall back to the owner's
  `resolve_evm`, which is a trusted statement by the owner.
- **Swap pricing.** A swap is protected by the owner's minimum rate for that pair, not by a
  market price.

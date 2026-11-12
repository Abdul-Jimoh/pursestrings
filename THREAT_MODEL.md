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
| Owner | Their own NEAR account (a wallet) | Approve co-signs, tighten the policy instantly, propose loosening, freeze, revoke agents, withdraw to itself (except NEAR held for buyers or unpaid shares), retract a paid scam report | Loosen anything before the timelock ends; change the code to a hash the factory didn't publish |
| Council member | Their own NEAR account | Approve bounty payouts their tier allows, post bounties, freeze | Approve payouts above the council tier (checked at approval), to themselves or on a bounty they posted; unfreeze; change the policy |
| Buyer or contributor | A NEAR account | Pay a quote (a wrong payment comes back in full); claim and submit a bounty | Get paid for a bounty they didn't claim, or more than its reward |
| Relayer | Nothing | Broadcast signed EVM transactions and intents the contract already approved | Change what was signed; mark a payment done (only an MPC proof can) |
| Anyone | A NEAR account | Call `confirm_evm`, `release_evm`, `settle_intent`, `expire_request`, `prune_requests`; deliver the code for a migration the owner proposed, once it's due | Make any of those succeed without the on-chain evidence each one checks; deploy code the owner didn't propose, before the timelock ends, or while frozen |

## Invariants

### 1. The agent's key can't move funds

`add_agent` creates a function-call key whose receiver is the account itself and whose methods are
only `request_spend`, `cancel_request`, `quote`, `deliver` and `refund`
([admin.rs:41](contracts/pursestrings/src/admin.rs#L41)). NEAR's protocol rejects any other use
of the key, including transfers. Owner methods call `assert_owner`, which needs exactly 1
yoctoNEAR attached, and a function-call key can't attach a deposit
([lib.rs:318](contracts/pursestrings/src/lib.rs#L318)). The one selling method that pays anything out, `refund`, can only
pay whoever paid that order, only within the owner's refund window, and only as all of the
payment before delivery or from the part of the price the account kept after it
([sales.rs](contracts/pursestrings/src/sales.rs)). `deliver` is refused while the account is
frozen, so a stolen agent key can't mark orders delivered and end the buyers' right to reclaim.
NEAR held for undelivered orders or unpaid split shares, counted per order and per payee, is out
of reach of agent spends, approvals, refunds after delivery and the owner's `withdraw`. The agent
keys sign as the account, so their gas comes from its balance: their allowances are set aside
too, as is the storage a shop's free quote slots could take. An upgrade from code that didn't
track held NEAR counts recent paid orders and unpaid shares in `migrate` ([sales.rs:80](contracts/pursestrings/src/sales.rs#L80),
[`the_owner_cannot_withdraw_what_buyers_paid_until_it_is_delivered`](contracts/pursestrings/tests/shop.rs#L176)).

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
([policy.rs:345](contracts/pursestrings/src/policy.rs#L345)): an op that isn't provably at least
as strict as the current policy goes into the queue with an `eta`; the rest apply at once
([admin.rs:106](contracts/pursestrings/src/admin.rs#L106)). A queued change that nobody applies
within seven days of its `eta` expires, so an old proposal can't be sprung after everyone stopped
watching it ([admin.rs:22](contracts/pursestrings/src/admin.rs#L22)). Raising the timelock is
tightening and applies at once, so it's capped at 30 days: a typo or a thief can't set one that
outlives everyone ([policy.rs:651](contracts/pursestrings/src/policy.rs#L651)). Unfreezing and adding recipients count
as loosening. So does any change to a window's length: usage is kept per length, and a new
length would start from zero
([`a_new_window_length_is_a_loosening`](contracts/pursestrings/src/policy.rs#L911)).

Test: [`inv3_loosening_waits_tightening_is_instant`](contracts/pursestrings/tests/invariants.rs#L170)
queues a limit raise, fails to apply it early, and cancels it. It lowers a cap and sees it
enforced on the next spend. In a mixed batch, the removal applies now and the new recipient
waits, and payments to the new recipient are denied until the timelock passes. Unit tests:
[`a_proposal_left_a_week_past_due_expires`](contracts/pursestrings/src/admin.rs#L381),
[`the_timelock_is_capped_at_thirty_days`](contracts/pursestrings/src/admin.rs#L460).

### 4. Budgets are deterministic, per-asset rolling windows

Each window is a ring of 24 time buckets ([ring.rs:9](contracts/pursestrings/src/ring.rs#L9)),
so it's accurate to one bucket: a spend at the very end of a bucket drops out of a daily window
23 hours and one second later, not 24 (see Known gaps). An
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
([spend.rs:506](contracts/pursestrings/src/spend.rs#L506)), so nothing is approved on a
screener's say-so.

### 6. Kill switch

`freeze` ([admin.rs:96](contracts/pursestrings/src/admin.rs#L96)) makes every request fail with
`Frozen`, blocks approving pending ones, and cancels every queued change
([admin.rs:295](contracts/pursestrings/src/admin.rs#L295)): an unfreeze or a loosening queued
before the freeze, by a thief with the owner's key or anyone else, can't apply after it; the owner
proposes again and waits out the timelock once unfrozen. At most 32 changes can be queued, and
expired ones are cleared when a new one is proposed, so a freeze always fits in one transaction
however much was queued. `revoke_agent`
([admin.rs:66](contracts/pursestrings/src/admin.rs#L66)) deletes the key in the same
transaction. Each is one owner transaction.

Test: [`inv6_freeze_and_revoke_in_one_transaction`](contracts/pursestrings/tests/invariants.rs#L428)
freezes the account, sees requests and approvals refused, sees that unfreezing is queued rather
than applied, and checks that a revoked key is gone from the account and can't call
`request_spend`. [`a_freeze_cancels_everything_queued`](contracts/pursestrings/src/admin.rs#L349)
queues an unfreeze, freezes, and fails to apply it;
[`a_full_queue_still_freezes_in_one_transaction`](contracts/pursestrings/src/admin.rs#L396)
fills the queue and freezes.

### 7. Nobody can swap the code

The factory creates `<name>.<factory>`, deploys the code and calls `new` in one batch, and adds no
access key ([factory lib.rs:80](contracts/factory/src/lib.rs#L80)). The account can only change
its code through `Migrate`: the owner proposes a code hash, it waits out the timelock like any
loosening, and `apply_migration`
([admin.rs:219](contracts/pursestrings/src/admin.rs#L219)) deploys it only if it's the factory's
newest release. Older builds stay published, but moving back to one could undo protections that
buyers paid under, such as NEAR held out of the owner's reach, so it's refused. Once the proposal is due, anyone can deliver code matching the
hash, so a DAO owner never has to store the wasm in a proposal of its own. That makes a due
migration final unless the owner cancels it before the timelock ends, or the account is frozen:
a freeze cancels it, and any council member can freeze. The factory's own keys
are deleted after init, and its admin can only append hashes.

Tests:
- [`inv7_factory_accounts_have_no_keys_and_published_code`](contracts/pursestrings/tests/factory.rs#L181)
- [`inv7_migration_is_timelocked_and_factory_checked`](contracts/pursestrings/tests/factory.rs#L286)

## What this doesn't protect against

- **Spending inside the policy.** A fooled agent can still pay an allowlisted recipient up to the
  limits. The policy bounds the damage; it doesn't judge intent.
- **A false delivery.** The contract can't check what `deliver` claims; the receipt (such as the
  report's hash) lets the buyer check it. Holding the payment protects a buyer from an agent that
  never delivers, not from one that delivers something false.
- **Token sales.** The shop takes NEAR only: a token balance can't be read synchronously, so
  token payments are sent back rather than held without the same protection.
- **A stolen owner key.** The thief can't loosen anything quickly, but they can approve pending
  co-signs and withdraw the account's NEAR (except what's held for buyers) and NEP-141 balances
  to the owner account, which they then control. Use a wallet you'd trust with the same funds directly, or a DAO as owner
  (the bounty board is owned by a Sputnik DAO: [board.rs](contracts/pursestrings/tests/board.rs)).
- **The MPC network.** EVM and intent signatures, and `confirm_evm` / `release_evm` proofs, trust
  NEAR's Chain Signatures network.
- **Reverted EVM transactions and chains the MPC can't verify.** These fall back to the owner's
  `resolve_evm`, which is a trusted statement by the owner.
- **Swap pricing.** A swap is protected by the owner's minimum rate for that pair, not by a
  market price.

## Known gaps

- **No risk screener** (invariant 5): a risk threshold sends the request to the owner instead.
- **A window is accurate to one bucket.** With 24 buckets, a spend at the end of a bucket is
  forgotten one bucket early, so in the worst case a daily limit can be spent twice within 23
  hours and one second. Making it conservative changes how stored windows are laid out, which we
  didn't want to migrate on live accounts this close to submission.
- **Accounts on builds before `newest release only` can still downgrade.** The rule lives in the
  account's own code, so it protects an account from the migration that installs it onward. The
  testnet Range account runs the Nov 2 build and can't migrate (README, Limitations).
- **A council member can wipe the owner's queue.** Any council member can freeze, and a freeze
  cancels everything queued, so a rogue member could keep cancelling a DAO's queued changes, or
  re-freeze after each unfreeze. The DAO removes the member instantly (`RemoveCouncil` is a
  tightening) in the same vote as its `Unfreeze`.
- **Newest release only cuts both ways.** Publishing a new release makes every pending
  migration to an older one fail, so owners propose again. A broken newest release, or a lost
  factory admin key, stops every account on this code from migrating until a fixed build is
  published, and a hash can't be published twice. The factory's `releases` view grows with every
  release; at about 700 the check runs out of gas and accounts on this code can't migrate again.
- **The live demo's shared budgets.** The model budget, the agent key's gas and the shop's 64
  quote slots are shared. Each account gets a daily share of the model budget, two open quotes
  and 20 contract calls a day from chat (300 in all), and quotes last ten minutes, so it takes
  many accounts to exhaust them, but enough free testnet accounts still could, until midnight UTC
  or the quotes expire. The status endpoint shows the agent key's remaining gas.
- **The relayer can delay** an EVM payment but can't change it. A signed transaction keeps its
  budget reserved until it's proven settled or replaced.
- **An EVM cancel's own gas isn't counted.** Once a same-nonce cancel is proven, the original's
  whole gas reservation is released, though the cancel burned some gas. Only the owner can sign a
  cancel.
- **Not all storage growth is set aside.** Held NEAR, the agent keys' gas and a shop's quote
  slots are reserved, and a payment is refused unless the account can store its order out of what
  it could spend itself; so is a spend request, in any asset. Finished orders and requests stay
  stored until pruned (anyone can prune finished requests after seven days). A delivery's receipt
  (up to 256 bytes) and new bounties add storage with no such check.
- **Token payments don't count as scam evidence.** A linked transaction counts when the address
  signed or received it, so a USDC transfer, whose receiver is the token contract, doesn't.
- **The upgrade script's checks bind only the script.** Anyone can deliver a due migration, so
  an account still on code from before held-NEAR tracking could be upgraded with open orders,
  which then stay untracked unless they're among the newest 50.
- **One superseded build over-counts on upgrade.** An account running the code at `4fe267a`
  (published on the testnet factory, run by no account) would count its held NEAR twice when
  upgraded. That locks NEAR rather than releasing it; the owner can't withdraw the excess.
- **A failed upgrade needs a new proposal.** If the code deploy fails, the `Migrate` proposal is
  already used, so the owner proposes it again and waits out the timelock again.

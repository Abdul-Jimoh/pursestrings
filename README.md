<p align="center"><img src=".github/assets/banner.png" alt="Pursestrings: your agent holds the purse, you hold the strings" width="100%"></p>

# Pursestrings

AI agents that run a business and a community fund on NEAR, where the money only moves by rules
a contract enforces. Talk the agent into anything; the contract still decides.

Built at NEAR HACKATHON for **Autonomous Business**, **Social Money**, **Agent Economy** and
**AI Security & Defense**. A spending cap alone doesn't make an agent safe to run a business, so
here the capped agents run a shop that sells to the public and a fund owned by a DAO; the
contract builds every payment itself, on NEAR, on Base through Chain Signatures and through NEAR
Intents; and any rule change that loosens the policy waits out a public timelock. 1,000 attacks
on testnet, none got through.

[![CI](https://github.com/Abdul-Jimoh/pursestrings/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)
· [pursestrings.site](https://pursestrings.site) · [The shop](https://pursestrings.site/shop)
· [Its ledger](https://pursestrings.site/shop/ledger) · [Bounties](https://pursestrings.site/bounties)
· [The Range](https://pursestrings.site/range) · [Threat model](THREAT_MODEL.md)

## In one minute

- **An agent runs a shop.** It sells *Check before you pay*: a plain-English verdict on a NEAR
  account or 0x address before you send it money. It haggles, quotes, delivers and refunds on its
  own, and pays its own model costs.
- **A DAO runs a bounty board.** People are paid for reporting scam addresses. A second agent
  reviews each report and asks for the payout; how much it can pay without a human depends on
  the reporter's track record.
- **The two feed each other.** 20% of every sale goes to the DAO, and every paid report makes the
  shop's next check smarter.
- **Neither agent holds money.** Each has a NEAR key that can only *ask* a Pursestrings contract.
  The floor price, the revenue split, refund limits, who may approve a payout and every spending
  limit live in the contract, so a jailbroken agent can agree to anything and still move nothing
  outside them.

```mermaid
flowchart LR
    buyer(["Buyer"]) -- "haggles, pays" --> shop["Shop agent"]
    shop -- "quote / deliver / refund" --> sc[("Shop contract<br/>floor · held payment · split")]
    sc -- "70%" --> owner(["Owner"])
    sc -- "20%" --> dao[("Community DAO<br/>Sputnik v3.2")]
    sc -- "pays its own<br/>model costs" --> ops(["Model credits"])
    dao -- "owns, funds,<br/>votes big payouts" --> bc[("Bounty contract<br/>earned-trust tiers")]
    reporter(["Reporter"]) -- "claims, reports a scam" --> bc
    bagent["Bounty agent"] -- "reviews, requests payout" --> bc
    bc -- "paid reports =<br/>scam list" --> shop
```

## Try it

**Anywhere, no chain:** `make verify` needs only `cargo` (and Node 22+ with pnpm 10 for the
services). It runs the contract's unit and property tests and prints each claim beside the test
that proves it, runs the TypeScript tests, then replays a recording of `make demo`
([scripts/verify.sh](scripts/verify.sh), [the recording](scripts/verify/demo-transcript.txt)). The
first run spends about 5 to 7 minutes compiling (it prints progress); after that it takes under a
minute.

**The whole story on a local chain, from a fresh clone, no keys or accounts:** you need `cargo` (rustup reads
[rust-toolchain.toml](rust-toolchain.toml)), [cargo-near](https://github.com/near/cargo-near) 0.22
to build the contracts, Node 22+ and pnpm 10. CI runs both commands from a clean checkout
([ci.yml](.github/workflows/ci.yml)).

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/download/cargo-near-v0.22.0/cargo-near-installer.sh | sh
```

| Do | See |
|---|---|
| `make demo` | A local NEAR chain at mainnet's protocol version, then the whole story with do-X-see-Y checks ([demo.ts](apps/agent/src/demo.ts)): an agent pays on NEAR, on Base through Chain Signatures and through NEAR Intents from one budget, and survives six attacks. The shop refuses a quote under its floor, holds a payment, delivers the check with its hash on-chain and splits the sale. The DAO's board pays scam reports by earned trust and refuses a council member's payout to themselves. The shop's next check finds the reported address. Ends with `demo OK: 37/37 checks passed`. |
| `make redteam` | Six attacks, compared line for line with [expected.txt](scripts/redteam/expected.txt). |
| `make test` | Contract unit and property tests, sandbox tests for every invariant (against the real mainnet `intents.near` and Sputnik DAO code), and the TypeScript tests. |

**Live on NEAR testnet:**

| Open | Do |
|---|---|
| [/shop](https://pursestrings.site/shop) | Haggle for a check, pay from your wallet, watch the contract hold the money and pay it out on delivery. |
| [/range](https://pursestrings.site/range) | Try to get a check for less than the contract allows. The front desk is soft on purpose: it agrees to any price and refunds anyone. |
| [/bounties](https://pursestrings.site/bounties) | Claim a bounty, report a scam address, see the agent's review and who has to approve your payout. |
| [/shop/ledger](https://pursestrings.site/shop/ledger) | Every order, payout and refusal, read from the chain, and the 1,000-attack marathon. |

## What it looks like

Screens from the live testnet site, captured on Nov 11.

| | |
|---|---|
| ![A paid check: held, delivered, split, and the verdict "do not pay"](.github/assets/shop-verdict.jpg) | ![The front desk agreed to 0.01 NEAR; the contract refused to quote it](.github/assets/floor-refused.jpg) |
| **A paid check.** The contract held the 0.08 NEAR until the agent delivered, then split it. The verdict on the lookalike `ps-cornmunity-1107` is "do not pay". | **Haggling below the floor.** The front desk agreed to 0.01 NEAR; the contract refused to quote it, and the refusal is a transaction. |
| ![ProcureBot was told to pay a new address; the contract refused](.github/assets/range-refused.jpg) | ![The community scam list and contributors' points](.github/assets/scam-list.jpg) |
| **A jailbreak on the Range.** ProcureBot was talked into sending 40 USDC to a new address; the contract refused it as off the allowlist. | **The bounty board.** Each paid scam report is a point for its reporter and an entry the shop checks against. |

## For each track

| Track | What it asks for | Where it is here |
|---|---|---|
| Autonomous Business | AI-native business, treasury, sales, revenue sharing; humans set the constraints | An agent sells checks, haggles, delivers and refunds; the owner's floor, split and refund window are contract rules; the shop pays its own model costs, in NEAR ([`CPwmrN2C…`](https://testnet.nearblocks.io/txns/CPwmrN2CbFzt2crGxSB29cbK1b9rzq9Nq5KWpHys7qUB)) or cross-chain in USDC on Base through Chain Signatures ([`0x3c80658a…`](https://sepolia.basescan.org/tx/0x3c80658a8b0fd2d98728dc3f967089bc47d64e5e3e0556484eb8de401e109eb6)) |
| Social Money | Shared budgets, programmable rewards, reputation-based access on Sputnik DAO | A Sputnik DAO owns the bounty purse; payouts are approved by earned points, a council or a DAO vote ([Earned trust](#earned-trust-and-the-dao-above-it)) |
| Agent Economy | Agents that earn, spend and pay for compute | The shop agent earns from sales and pays its model bill through the same policy; the procurement agent pays on NEAR, Base and Intents |
| AI Security & Defense | Spending limits, policy engines, sandboxed wallets, scam detection | Function-call keys that can only ask, contract-built payments, timelocked loosening, a public jailbreak Range and a scam list ([THREAT_MODEL.md](THREAT_MODEL.md)) |

## What the agents can't do

The shop's agent has a function-call key limited to five methods
([admin.rs:13](contracts/pursestrings/src/admin.rs#L13)). Each rule below is enforced in the
contract and tested.

| However it's talked into it, the agent can't… | Because | Test |
|---|---|---|
| Sell below the owner's floor | `quote` refuses and logs it ([sales.rs:229](contracts/pursestrings/src/sales.rs#L229)) | [`a_sale_respects_the_floor_and_is_split_on_delivery`](contracts/pursestrings/tests/shop.rs#L92) |
| Walk off with a buyer's payment | Payments are held until `deliver`; after the delivery window the buyer takes the payment back, even if the shop is frozen ([sales.rs:379](contracts/pursestrings/src/sales.rs#L379)). While frozen, the agent can't mark orders delivered ([sales.rs:348](contracts/pursestrings/src/sales.rs#L348)) | [`an_undelivered_payment_goes_back_to_the_buyer_even_when_frozen`](contracts/pursestrings/tests/shop.rs#L214) |
| Spend what buyers paid | The owner's `withdraw`, an agent's NEAR spend, an approval and a refund after delivery all stop short of NEAR held for undelivered orders or unpaid shares, counted per order and per payee. The agent keys' gas allowances and, for a shop, its free quote slots' storage are set aside too, since the keys sign as the account ([sales.rs:80](contracts/pursestrings/src/sales.rs#L80)) | [`the_owner_cannot_withdraw_what_buyers_paid_until_it_is_delivered`](contracts/pursestrings/tests/shop.rs#L176), [`held_near_is_out_of_reach_until_delivery`](contracts/pursestrings/src/sales.rs#L827) |
| Refund someone else, or refund a check into being free | Refunds go only to the payer: all of it before delivery, or at most the shop's kept share after ([sales.rs:604](contracts/pursestrings/src/sales.rs#L604)) | [`a_delivered_order_never_costs_less_than_the_floor_allows`](contracts/pursestrings/src/props.rs#L247) |
| Redirect the revenue | Any split change is a loosening and waits out the timelock in public ([policy.rs:365](contracts/pursestrings/src/policy.rs#L365)) | [`a_sale_respects_the_floor_and_is_split_on_delivery`](contracts/pursestrings/tests/shop.rs#L92) |
| Pay a bounty to anyone but its claimant, or more than its reward | [bounty.rs:234](contracts/pursestrings/src/bounty.rs#L234) | [`a_dao_owned_board_pays_by_earned_trust`](contracts/pursestrings/tests/board.rs#L75) |
| Pay anyone else, or more than the budget | Allowlists, per-payment caps, rolling windows, velocity ([spend.rs](contracts/pursestrings/src/spend.rs#L334)) | [`no_admitted_spend_breaks_a_rule`](contracts/pursestrings/src/props.rs#L115) |

The contract can't check what was delivered: `deliver` records a receipt, such as the report's
hash, that the buyer can compare. Holding the payment protects a buyer from an agent that never
delivers, not from one that delivers something false.

The agents' judgement is kept away from the money too. The checks' verdicts come from fixed
rules and the model only writes the explanation ([check.ts](apps/shop/src/check.ts)). The bounty
agent's rules decide whether a report qualifies: the address must imitate a protected name, be
flagged by the block explorer, or link a transaction that the agent looks up and finds the address
signed or received. That shows the address was used, not that it scammed anyone, since anyone can
send it a transaction: newcomers' payouts need a council member, and the DAO can retract a wrong
report. The model may only veto
([board.ts](apps/shop/src/board.ts)).

## Earned trust, and the DAO above it

Who approves a bounty payout depends on how many paid reports the reporter already has. Points
come only from bounties paid in full, and each traces back to its bounty
([bounty.rs:266](contracts/pursestrings/src/bounty.rs#L266), [`a_partial_payout_earns_no_point`](contracts/pursestrings/src/bounty.rs#L488)).

| Reporter's points | Paid with no approval | One council member can approve | Above that |
|---|---|---|---|
| 0 (newcomer) | nothing | up to 0.3 NEAR | the DAO votes |
| 1 | up to 0.1 NEAR | up to 0.5 NEAR | the DAO votes |
| 3 | up to 0.3 NEAR | up to 1 NEAR | the DAO votes |

These are the testnet board's tiers ([testnet-setup.ts](apps/shop/scripts/testnet-setup.ts)).

- **Council members can't approve their own payouts, or any payout on a bounty they posted**,
  so they can't post a bounty for a second account and approve it themselves. Paying a second
  account on someone else's bounty still needs that bounty's evidence to pass review ([spend.rs:215](contracts/pursestrings/src/spend.rs#L215),
  [test](contracts/pursestrings/src/bounty.rs#L501)). A council approval uses the tier in force at that moment, not when
  the request was made ([test](contracts/pursestrings/src/bounty.rs#L518)).
- **The DAO can take a wrong report back.** A retracted bounty leaves the scam list and the
  reporter loses its point; the payout isn't clawed back ([bounty.rs:168](contracts/pursestrings/src/bounty.rs#L168),
  [test](contracts/pursestrings/src/bounty.rs#L532)).
- **One open claim per account**, so nobody can sit on every bounty at once
  ([bounty.rs:105](contracts/pursestrings/src/bounty.rs#L105), [test](contracts/pursestrings/src/bounty.rs#L550)).
- **Any council member can freeze the board at once**
  ([admin.rs:87](contracts/pursestrings/src/admin.rs#L87)). Unfreezing, adding a council member
  or raising a tier waits for a DAO vote and then the timelock
  ([`any_council_member_freezes_and_only_the_dao_loosens_after_the_timelock`](contracts/pursestrings/tests/board.rs#L144)).
- **The DAO is the real mainnet Sputnik v3.2 code**, in the sandbox tests and on testnet.

## How hard it's been pushed

```mermaid
pie showData
    title 1,000 attacks on the testnet shop and bounty board, all refused
    "Fooled agent: refused and logged on-chain" : 652
    "Outsider: transaction failed as expected" : 322
    "Agent key misuse: refused by NEAR itself" : 26
```

- **Attack marathon:** 1,000 scripted attacks on testnet, as a fooled agent with a real key and
  as an outsider. Every refusal is either a decision the contract logged or a failure with the
  reason expected for that attack ([marathon.ts](apps/shop/scripts/marathon.ts), results with
  sample transactions in [marathon.json](apps/web/public/marathon.json)).
- **Property tests:** random policies and random histories of requests, approvals, rejections,
  payments, refunds and deliveries, checked against a plain model of the rules, 10,000 cases each
  in CI. After every step, the NEAR kept out of reach must equal what undelivered orders hold
  ([props.rs](contracts/pursestrings/src/props.rs)). Breaking any one rule in the contract makes
  them fail. Writing them found a real bug: a partial refund before delivery could sell a check
  below the floor. It's fixed, and the live shop was upgraded
  ([`2WQLJ5nt…`](https://testnet.nearblocks.io/txns/2WQLJ5ntxuhvyULmJngVehA6Q7nk2vaYiirr4thEDQ5m)).
- **The Range:** a public page where anyone can try to talk the agents into breaking the rules
  ([pursestrings.site/range](https://pursestrings.site/range)). Its hall of fame is computed
  from the chain.

## The engine underneath

Both businesses run on Pursestrings, a general spending policy for an agent across every chain it
touches. The agent sends structured fields; everything that gets signed is built inside the
contract.

- **On NEAR:** native and NEP-141 transfers ([spend.rs](contracts/pursestrings/src/spend.rs#L170)).
- **On any EVM chain:** the contract builds the EIP-1559 transaction
  ([evm.rs:99](contracts/pursestrings/src/evm.rs#L99)) and NEAR's MPC network signs it for the
  account's own derived address ([evm.rs:354](contracts/pursestrings/src/evm.rs#L354)).
- **Through NEAR Intents:** direct transfers and withdrawals, and swaps signed as a `token_diff`
  the contract wrote ([intents.rs:128](contracts/pursestrings/src/intents.rs#L128)).

One budget can span all three ([policy.rs:53](contracts/pursestrings/src/policy.rs#L53)).

```mermaid
sequenceDiagram
    participant A as Agent
    participant P as Pursestrings contract
    participant M as NEAR MPC network
    participant R as Relayer (untrusted)
    participant B as Base
    A->>P: request_spend { asset, amount, dest, purpose }
    Note over P: caps, windows, allowlists, velocity.<br/>Reserve the budget.
    alt refused
        P-->>A: Denied { reason }, logged
    else approved, EVM
        P->>P: build the transaction from the fields
        P->>M: sign
        M-->>P: signature
        R->>B: broadcast (can delay, can't change it)
        R->>P: confirm_evm (anyone can call)
        P->>M: verify_foreign_transaction
        Note over P: Done: final and succeeded, proven on-chain
    end
```

Rules have two speeds. Making the policy stricter (lower caps, fewer recipients, a higher floor,
freezing, revoking an agent) applies in the same transaction. Making it looser is queued behind
a timelock that the owner can cancel. Code changes follow the same path, to hashes the factory
published. The seven security invariants, where each is enforced and the test for each, are in
[THREAT_MODEL.md](THREAT_MODEL.md).

## Verify it on testnet

| Claim | Transaction |
|---|---|
| The shop refuses a quote under its floor, and logs it | [`461xPH21…`](https://testnet.nearblocks.io/txns/461xPH21n9kN75WkgTjSdCgKGTvVJApG8VNMN4KKLukb): `Denied { BelowFloor }`, from a Range player's "I'm a student, 0.001 NEAR?" |
| A refund larger than the shop's kept share is refused | [`B5SxYYq2…`](https://testnet.nearblocks.io/txns/B5SxYYq2MDugEND657AYGaZaFEENQYfv5pgF4yr85tCv): 0.1 NEAR asked on a 0.05 order, `OverHeld { max: 0.005 }` |
| A sale: quoted, paid and held, then delivered and split | Quote [`8BznUKJr…`](https://testnet.nearblocks.io/txns/8BznUKJr1DscecbekyqYGxj8daYoXdSoW2M4xGbmtZ2V), payment held [`FV91MggJ…`](https://testnet.nearblocks.io/txns/FV91MggJA6xYXVnfyDHgbc9G5DJok1LhL3D5EUX7PMdx); the order and its receipt on the [ledger](https://pursestrings.site/shop/ledger) |
| A newcomer's payout waits for one council member | Request [`BAyHL9R7…`](https://testnet.nearblocks.io/txns/BAyHL9R7jLT3YaYoNJWTRUYigqFK1qrc6eMJRX5VwDvM) `NeedsCouncil`, approval [`FCrQUmgn…`](https://testnet.nearblocks.io/txns/FCrQUmgn1p7GmWdvdFmAhoq1tswjY9j1F9Xb2Tx6KKjX) by a council member who didn't post the bounty |
| One point later, the next small payout needs nobody | [`HG4QC5hd…`](https://testnet.nearblocks.io/txns/HG4QC5hd61bhE4iaV1quNdvPNawBWzpeaFWtXhbZGdyB): `Approved` (the reporters in these rows are our own scripted test accounts) |
| The shop pays its own model costs out of its earnings | [`CPwmrN2C…`](https://testnet.nearblocks.io/txns/CPwmrN2CbFzt2crGxSB29cbK1b9rzq9Nq5KWpHys7qUB): 0.0011 NEAR for 17 model calls, a `request_spend` under the shop's policy |
| …and pays them cross-chain, in USDC on Base, built by the contract and signed by the MPC network | Request [`CDo3zQue…`](https://testnet.nearblocks.io/txns/CDo3zQueS6rk1ufLpJn8dvbqfiiisZrJ7g1PuabrF6US) (0.001246 USDC for 5 calls), Base Sepolia [`0x3c80658a…`](https://sepolia.basescan.org/tx/0x3c80658a8b0fd2d98728dc3f967089bc47d64e5e3e0556484eb8de401e109eb6) broadcast by the API's relayer, proven final by a third party [`5p8eXjJX…`](https://testnet.nearblocks.io/txns/5p8eXjJX42Yn8jKKUfZd5ouFxHxzeKeAmCJwZBVnAGnV) |
| A Base payment built by the contract, signed by the MPC network, proven final by a third party | Request [`6tZx8ojH…`](https://testnet.nearblocks.io/txns/6tZx8ojHjogyKUbBgH2j2ZYbQmvZL85DvRna29JR9Y8J), Base Sepolia [`0x0b9ca7be…7bbb`](https://sepolia.basescan.org/tx/0x0b9ca7be8ab0133f35d05326086129364ac5a3f46e8ba51e22209567f19b7bbb), proof [`6to9rRaQ…`](https://testnet.nearblocks.io/txns/6to9rRaQ76mQENKhWAqAZFxPBHYEQCUSYp99Zm7rnqNv) |
| Code changes only to a published hash, after the timelock | Shop: publish [`F1Kb3W9V…`](https://testnet.nearblocks.io/txns/F1Kb3W9Vv1QSe8NdEZZ7HgjioVuo3q9hNnCuVBhmT32R), propose [`4HxtK6j2…`](https://testnet.nearblocks.io/txns/4HxtK6j2y6nfX43syVMKRrvStjKspNcU9Pb2jCzTPK8a), apply an hour later [`2WQLJ5nt…`](https://testnet.nearblocks.io/txns/2WQLJ5ntxuhvyULmJngVehA6Q7nk2vaYiirr4thEDQ5m) |
| The accounts can't be changed by a key | [shop](https://testnet.nearblocks.io/address/shop.factory.ps-spike-1028.testnet) and [board](https://testnet.nearblocks.io/address/board.factory.ps-spike-1028.testnet): only agent function-call keys, no full-access key |

## Built on NEAR, and why it has to be

| NEAR feature | What it does here |
|---|---|
| Function-call access keys | The protocol itself limits each agent key to a few methods on one account, with a gas allowance |
| Chain Signatures | One contract controls addresses on other chains and signs only what it built (`sign`); `verify_foreign_transaction` proves a Base payment final without an oracle ([evm.rs:203](contracts/pursestrings/src/evm.rs#L203)) |
| NEAR Intents | The same account is an identity on `intents.near`: transfers, withdrawals and contract-built swaps under the same policy ([tests/intents.rs](contracts/pursestrings/tests/intents.rs), mainnet v0.4.5 code) |
| Sputnik DAO | Owns the bounty board; votes payouts above the council's limit and every loosening |
| Factory sub-accounts | `<name>.<factory>` with no access keys at all ([factory lib.rs:80](contracts/factory/src/lib.rs#L80)) |
| NEP-141, NEP-297, NEP-413 | Token spends, an event for every decision, wallet sign-in |
| NEAR AI Cloud | The agents' model (Claude Haiku 5.5) |

On other chains you'd get one of these at a time: a key limited by the protocol, a contract that
signs on other chains, a cross-chain intent identity and a DAO owner. On NEAR they're one account.

## Sustainability

The shop is the business model, running: each sale pays the owner 70%, the community 20% and
keeps 10% for refunds. The agent pays its own model costs back out of those earnings, in NEAR or
in USDC on another chain, as a `request_spend` under the same policy ([costs.ts](apps/shop/src/costs.ts),
[tests](apps/shop/src/costs.test.ts)). The community share funds the bounties that
make the product better. The same engine can run other agent businesses that have to be trusted
with money. Nothing in the payment path needs our server: the relayer is replaceable, and anyone
can submit settlement proofs.

## Limitations

- **Testnet only so far.** Intents has no testnet, so its paths are tested in the sandbox against
  the mainnet `intents.near` code.
- **The shop sells in NEAR only.** The contract can read its own NEAR balance when money leaves,
  so it can keep buyers' payments apart. A token balance lives in the token's contract and can
  only be read asynchronously, so token payments are sent back until that's built safely.
- **A stolen owner key** can't loosen anything quickly, but it can approve pending requests and
  withdraw to the owner's own account (never NEAR held for buyers).
- **No USD budgets:** limits are in each asset's own units, with no price oracle.
- **The first bounty board couldn't be upgraded.** Its DAO owner can't carry a 573 KB upgrade in
  one proposal, and its code predates the fix that lets anyone deliver code once the owner's
  upgrade is due. The live board, `board.factory.ps-spike-1028.testnet`, was created again from
  the factory with the current code; the old `bounties.factory.ps-spike-1028.testnet` stays as
  history.

Smaller known gaps (no risk screener yet, relayer delay, storage growth, an EVM cancel's gas,
upgrade edge cases, evidence rules) are listed in [THREAT_MODEL.md](THREAT_MODEL.md#known-gaps).

## Repository

| Path | What it is |
|---|---|
| [contracts/pursestrings](contracts/pursestrings) | The policy contract: spending, the shop, the bounty board (near-sdk 5.29) |
| [contracts/factory](contracts/factory) | Creates keyless accounts and publishes the code hashes they may upgrade to |
| [apps/shop](apps/shop/src) | The shop agent, the checks, delivery, the bounty agent and the cost payments |
| [apps/range](apps/range/src) | The API on Fly: the agents' model, NEP-413 sign-in, rate limits, a daily model-cost cap |
| [apps/web](apps/web/src) | pursestrings.site |
| [apps/agent](apps/agent/src) | `make demo` and `make redteam` |
| [packages/sdk](packages/sdk), [packages/mcp](packages/mcp/src/server.ts) | TypeScript SDK; MCP server so any agent can use a Pursestrings account with only its agent key |
| [services/relayer](services/relayer/src/relayer.ts) | Broadcasts signed EVM transactions and swaps, submits settlement proofs; holds nothing that matters |

How to check each claim is in [AGENTS.md](AGENTS.md).

## Built with

- **AI-assisted code:** written with Claude Code (Anthropic).
- **Libraries:** near-sdk 5.29.1 and omni-transaction 0.5 (EVM transactions) in the contract;
  near-contract-standards and k256 in the test token and mock MPC signer; near-sandbox, near-api,
  cargo-near-build, proptest, sha3, ed25519-dalek, tokio and testresult for the tests, following
  the `cargo near new` template's sandbox setup; borsh and serde_json in the local devnet.
  near-api-js 7.4, @noble/curves, @noble/hashes, the MCP TypeScript SDK and zod in the SDK, MCP
  server, agents and API; Next.js 16, React 19, Tailwind 4, GSAP, Lenis, lucide-react and
  @hot-labs/near-connect 0.12 for the site; Biome, TypeScript and Vitest for tooling. Fonts:
  Archivo, Instrument Serif and JetBrains Mono (SIL Open Font License, via Google Fonts).
- **Third-party contracts in the tests:** the mainnet `intents.near` v0.4.5 and Sputnik DAO v3.2
  code, both MIT ([tests/fixtures](contracts/pursestrings/tests/fixtures)).
- **Baseline:** none. Every commit in this repository was made inside the hackathon window.

## License

[Apache-2.0](LICENSE)

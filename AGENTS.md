# Working in this repo

A map of the code and how to check what the README and THREAT_MODEL.md say.

## The short path

1. `make verify` (needs `cargo`; Node 22+ and pnpm 10 for part 2). Expect 18 lines starting `ok`,
   `test result: ok. 76 passed` for the contract, every TypeScript suite passing, then the
   recording of `make demo` ending `demo OK: 37/37 checks passed`.
2. `make demo` (also needs cargo-near 0.22). The same story live on a local chain, about 2 minutes
   once built. CI runs it on every push (the `demo` job in `.github/workflows/ci.yml`).
3. On testnet, read-only and without an account:
   `near contract call-function as-read-only shop.factory.ps-spike-1028.testnet recent_orders json-args '{"limit":10}' network-config testnet now`,
   or open the transactions in the README's "Verify it on testnet" table.

## Layout

| Path | Language | What it is |
|---|---|---|
| `contracts/pursestrings/src` | Rust, near-sdk 5.29 | The policy contract. `spend.rs` (request_spend, evaluation, reservations), `policy.rs` (policy, ops, `classify`), `admin.rs` (owner methods, timelock, migration), `evm.rs` (EIP-1559 building, Chain Signatures, settlement proofs), `intents.rs` (NEAR Intents), `sales.rs` (the shop: quotes, held payments, split, refunds), `bounty.rs` (bounties, points, trust tiers), `ring.rs` (rolling windows), `events.rs` (NEP-297), `props.rs` (property tests) |
| `contracts/pursestrings/tests` | Rust | Sandbox tests: a local NEAR node at mainnet's protocol version. `common/` starts it and deploys the contracts |
| `contracts/factory` | Rust | Creates keyless accounts; the admin can only append code hashes |
| `contracts/test-token`, `contracts/test-mpc` | Rust | A NEP-141 token and a mock MPC signer for tests and the demo |
| `scripts/devnet` | Rust | The local chain behind `make demo` and `make redteam` |
| `packages/sdk` | TypeScript | Contract client, types mirroring the contract's JSON, signed-transaction decoding |
| `packages/mcp` | TypeScript | MCP server exposing the agent's tools |
| `services/relayer` | TypeScript | Broadcasts signed EVM transactions, publishes swaps, submits settlement proofs |
| `apps/agent` | TypeScript | `demo.ts` (the scripted demo) and `redteam.ts` (six attacks) |
| `apps/shop` | TypeScript | The shop agent (`seller.ts`), checks (`check.ts`), delivery (`deliver.ts`), the bounty agent (`board.ts`), cost payments (`costs.ts`), the Range shop challenge (`range.ts`). `scripts/` hold testnet setup, loops, upgrades and the attack marathon, which need local testnet keys |
| `apps/range` | TypeScript | The API on Fly: the Range, the shop and board routes, sign-in and limits |
| `apps/web` | TypeScript, Next.js 16 | pursestrings.site: landing page, `/shop`, `/shop/ledger`, `/bounties`, `/range`, `/app` (owner dashboard) |

## Commands

```sh
make verify      # no chain or cargo-near: each claim beside its passing test, then a recording of make demo
make test       # contract unit tests, sandbox tests, TypeScript typecheck and tests
make demo       # local chain + the scripted demo agent; ends with "demo OK: 37/37 checks passed"
make redteam    # six attacks; output must match scripts/redteam/expected.txt
make lint       # rustfmt, clippy -D warnings, Biome
```

`make demo` and `make redteam` need `cargo`, cargo-near 0.22, Node 22+ and pnpm 10, and nothing else: no NEAR
account, keys or network. Sandbox tests download a `near-sandbox` binary on first run.

## Checking a claim

1. Find the invariant in [THREAT_MODEL.md](THREAT_MODEL.md). Each one links to the code that enforces
   it and the sandbox test that checks it.
2. Run that test alone, for example
   `cargo test -p pursestrings --test invariants inv3_loosening_waits_tightening_is_instant`.
   Property tests run with the unit tests; `PROPTEST_CASES=1000000 cargo test -p pursestrings --lib props`
   runs a million cases.
3. For live behaviour, use the testnet transactions in the README's "Verify it on testnet" table. Any
   NEAR view method can be called without an account, for example
   `near contract call-function as-read-only range.factory.ps-spike-1028.testnet policy json-args {} network-config testnet now`.

## Conventions

- The contract takes no hash, raw transaction, calldata, nonce or gas value from the agent; adding
  a field to `SpendRequest` (`types.rs`) needs the same scrutiny as invariant 2.
- Owner methods call `assert_owner` (1 yoctoNEAR, predecessor is the owner).
- Anything that loosens the policy must classify as `Loosen` in `policy.rs`; add a case to the
  `classify` tests and to `apps/web/src/lib/ops.ts`, which mirrors it for the dashboard preview.
- near-sdk is pinned to 5.29.1 because mainnet runs protocol 86; `tests/protocol.rs` guards it.

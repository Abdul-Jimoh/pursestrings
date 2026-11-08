# Working in this repo

A map of the code and how to check what the README and THREAT_MODEL.md say.

## Layout

| Path | Language | What it is |
|---|---|---|
| `contracts/pursestrings/src` | Rust, near-sdk 5.29 | The policy contract. `spend.rs` (request_spend, evaluation, reservations), `policy.rs` (policy, ops, `classify`), `admin.rs` (owner methods, timelock, migration), `evm.rs` (EIP-1559 building, Chain Signatures, settlement proofs), `intents.rs` (NEAR Intents), `ring.rs` (rolling windows), `events.rs` (NEP-297) |
| `contracts/pursestrings/tests` | Rust | Sandbox tests: a local NEAR node at mainnet's protocol version. `common/` starts it and deploys the contracts |
| `contracts/factory` | Rust | Creates keyless accounts; the admin can only append code hashes |
| `contracts/test-token`, `contracts/test-mpc` | Rust | A NEP-141 token and a mock MPC signer for tests and the demo |
| `scripts/devnet` | Rust | The local chain behind `make demo` and `make redteam` |
| `packages/sdk` | TypeScript | Contract client, types mirroring the contract's JSON, signed-transaction decoding |
| `packages/mcp` | TypeScript | MCP server exposing the agent's tools |
| `services/relayer` | TypeScript | Broadcasts signed EVM transactions, publishes swaps, submits settlement proofs |
| `apps/agent` | TypeScript | `demo.ts` (the scripted demo) and `redteam.ts` (six attacks) |
| `apps/range` | TypeScript | The Range API: an LLM agent on the MCP tools, sign-in and limits |
| `apps/web` | TypeScript, Next.js 16 | pursestrings.site: landing page, `/range`, `/app` (owner dashboard) |

## Commands

```sh
make test       # contract unit tests, sandbox tests, TypeScript typecheck and tests
make demo       # local chain + the scripted demo agent; ends with "demo OK: 37/37 checks passed"
make redteam    # six attacks; output must match scripts/redteam/expected.txt
make lint       # rustfmt, clippy -D warnings, Biome
```

`make demo` and `make redteam` need `cargo`, Node 22+ and pnpm 10, and nothing else: no NEAR
account, keys or network. Sandbox tests download a `near-sandbox` binary on first run.

## Checking a claim

1. Find the invariant in [THREAT_MODEL.md](THREAT_MODEL.md). Each one links to the code that enforces
   it and the sandbox test that checks it.
2. Run that test alone, for example
   `cargo test -p pursestrings --test invariants inv3_loosening_waits_tightening_is_instant`.
3. For live behaviour, use the testnet transactions in the README's "Verify it yourself" table. Any
   NEAR view method can be called without an account, for example
   `near contract call-function as-read-only range.factory.ps-spike-1028.testnet policy json-args {} network-config testnet now`.

## Conventions

- The contract takes no hash, raw transaction, calldata, nonce or gas value from the agent; adding
  a field to `SpendRequest` (`types.rs`) needs the same scrutiny as invariant 2.
- Owner methods call `assert_owner` (1 yoctoNEAR, predecessor is the owner).
- Anything that loosens the policy must classify as `Loosen` in `policy.rs`; add a case to the
  `classify` tests and to `apps/web/src/lib/ops.ts`, which mirrors it for the dashboard preview.
- near-sdk is pinned to 5.29.1 because mainnet runs protocol 86; `tests/protocol.rs` guards it.

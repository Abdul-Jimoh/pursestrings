SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

CONTRACTS := pursestrings factory

.PHONY: all build test test-unit test-sandbox test-ts lint fmt demo demo-keep redteam verify check-live

all: lint test

build:
	@for c in $(CONTRACTS); do \
		cargo near build non-reproducible-wasm --manifest-path contracts/$$c/Cargo.toml --locked; \
	done

test: test-unit test-sandbox test-ts

test-unit:
	cargo test --workspace --lib --locked

test-sandbox:
	cargo test --workspace --test '*' --locked

test-ts:
	pnpm typecheck
	pnpm test

lint:
	cargo fmt --all --check
	cargo clippy --workspace --all-targets --locked -- -D warnings
	pnpm lint

fmt:
	cargo fmt --all
	pnpm format

# Read-only, no keys: every transaction and account the docs link exists, and the live accounts
# have no full-access key and run the code the README names.
check-live:
	@node scripts/check-live.mjs

demo:
	@scripts/with-devnet.sh demo

# No chain, cargo-near or local node: the contract's tests, the services' tests and a recording of the demo.
verify:
	@scripts/verify.sh

demo-keep:
	@scripts/with-devnet.sh demo --keep

redteam:
	@scripts/with-devnet.sh redteam

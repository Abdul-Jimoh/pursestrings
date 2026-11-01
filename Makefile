SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

CONTRACTS := pursestrings factory

.PHONY: all build test test-unit test-sandbox test-ts lint fmt demo demo-keep redteam

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

demo:
	@scripts/with-devnet.sh demo

demo-keep:
	@scripts/with-devnet.sh demo --keep

redteam:
	@scripts/with-devnet.sh redteam

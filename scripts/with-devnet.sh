#!/usr/bin/env bash
# Starts the local devnet, runs one of the agent app's scripts against it (demo, redteam), then
# stops the devnet. With --keep, the devnet stays up afterwards (Ctrl-C to stop).
set -euo pipefail
cd "$(dirname "$0")/.."
script=${1:?usage: with-devnet.sh <demo|redteam> [--keep]}

for tool in cargo node pnpm; do
  command -v "$tool" >/dev/null || { echo "make $script needs $tool on PATH (see README)" >&2; exit 1; }
done

pnpm install --frozen-lockfile --silent
rm -f .devnet/devnet.json
cargo run -q --locked -p devnet &
devnet=$!
trap 'kill -INT "$devnet" 2>/dev/null || true; wait "$devnet" 2>/dev/null || true' EXIT

until [[ -f .devnet/devnet.json ]]; do
  kill -0 "$devnet" 2>/dev/null || { echo "devnet failed to start" >&2; exit 1; }
  sleep 1
done

pnpm --silent --filter @pursestrings/agent "$script"

if [[ ${2:-} == --keep ]]; then
  echo "devnet still running; details in .devnet/devnet.json (Ctrl-C to stop)"
  wait "$devnet"
fi

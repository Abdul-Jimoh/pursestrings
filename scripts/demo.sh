#!/usr/bin/env bash
# Starts the local devnet, runs the scripted demo agent against it, then stops the devnet.
# With --keep, the devnet stays up afterwards (Ctrl-C to stop).
set -euo pipefail
cd "$(dirname "$0")/.."

for tool in cargo node pnpm; do
  command -v "$tool" >/dev/null || { echo "make demo needs $tool on PATH (see README)" >&2; exit 1; }
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

pnpm --silent --filter @pursestrings/agent demo

if [[ ${1:-} == --keep ]]; then
  echo "devnet still running; details in .devnet/devnet.json (Ctrl-C to stop)"
  wait "$devnet"
fi

import { type Config, relayOnce } from "./relayer.ts";

function config(): Config {
  const account = process.env.PURSESTRINGS_ACCOUNT;
  if (!account) throw new Error("set PURSESTRINGS_ACCOUNT");
  const evmRpc: Record<number, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const m = /^EVM_RPC_(\d+)$/.exec(key);
    if (m?.[1] && value) evmRpc[Number(m[1])] = value;
  }
  return { nearRpc: process.env.NEAR_RPC ?? "https://rpc.testnet.near.org", account, evmRpc };
}

const cfg = config();
const intervalMs = Number(process.env.INTERVAL_MS ?? 10_000);
const once = process.argv.includes("--once");

do {
  for (const report of await relayOnce(cfg)) {
    console.log(JSON.stringify(report));
  }
  if (!once) await new Promise((r) => setTimeout(r, intervalMs));
} while (!once);

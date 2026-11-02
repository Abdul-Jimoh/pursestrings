import { readFileSync } from "node:fs";
import { Pursestrings } from "@pursestrings/sdk";
import { type Config, relayOnce, settleSwaps } from "./relayer.ts";

/**
 * PURSESTRINGS_ACCOUNT, EVM_RPC_<chain id>, NEAR_RPC. To also settle requests, NEAR_SIGNER_ACCOUNT
 * and NEAR_SIGNER_KEY_FILE (a near-cli credentials JSON): that account pays gas and 1 yocto per
 * proof, and can't make the contract accept anything the MPC network or intents.near won't.
 */
function config(): Config {
  const account = process.env.PURSESTRINGS_ACCOUNT;
  if (!account) throw new Error("set PURSESTRINGS_ACCOUNT");
  const evmRpc: Record<number, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const m = /^EVM_RPC_(\d+)$/.exec(key);
    if (m?.[1] && value) evmRpc[Number(m[1])] = value;
  }
  const nearRpc = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
  const cfg: Config = { nearRpc, account, evmRpc };
  const signer = process.env.NEAR_SIGNER_ACCOUNT;
  const keyFile = process.env.NEAR_SIGNER_KEY_FILE;
  if (signer && keyFile) {
    const key = JSON.parse(readFileSync(keyFile, "utf8")).private_key as string;
    const caller = new Pursestrings(nearRpc, account).caller(signer, key);
    cfg.prover = {
      confirm: (id) => caller.confirmEvm(id),
      release: (id) => caller.releaseEvm(id),
      settle: (id) => caller.settleIntent(id),
      marginS: Number(process.env.PROOF_MARGIN_S ?? 600),
    };
  }
  return cfg;
}

const cfg = config();
const intervalMs = Number(process.env.INTERVAL_MS ?? 10_000);
const once = process.argv.includes("--once");

do {
  for (const report of await relayOnce(cfg)) console.log(JSON.stringify(report));
  for (const settled of await settleSwaps(cfg)) console.log(JSON.stringify({ settled }));
  if (!once) await new Promise((r) => setTimeout(r, intervalMs));
} while (!once);

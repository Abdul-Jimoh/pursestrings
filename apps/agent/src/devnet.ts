import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Devnet {
  rpc: string;
  genesis_secret_key: string;
  agent_secret_key: string;
  shop_agent_secret_key: string;
  board_agent_secret_key: string;
  accounts: Record<
    | "owner"
    | "purse"
    | "factory"
    | "mpc"
    | "intents"
    | "usdc"
    | "wrap"
    | "shop"
    | "solver"
    | "attacker"
    | "checks"
    | "dao"
    | "bounties"
    | "council"
    | "steward"
    | "buyer"
    | "newcomer",
    string
  >;
  evm: { chain_id: number; usdc: string; merchant: string; derived_public_key: string };
  code_hash: string;
}

/** Written by `cargo run -p devnet` (`make demo` starts it). */
export function loadDevnet(root = join(import.meta.dirname, "../../..")): Devnet {
  return JSON.parse(readFileSync(join(root, ".devnet/devnet.json"), "utf8")) as Devnet;
}

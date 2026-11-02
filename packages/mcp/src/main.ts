#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Pursestrings } from "@pursestrings/sdk";
import { createServer } from "./server.ts";

/**
 * PURSESTRINGS_RPC, PURSESTRINGS_ACCOUNT and PURSESTRINGS_AGENT_KEY (the agent's function-call
 * key), or PURSESTRINGS_DEVNET pointing at the `.devnet/devnet.json` that `make demo-keep` writes.
 */
function config() {
  const devnet = process.env.PURSESTRINGS_DEVNET;
  if (devnet) {
    const d = JSON.parse(readFileSync(devnet, "utf8"));
    return { rpc: d.rpc, account: d.accounts.purse, key: d.agent_secret_key };
  }
  const {
    PURSESTRINGS_RPC: rpc,
    PURSESTRINGS_ACCOUNT: account,
    PURSESTRINGS_AGENT_KEY: key,
  } = process.env;
  if (!rpc || !account || !key) {
    throw new Error("set PURSESTRINGS_RPC, PURSESTRINGS_ACCOUNT and PURSESTRINGS_AGENT_KEY");
  }
  return { rpc, account, key };
}

const { rpc, account, key } = config();
const purse = new Pursestrings(rpc, account);
await createServer({ purse, agent: purse.agent(key) }).connect(new StdioServerTransport());

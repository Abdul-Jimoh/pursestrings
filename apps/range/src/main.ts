import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "@pursestrings/mcp";
import { Pursestrings } from "@pursestrings/sdk";
import { JsonRpcProvider } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { Limits } from "./limits.ts";
import { openAiCompatible } from "./model.ts";
import { rangeServer } from "./server.ts";
import { Store } from "./store.ts";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

const env = (name: string, fallback: string) => process.env[name] ?? fallback;

const rpc = env("NEAR_RPC", "https://rpc.testnet.near.org");
const account = need("RANGE_ACCOUNT");
// A hosted deploy passes the key itself as a secret; locally it's read from the credentials file.
const agentKey =
  process.env.RANGE_AGENT_KEY ??
  JSON.parse(readFileSync(need("RANGE_AGENT_KEY_FILE"), "utf8")).private_key;
const purse = new Pursestrings(rpc, account);

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const tools = new Client({ name: "range", version: "0.1.0" });
await Promise.all([
  createServer({ purse, agent: purse.agent(agentKey) }).connect(serverSide),
  tools.connect(clientSide),
]);

const pricing = {
  inPerM: Number(env("RANGE_PRICE_IN", "0.10")),
  outPerM: Number(env("RANGE_PRICE_OUT", "0.50")),
};
const limits = new Limits({
  dailyUsd: Number(env("RANGE_DAILY_USD", "0.3")),
  perHour: Number(env("RANGE_PER_HOUR", "5")),
});
const store = new Store(env("RANGE_DATA", join(import.meta.dirname, "../data/attacks.jsonl")));
for (const e of store.all()) limits.record(e.account, e.costUsd, e.at);

const provider = new JsonRpcProvider({ url: rpc });
const server = rangeServer({
  model: openAiCompatible({
    baseUrl: env("RANGE_MODEL_URL", "https://cloud-api.near.ai/v1"),
    apiKey: need("RANGE_MODEL_KEY"),
    model: env("RANGE_MODEL", "anthropic/claude-haiku-5-5"),
    maxTokens: 600,
  }),
  tools,
  limits,
  store,
  pricing,
  ours: need("RANGE_OURS").split(","),
  verify: (s, message) =>
    verifyMessage({
      signerAccountId: s.accountId,
      signerPublicKey: s.publicKey,
      payload: { message, recipient: "pursestrings.site", nonce: Buffer.from(s.nonce, "base64") },
      signature: Buffer.from(s.signature, "base64"),
      provider,
    }),
  target: { account, explorer: `https://testnet.nearblocks.io/address/${account}` },
  publicDir: join(import.meta.dirname, "../public"),
  ...(process.env.RANGE_ORIGIN ? { origins: process.env.RANGE_ORIGIN.split(",") } : {}),
});

const port = Number(env("RANGE_PORT", "8787"));
server.listen(port, () => console.log(`range on http://localhost:${port} guarding ${account}`));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, parseDecimals } from "@pursestrings/mcp";
import { relayOnce } from "@pursestrings/relayer";
import { Pursestrings } from "@pursestrings/sdk";
import {
  Attempts,
  boardRoutes,
  Costs,
  metered,
  Reports,
  Reviews,
  type Route,
  shopRoutes,
  Trials,
} from "@pursestrings/shop";
import { JsonRpcProvider } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { cost, Limits } from "./limits.ts";
import { openAiCompatible } from "./model.ts";
import { rangeServer } from "./server.ts";
import { Store } from "./store.ts";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

const env = (name: string, fallback: string) => process.env[name] ?? fallback;

const rpc = env("NEAR_RPC", "https://test.rpc.fastnear.com");
const account = need("RANGE_ACCOUNT");
// A hosted deploy passes the key itself as a secret; locally it's read from the credentials file.
const agentKey =
  process.env.RANGE_AGENT_KEY ??
  JSON.parse(readFileSync(need("RANGE_AGENT_KEY_FILE"), "utf8")).private_key;
const purse = new Pursestrings(rpc, account);

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const tools = new Client({ name: "range", version: "0.1.0" });
await Promise.all([
  createServer({
    purse,
    agent: purse.agent(agentKey),
    // Base Sepolia USDC; the contract stores raw amounts and can't know a token's decimals.
    decimals: parseDecimals(env("RANGE_DECIMALS", "0x036cbd53842c5426634e7929541ec2318f3dcf7e:6")),
  }).connect(serverSide),
  tools.connect(clientSide),
]);

const pricing = {
  inPerM: Number(env("RANGE_PRICE_IN", "0.10")),
  outPerM: Number(env("RANGE_PRICE_OUT", "0.50")),
};
const limits = new Limits({
  dailyUsd: Number(env("RANGE_DAILY_USD", "0.3")),
  perHour: Number(env("RANGE_PER_HOUR", "5")),
  perAccountUsd: Number(env("RANGE_ACCOUNT_DAILY_USD", "0.1")),
});
const store = new Store(env("RANGE_DATA", join(import.meta.dirname, "../data/attacks.jsonl")));
for (const e of store.all()) limits.record(e.account, e.costUsd, e.at);

const model = openAiCompatible({
  baseUrl: env("RANGE_MODEL_URL", "https://cloud-api.near.ai/v1"),
  apiKey: need("RANGE_MODEL_KEY"),
  model: env("RANGE_MODEL", "anthropic/claude-haiku-5-5"),
  maxTokens: 1024,
});

// Names and addresses a check compares against for lookalikes.
const KNOWN = [
  "wrap.testnet",
  "usdc.fakes.testnet",
  "ps-spike-1028.testnet",
  "ps-community-1107.testnet",
  "shop.factory.ps-spike-1028.testnet",
  "bounties.factory.ps-spike-1028.testnet",
  "board.factory.ps-spike-1028.testnet",
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  "0x9d7ac751235b819991b3050d3f19e58a8e66ae03",
  "wrap.near",
  "intents.near",
  "usdt.tether-token.near",
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
];

const routes: Route[] = [];
const sources = {
  nearRpc: rpc,
  nearTx: env("NEAR_TX_API", "https://tx.test.fastnear.com"),
  blockscout: env("BLOCKSCOUT", "https://base-sepolia.blockscout.com"),
  known: env("SHOP_KNOWN", KNOWN.join(",")).split(","),
};
// Shop checks look real accounts up on mainnet; the board reviews testnet evidence on testnet.
const checkSources = {
  ...sources,
  mainnet: {
    nearRpc: env("NEAR_MAINNET_RPC", "https://free.rpc.fastnear.com"),
    nearTx: env("NEAR_MAINNET_TX_API", "https://tx.main.fastnear.com"),
    blockscout: "",
    evmRpc: env("BASE_MAINNET_RPC", "https://mainnet.base.org"),
  },
};
const boardAccount = process.env.BOARD_ACCOUNT;
const board = boardAccount ? new Pursestrings(rpc, boardAccount) : undefined;
const boardKey =
  process.env.BOARD_AGENT_KEY ??
  (process.env.BOARD_AGENT_KEY_FILE
    ? JSON.parse(readFileSync(process.env.BOARD_AGENT_KEY_FILE, "utf8")).private_key
    : undefined);
if (board && boardKey) {
  const { route, tick } = boardRoutes({
    board,
    agent: board.agent(boardKey),
    model,
    sources,
    // One log per board: a review is keyed by bounty id and text, which a new board repeats.
    reviews: new Reviews(
      env("BOARD_DATA", join(import.meta.dirname, "../data/reviews.jsonl")).replace(
        /\.jsonl$/,
        `-${boardAccount}.jsonl`,
      ),
    ),
  });
  routes.push(route);
  setInterval(() => tick().catch((e) => console.error("board:", e)), 10_000);
}

const shopAccount = process.env.SHOP_ACCOUNT;
if (shopAccount) {
  const shop = new Pursestrings(rpc, shopAccount);
  const shopKey =
    process.env.SHOP_AGENT_KEY ??
    JSON.parse(readFileSync(need("SHOP_AGENT_KEY_FILE"), "utf8")).private_key;
  const shopAgent = shop.agent(shopKey);
  const costsTo = process.env.SHOP_COSTS_TO;
  // "chain id:token:recipient": pay the model costs in USDC on that chain through Chain Signatures.
  const [evmChain, evmToken, evmTo] = (process.env.SHOP_COSTS_EVM ?? "").split(":");
  const costs = costsTo
    ? new Costs({
        agent: shopAgent,
        payee: costsTo,
        nearPerUsd: Number(env("SHOP_NEAR_PER_USD", "0.27")),
        // Paying a bill costs gas (and, on Base, an MPC signature), so the shop waits until it owes
        // enough to be worth a payment: a few cents, about 10-20 model calls.
        minYocto: 10n ** 22n,
        // Under the shop's co-sign threshold, so a payment never waits on the owner.
        maxYocto: 10n ** 23n,
        ...(evmChain && evmToken && evmTo
          ? {
              evm: {
                chainId: Number(evmChain),
                token: evmToken,
                to: evmTo,
                min: 25_000n,
                max: 1_000_000n,
              },
            }
          : {}),
      })
    : undefined;
  const { route, tick } = shopRoutes({
    shop,
    agent: shopAgent,
    model: costs ? metered(model, (u) => costs.add(cost(u, pricing))) : model,
    ...(costs ? { costs } : {}),
    reports: new Reports(env("SHOP_DATA", join(import.meta.dirname, "../data/reports.jsonl"))),
    attempts: new Attempts(
      env("SHOP_RANGE_DATA", join(import.meta.dirname, "../data/shop-range.jsonl")),
    ),
    sources: checkSources,
    ...(board ? { board } : {}),
    // "Try it without a wallet": a demo buyer this server holds, capped per day.
    ...(process.env.TRY_BUYER_ACCOUNT && process.env.TRY_BUYER_KEY
      ? {
          trial: {
            account: process.env.TRY_BUYER_ACCOUNT,
            buyer: shop.caller(process.env.TRY_BUYER_ACCOUNT, process.env.TRY_BUYER_KEY),
            trials: new Trials(Number(env("SHOP_TRY_PER_DAY", "20"))),
          },
        }
      : {}),
    // A chat message is much smaller than a Range attempt, so chats get their own hourly limit;
    // the daily model budget is still shared.
    allow: (account) =>
      limits.check(`chat:${account}`, Number(env("SHOP_CHAT_PER_HOUR", "30")), "messages"),
    record: (account, usage) => limits.record(`chat:${account}`, cost(usage, pricing)),
  });
  routes.push(route);
  setInterval(() => tick().catch((e) => console.error("shop:", e)), 5_000);

  // Broadcasts what the shop's contract has signed for other chains. It holds no keys; anyone
  // can do this, and anyone can later prove the payment settled.
  const evmRpc: Record<number, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^EVM_RPC_(\d+)$/.exec(k);
    if (m?.[1] && v) evmRpc[Number(m[1])] = v;
  }
  // With a signer, it also proves each payment once Base has finalized it, so the request ends
  // Done and its budget is no longer held. That account only pays gas and 1 yocto per proof; the
  // contract accepts a proof only if the MPC network can see the transaction settled.
  const proverAccount = process.env.PROVER_ACCOUNT;
  const proverKey = process.env.PROVER_KEY;
  const caller =
    proverAccount && proverKey
      ? new Pursestrings(rpc, shopAccount).caller(proverAccount, proverKey)
      : undefined;
  if (Object.keys(evmRpc).length) {
    const relay = () =>
      relayOnce({
        nearRpc: rpc,
        account: shopAccount,
        evmRpc,
        ...(caller
          ? {
              prover: {
                confirm: (id: number) => caller.confirmEvm(id),
                release: (id: number) => caller.releaseEvm(id),
                settle: (id: number) => caller.settleIntent(id),
                marginS: 600,
              },
            }
          : {}),
      })
        .then((reports) => {
          // Waiting for finality is the normal state: log only what changed.
          for (const r of reports.filter(
            (x) => x.sent === "sent" || (x.proof && x.proof !== "not yet"),
          ))
            console.log(`relay: ${JSON.stringify(r)}`);
        })
        .catch((e) => console.error("relay:", e));
    setInterval(relay, 30_000);
  }
}

const provider = new JsonRpcProvider({ url: rpc });
const server = rangeServer({
  model,
  routes,
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

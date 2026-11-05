import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type Agent,
  type Asset,
  type Decision,
  type DenyReason,
  describeDecision,
  explainDenial,
  type Pursestrings,
  type SpendRequest,
} from "@pursestrings/sdk";
import { z } from "zod";
import { type Decimals, withWhole } from "./units.ts";

export { parseDecimals } from "./units.ts";

const asset = z
  .union([
    z.literal("Near"),
    // Models often JSON-encode "Near" a second time; it's normalised before the contract sees it.
    z.literal('"Near"'),
    z.object({ Nep141: z.object({ token: z.string() }) }),
    z.object({ Evm: z.object({ chain_id: z.number().int(), token: z.string().nullable() }) }),
    z.object({ Intents: z.object({ token: z.string() }) }),
  ])
  .describe(
    'Native NEAR is the bare string "Near". A NEP-141 token is {"Nep141":{"token":"usdc.testnet"}}; an EVM token is {"Evm":{"chain_id":84532,"token":"0x…"}}, with token null for the chain\'s own coin.',
  );

const dest = z.union([
  z.object({ Near: z.object({ account: z.string() }) }),
  z.object({ Evm: z.object({ chain_id: z.number().int(), to: z.string() }) }),
  z.object({
    Intent: z.union([
      z.object({ Transfer: z.object({ receiver: z.string() }) }),
      z.object({ Swap: z.object({ buy: z.string(), min_out: z.string() }) }),
      z.object({ Withdraw: z.object({ receiver: z.string(), memo: z.string().nullable() }) }),
    ]),
  }),
]);

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/** What the server needs: reads from the account and the agent's one write. */
export interface Wallet {
  purse: Pursestrings;
  agent: Pick<Agent, "requestSpend">;
  /** Token decimals by contract or address; NEAR (24) and EVM native coins (18) are built in. */
  decimals?: Decimals;
}

/**
 * The agent's whole interface to money. It can ask, read and understand; it can't sign, move
 * funds or change the policy, because its key can only call `request_spend` and
 * `cancel_request`, and the contract decides.
 */
export function createServer({ purse, agent, decimals = {} }: Wallet): McpServer {
  const server = new McpServer({ name: "pursestrings", version: "0.1.0" });

  server.registerTool(
    "request_spend",
    {
      description:
        "Ask the account's on-chain policy to make a payment. Amounts are integers in the asset's smallest unit (USDC: 6 decimals). Use a new idempotency_key per payment and reuse it when retrying the same one. The answer is approved, waiting for the owner, or denied with a reason.",
      inputSchema: {
        asset,
        amount: z.string().regex(/^\d+$/),
        dest,
        purpose: z.string().max(256),
        idempotency_key: z.string().min(1).max(64),
      },
    },
    async (args) => {
      const spend = { ...args, asset: args.asset === '"Near"' ? "Near" : args.asset };
      const res = await agent.requestSpend(spend as SpendRequest);
      if (!res.value) return { ...text(`rejected before a decision: ${res.error}`), isError: true };
      return text(
        `${describeDecision(res.value as Decision)}\n${JSON.stringify(res.value)}\nnear tx: ${res.txHash}`,
      );
    },
  );

  server.registerTool(
    "budget_status",
    {
      description:
        "What's left to spend: each asset's per-payment cap and windows, each shared budget group (one budget across chains), and the fee budget. *_whole fields give amounts in whole tokens.",
    },
    async () => {
      const policy = (await purse.policy()) as {
        assets: { asset: Asset }[];
        groups: { name: string }[];
      };
      const assets = await Promise.all(
        policy.assets.map(async (r) => {
          const b = await purse.budgetStatus(r.asset);
          return b && withWhole(b, decimals);
        }),
      );
      const groups = await Promise.all(
        policy.groups.map(async (g) => ({
          group: g.name,
          windows: await purse.groupStatus(g.name),
        })),
      );
      return text(JSON.stringify({ assets, groups, fees: await purse.feeStatus() }, null, 2));
    },
  );

  server.registerTool(
    "spending_policy",
    {
      description:
        "The owner's policy: which assets, recipients, chains and swap pairs are allowed, the limits, and whether the account is frozen. Raw amounts are in the smallest unit; *_whole fields give the same amounts in whole tokens. Read it before planning a payment.",
    },
    async () => {
      const policy = (await purse.policy()) as { assets: { asset: Asset }[] };
      const assets = policy.assets.map((r) => withWhole(r, decimals));
      return text(JSON.stringify({ ...policy, assets }, null, 2));
    },
  );

  server.registerTool(
    "request_status",
    {
      description: "Where a request stands: pending, executing, signed, done, failed, and so on.",
      inputSchema: { req_id: z.number().int().nonnegative() },
    },
    async ({ req_id }) => {
      const req = await purse.request(req_id);
      return req
        ? text(JSON.stringify(req, null, 2))
        : { ...text("no such request"), isError: true };
    },
  );

  server.registerTool(
    "explain_denial",
    {
      description: "Turns a denial reason from request_spend into a sentence you can act on.",
      inputSchema: { reason: z.unknown() },
    },
    async ({ reason }) => text(explainDenial(reason as DenyReason)),
  );

  return server;
}

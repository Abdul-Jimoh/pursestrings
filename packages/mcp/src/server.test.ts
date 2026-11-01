import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Pursestrings, SpendRequest } from "@pursestrings/sdk";
import { describe, expect, it } from "vitest";
import { createServer } from "./server.ts";

async function connect(decision: unknown, seen: SpendRequest[] = []) {
  const purse = {
    policy: async () => ({ assets: [], groups: [] }),
    feeStatus: async () => ({}),
  } as unknown as Pursestrings;
  const agent = {
    requestSpend: async (r: SpendRequest) => {
      seen.push(r);
      return { ok: true, value: decision, logs: [], txHash: "h" };
    },
  };
  const server = createServer({ purse, agent } as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const pay = {
  asset: { Nep141: { token: "usdc.near" } },
  amount: "20000000",
  dest: { Near: { account: "shop.near" } },
  purpose: "data feed",
  idempotency_key: "k1",
};

describe("mcp server", () => {
  it("offers exactly the agent's tools", async () => {
    const client = await connect({ Approved: { req_id: 0 } });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "budget_status",
      "explain_denial",
      "request_spend",
      "request_status",
      "spending_policy",
    ]);
  });

  it("passes requests through and explains denials", async () => {
    const seen: SpendRequest[] = [];
    const client = await connect({ Denied: { reason: "RecipientNotAllowed" } }, seen);
    const res = await client.callTool({ name: "request_spend", arguments: pay });
    expect(seen).toEqual([pay]);
    expect(JSON.stringify(res.content)).toContain("isn't on the owner's allowlist");
  });

  it("refuses fields the contract would never sign", async () => {
    const seen: SpendRequest[] = [];
    const client = await connect({ Approved: { req_id: 0 } }, seen);
    const res = await client.callTool({
      name: "request_spend",
      arguments: { ...pay, amount: "1.5" },
    });
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
  });
});

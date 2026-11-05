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

  it('unwraps a double-encoded "Near", the one shape models keep sending', async () => {
    const seen: SpendRequest[] = [];
    const client = await connect({ Approved: { req_id: 0 } }, seen);
    await client.callTool({ name: "request_spend", arguments: { ...pay, asset: '"Near"' } });
    expect(seen).toEqual([{ ...pay, asset: "Near" }]);
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

describe("whole units", () => {
  it("puts whole-token amounts beside raw ones in the policy", async () => {
    const usdc = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
    const purse = {
      policy: async () => ({
        assets: [
          {
            asset: "Near",
            per_tx_cap: "500000000000000000000000",
            windows: [{ period_s: 86400, limit: "2000000000000000000000000" }],
            cosign_above: "300000000000000000000000",
          },
          { asset: { Evm: { chain_id: 84532, token: usdc } }, per_tx_cap: "50000000", windows: [] },
          { asset: { Nep141: { token: "unknown.near" } }, per_tx_cap: "7", windows: [] },
        ],
        groups: [],
      }),
    } as unknown as Pursestrings;
    const server = createServer({ purse, agent: {} as never, decimals: { [usdc]: 6 } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = await client.callTool({ name: "spending_policy", arguments: {} });
    const [first] = res.content as { text: string }[];
    const { assets } = JSON.parse(first?.text ?? "{}");
    expect(assets[0].per_tx_cap_whole).toBe("0.5");
    expect(assets[0].cosign_above_whole).toBe("0.3");
    expect(assets[0].windows[0].limit_whole).toBe("2");
    expect(assets[1].per_tx_cap_whole).toBe("50");
    expect(assets[2].per_tx_cap_whole).toBeUndefined();
  });
});

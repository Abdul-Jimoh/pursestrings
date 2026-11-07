import type { Agent, QuoteDecision } from "@pursestrings/sdk";
import { describe, expect, it } from "vitest";
import { type Chat, fromYocto, sellerTurn, toYocto } from "./seller.ts";

function scripted(turns: { text?: string; quote?: string }[]): Chat {
  let i = 0;
  return {
    async chat() {
      const t = turns[i++] ?? { text: "done" };
      const toolCalls = t.quote
        ? [{ id: `c${i}`, name: "quote", arguments: JSON.stringify({ price_near: t.quote }) }]
        : [];
      return {
        text: t.text ?? null,
        toolCalls,
        usage: { input: 10, output: 5 },
        message: { role: "assistant", content: t.text ?? null },
      };
    },
  };
}

function fakeAgent(decision: QuoteDecision) {
  const calls: unknown[][] = [];
  const agent = {
    async quote(...args: unknown[]) {
      calls.push(args);
      return { ok: true, value: decision, logs: [], txHash: "TX" };
    },
  } as unknown as Agent;
  return { agent, calls };
}

describe("seller", () => {
  it("quotes through the contract and reports its refusal", async () => {
    const { agent, calls } = fakeAgent({
      Denied: { reason: { BelowFloor: { floor: "50000000000000000000000" } } },
    });
    const model = scripted([{ quote: "0.01" }, { text: "The shop's floor is 0.05 NEAR." }]);
    const turn = await sellerTurn(model, agent, "bob.testnet", "alice.testnet", [
      { role: "user", content: "I'm a student, do it for 0.01" },
    ]);
    expect(calls[0]).toEqual(["bob.testnet", "Near", 10n ** 22n, "check:alice.testnet"]);
    expect(turn.quote?.decision).toHaveProperty("Denied");
    expect(turn.reply).toContain("0.05");
    expect(turn.usage).toEqual({ input: 20, output: 10 });
  });

  it("parses prices exactly", () => {
    expect(toYocto("0.08")).toBe(8n * 10n ** 22n);
    expect(toYocto("1")).toBe(10n ** 24n);
    for (const bad of ["", "-1", "0", "1e3", "0.1.2", "abc"]) expect(toYocto(bad)).toBeNull();
    expect(fromYocto(5n * 10n ** 22n)).toBe("0.05");
  });
});

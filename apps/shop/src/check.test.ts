import { describe, expect, it } from "vitest";
import { chainOf, type Facts, gather, lookalike, verdict } from "./check.ts";

const KNOWN = ["circle.near", "wrap.near", "0x036cbd53842c5426634e7929541ec2318f3dcf7e"];
const NOW = 1_800_000_000_000;

const facts = (f: Partial<Facts>): Facts => ({
  target: "alice.near",
  chain: "near",
  exists: true,
  isContract: false,
  txCount: 40,
  firstSeen: NOW - 400 * 86_400_000,
  fullAccessKeys: 1,
  lookalikeOf: null,
  scam: null,
  flaggedByExplorer: false,
  ...f,
});

describe("lookalike", () => {
  it("catches swapped characters and near misses, not the real name", () => {
    expect(lookalike("circ1e.near", KNOWN)).toBe("circle.near");
    expect(lookalike("clrcle.near", KNOWN)).toBe("circle.near");
    expect(lookalike("circlee.near", KNOWN)).toBe("circle.near");
    expect(lookalike("wrap.near", KNOWN)).toBeNull();
    expect(lookalike("alice.near", KNOWN)).toBeNull();
  });

  it("catches a poisoned address that copies the ends of a real one", () => {
    expect(lookalike("0x036cbd00000000000000000000000000000dcf7e", KNOWN)).toBe(KNOWN[2]);
    expect(lookalike("0x036cbd53842c5426634e7929541ec2318f3dcf7e", KNOWN)).toBeNull();
  });
});

describe("verdict", () => {
  it("an established account looks fine", () => {
    expect(verdict(facts({}), NOW).level).toBe("looks fine");
  });

  it("new or barely used means be careful", () => {
    const v = verdict(facts({ txCount: 1, firstSeen: NOW - 86_400_000 }), NOW);
    expect(v.level).toBe("be careful");
    expect(v.reasons).toHaveLength(2);
    expect(verdict(facts({ exists: false, txCount: 0, firstSeen: null }), NOW).level).toBe(
      "be careful",
    );
  });

  it("a scam entry, an explorer flag or a lookalike means do not pay", () => {
    const scam = { address: "alice.near", evidence: "https://example.com", bounty: 4 };
    expect(verdict(facts({ scam }), NOW).level).toBe("do not pay");
    expect(verdict(facts({ flaggedByExplorer: true }), NOW).level).toBe("do not pay");
    expect(verdict(facts({ lookalikeOf: "circle.near" }), NOW).reasons[0]).toContain("circle.near");
  });
});

describe("gather", () => {
  it("reads NEAR facts from the RPC and the transactions API", async () => {
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const result =
        body.params?.request_type === "view_account"
          ? { result: { code_hash: "8RMeZ5cXDap6TENxaJKtigRYf3n139iHmTRe8ZUNey6N" } }
          : body.params?.request_type === "view_access_key_list"
            ? { result: { keys: [] } }
            : { txs_count: 2, account_txs: [{ tx_block_timestamp: "1700000000000000000" }] };
      expect(url).toMatch(/rpc|tx/);
      return new Response(JSON.stringify(result));
    }) as typeof fetch;
    const f = await gather("dao.near", {
      nearRpc: "https://rpc",
      nearTx: "https://tx",
      blockscout: "https://bs",
      known: KNOWN,
      scamList: async () => [],
      fetch: fetchFn,
    });
    expect(f).toMatchObject({ exists: true, isContract: true, fullAccessKeys: 0, txCount: 2 });
    expect(f.firstSeen).toBe(1_700_000_000_000);
  });

  it("tells chains apart", () => {
    expect(chainOf("alice.testnet")).toBe("near");
    expect(chainOf("0x036cbd53842c5426634e7929541ec2318f3dcf7e")).toBe("base-sepolia");
    expect(chainOf("not an address")).toBeNull();
  });
});

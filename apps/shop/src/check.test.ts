import { describe, expect, it } from "vitest";
import { chainOf, type Facts, gather, lookalike, verdict } from "./check.ts";

const KNOWN = ["circle.near", "wrap.near", "0x036cbd53842c5426634e7929541ec2318f3dcf7e"];
const NOW = 1_800_000_000_000;

const facts = (f: Partial<Facts>): Facts => ({
  target: "alice.near",
  chain: "near",
  network: "NEAR testnet",
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
            : {
                txs_count: 2,
                account_txs: [
                  { tx_block_timestamp: "1750000000000000000" },
                  { tx_block_timestamp: "1700000000000000000" },
                ],
              };
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

  describe("with mainnet sources", () => {
    const net = (prefix: string) => ({
      nearRpc: `https://${prefix}-rpc`,
      nearTx: `https://${prefix}-tx`,
      blockscout: `https://${prefix}-bs`,
    });
    // Accounts in `live` exist on the network whose URLs carry that prefix.
    const sources = (live: Record<string, string[]>, seen: string[]) => ({
      ...net("test"),
      mainnet: { ...net("main"), evmRpc: "https://main-evm" },
      known: KNOWN,
      scamList: async () => [],
      fetch: (async (url: string, init?: RequestInit) => {
        seen.push(url);
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const prefix = url.slice(8, 12);
        if (url === "https://main-evm") {
          const has = (live.main ?? []).includes(body.params[0]);
          const result = {
            eth_getTransactionCount: has ? "0x5" : "0x0",
            eth_getCode: "0x",
            eth_getBalance: "0x0",
          }[body.method as string];
          return new Response(JSON.stringify({ result }));
        }
        const has = (live[prefix] ?? []).includes(body.params?.account_id ?? body.account_id);
        if (body.params?.request_type === "view_account")
          return new Response(
            JSON.stringify(
              has
                ? { result: { code_hash: "11111111111111111111111111111111" } }
                : { error: { cause: { name: "UNKNOWN_ACCOUNT" } } },
            ),
          );
        if (body.params?.request_type === "view_access_key_list")
          return new Response(JSON.stringify({ result: { keys: [] } }));
        if (url.endsWith("/v0/account"))
          return new Response(JSON.stringify({ txs_count: has ? 12 : 0, account_txs: [] }));
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    });

    it("finds a .near account on mainnet and says so", async () => {
      const seen: string[] = [];
      const f = await gather("ghost.near", sources({ main: ["ghost.near"] }, seen));
      expect(f).toMatchObject({ exists: true, network: "NEAR mainnet", txCount: 12 });
      expect(seen.some((u) => u.startsWith("https://test"))).toBe(false);
    });

    it("falls back to testnet when mainnet has never seen it", async () => {
      const f = await gather("abc123.near", sources({ test: ["abc123.near"] }, []));
      expect(f).toMatchObject({ exists: true, network: "NEAR testnet" });
    });

    it("never asks mainnet about a .testnet name", async () => {
      const seen: string[] = [];
      const f = await gather("bob.testnet", sources({ test: ["bob.testnet"] }, seen));
      expect(f.network).toBe("NEAR testnet");
      expect(seen.some((u) => u.startsWith("https://main"))).toBe(false);
    });

    it("names both networks when neither has it", async () => {
      const f = await gather("nobody.near", sources({}, []));
      expect(f.exists).toBe(false);
      expect(verdict(f, 0).reasons).toContain(
        "It has never been used on NEAR mainnet or NEAR testnet.",
      );
    });

    it("counts only sent transactions on Base mainnet and says so", async () => {
      const a = "0x00000000000000000000000000000000000000aa";
      const f = await gather(a, sources({ main: [a] }, []));
      expect(f).toMatchObject({ exists: true, chain: "base", network: "Base", txCount: 5 });
      const g = await gather("0x00000000000000000000000000000000000000bb", {
        ...sources({}, []),
        fetch: (async (url: string, init?: RequestInit) => {
          const body = JSON.parse((init?.body as string) ?? "{}");
          const result =
            url === "https://main-evm"
              ? { eth_getTransactionCount: "0x1", eth_getCode: "0x", eth_getBalance: "0x0" }[
                  body.method as string
                ]
              : undefined;
          return new Response(JSON.stringify({ result }));
        }) as typeof fetch,
      });
      expect(verdict(g, 0).reasons).toContain("It has sent only 1 transaction.");
    });

    it("doesn't take a busy account's latest page for its whole history", async () => {
      const base = sources({}, []);
      const f = await gather("busy.near", {
        ...base,
        fetch: (async (url: string, init?: RequestInit) => {
          if (url.endsWith("/v0/account"))
            return new Response(
              JSON.stringify({
                txs_count: 5000,
                account_txs: [{ tx_block_timestamp: `${BigInt(NOW) * 1_000_000n}` }],
              }),
            );
          if (url === "https://main-rpc")
            return new Response(
              JSON.stringify({
                result: { code_hash: "11111111111111111111111111111111", keys: [] },
              }),
            );
          return base.fetch(url, init);
        }) as typeof fetch,
      });
      expect(f).toMatchObject({ exists: true, txCount: 5000, firstSeen: null });
      expect(verdict(f, NOW).level).toBe("looks fine");
    });

    it("says it can't see a Base contract's history instead of counting its sends", () => {
      const f = facts({
        chain: "base",
        network: "Base",
        sentOnly: true,
        isContract: true,
        txCount: 1,
        firstSeen: null,
        fullAccessKeys: null,
      });
      expect(verdict(f, NOW)).toEqual({
        level: "be careful",
        reasons: ["It's a contract, and we can't see its history on Base."],
      });
    });

    it("uses testnet when the mainnet lookup fails", async () => {
      const base = sources({ test: ["carol.near"] }, []);
      const f = await gather("carol.near", {
        ...base,
        fetch: (async (url: string, init?: RequestInit) => {
          if (url.startsWith("https://main")) throw new Error("down");
          return base.fetch(url, init);
        }) as typeof fetch,
      });
      expect(f).toMatchObject({ exists: true, network: "NEAR testnet" });
    });
  });

  it("tells chains apart", () => {
    expect(chainOf("alice.testnet")).toBe("near");
    expect(chainOf("0x036cbd53842c5426634e7929541ec2318f3dcf7e")).toBe("base-sepolia");
    expect(chainOf("not an address")).toBeNull();
  });
});

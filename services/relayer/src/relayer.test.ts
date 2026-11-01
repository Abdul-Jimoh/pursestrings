import { describe, expect, it } from "vitest";
import { txHash } from "./evm.ts";
import { relayOnce } from "./relayer.ts";
import type { Fetch } from "./rpc.ts";

const RAW = "0x02f86b83014a3480";
const CANCEL = "0x02f86b83014a3481";

function fakeFetch(handlers: Record<string, (params: unknown) => unknown>): {
  fetch: Fetch;
  calls: { url: string; method: string; params: unknown }[];
} {
  const calls: { url: string; method: string; params: unknown }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    calls.push({ url, method, params });
    const handler = handlers[`${url} ${method}`];
    if (!handler) throw new Error(`unexpected ${url} ${method}`);
    try {
      return Response.json({ result: handler(params) });
    } catch (e) {
      return Response.json({ error: { message: (e as Error).message } });
    }
  }) as Fetch;
  return { fetch: fetchFn, calls };
}

function nearResult(value: unknown) {
  return { result: [...Buffer.from(JSON.stringify(value))] };
}

const cfg = { nearRpc: "near", account: "purse.testnet", evmRpc: { 84532: "base" } };

function open(evm: { raw_tx: string | null; cancel_tx: string | null }) {
  return [
    [
      7,
      {
        status: "Signed",
        spend: { asset: { Evm: { chain_id: 84532 } } },
        evm: { nonce: 3, ...evm },
      },
    ],
  ];
}

describe("relayOnce", () => {
  it("broadcasts signed transactions and reports receipts", async () => {
    const { fetch, calls } = fakeFetch({
      "near query": () => nearResult(open({ raw_tx: RAW, cancel_tx: null })),
      "base eth_sendRawTransaction": () => txHash(RAW),
      "base eth_getTransactionReceipt": () => ({ status: "0x1" }),
    });
    const reports = await relayOnce(cfg, fetch);
    expect(reports).toEqual([
      {
        req_id: 7,
        kind: "spend",
        chain_id: 84532,
        nonce: 3,
        hash: txHash(RAW),
        sent: "sent",
        receipt: "success",
      },
    ]);
    expect(calls.find((c) => c.method === "eth_sendRawTransaction")?.params).toEqual([RAW]);
  });

  it("sends the cancel too and classifies node errors", async () => {
    const { fetch } = fakeFetch({
      "near query": () => nearResult(open({ raw_tx: RAW, cancel_tx: CANCEL })),
      "base eth_sendRawTransaction": (params) => {
        throw new Error((params as string[])[0] === RAW ? "nonce too low" : "already known");
      },
      "base eth_getTransactionReceipt": () => null,
    });
    const reports = await relayOnce(cfg, fetch);
    expect(reports.map((r) => [r.kind, r.sent, r.receipt])).toEqual([
      ["spend", "stale", "pending"],
      ["cancel", "known", "pending"],
    ]);
  });

  it("skips chains it has no endpoint for", async () => {
    const { fetch, calls } = fakeFetch({
      "near query": () => nearResult(open({ raw_tx: RAW, cancel_tx: null })),
    });
    expect(await relayOnce({ ...cfg, evmRpc: {} }, fetch)).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("txHash", () => {
  it("is keccak256 of the raw bytes", () => {
    expect(txHash("0x")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });
});

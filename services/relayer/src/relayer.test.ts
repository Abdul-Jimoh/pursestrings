import { describe, expect, it } from "vitest";
import { txHash } from "./evm.ts";
import { type Prover, relayOnce, settleSwaps } from "./relayer.ts";
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
      "base eth_getTransactionReceipt": () => ({ status: "0x1", blockNumber: "0x64" }),
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

function prover(calls: string[], marginS = 600): Prover {
  const record =
    <T>(name: string, value: T) =>
    async (id: number) => {
      calls.push(`${name} ${id}`);
      return { ok: true, value };
    };
  return {
    confirm: record("confirm", true),
    release: record("release", true),
    settle: record("settle", "Done"),
    marginS,
  };
}

describe("proofs", () => {
  const chain = (finalized: number, finalizedTime: number) => ({
    "near query": () => nearResult(open({ raw_tx: RAW, cancel_tx: null })),
    "base eth_sendRawTransaction": () => {
      throw new Error("already known");
    },
    "base eth_getTransactionReceipt": () => ({ status: "0x1", blockNumber: "0x64" }),
    "base eth_getBlockByNumber": (params: unknown) => {
      const [tag] = params as [string];
      return tag === "finalized"
        ? { number: `0x${finalized.toString(16)}`, timestamp: `0x${finalizedTime.toString(16)}` }
        : { number: "0x64", timestamp: "0x3e8" };
    },
  });

  it("waits until the finalized head is well past the block", async () => {
    const calls: string[] = [];
    const early = fakeFetch(chain(99, 5_000)).fetch;
    expect((await relayOnce({ ...cfg, prover: prover(calls) }, early))[0]?.proof).toBe("not yet");
    const shallow = fakeFetch(chain(150, 1_000 + 300)).fetch;
    expect((await relayOnce({ ...cfg, prover: prover(calls) }, shallow))[0]?.proof).toBe("not yet");
    expect(calls).toEqual([]);
  });

  it("asks the contract to confirm once the MPC network can see it", async () => {
    const calls: string[] = [];
    const ready = fakeFetch(chain(500, 1_000 + 700)).fetch;
    const [report] = await relayOnce({ ...cfg, prover: prover(calls) }, ready);
    expect(report?.proof).toBe("confirmed");
    expect(calls).toEqual(["confirm 7"]);
  });

  it("settles only swaps past their deadline", async () => {
    const calls: string[] = [];
    const { fetch } = fakeFetch({
      "near query": () =>
        nearResult([
          [1, { intent: { deadline_ns: 100 } }],
          [2, { intent: { deadline_ns: 900 } }],
        ]),
    });
    const settled = await settleSwaps({ ...cfg, prover: prover(calls) }, 500, fetch);
    expect(settled).toEqual([{ req_id: 1, status: "Done" }]);
    expect(calls).toEqual(["settle 1"]);
  });
});

describe("txHash", () => {
  it("is keccak256 of the raw bytes", () => {
    expect(txHash("0x")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });
});

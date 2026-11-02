import { describe, expect, it } from "vitest";
import { openSwaps, publishSwap, requestQuote } from "./intents.ts";
import type { Fetch } from "./rpc.ts";

interface Call {
  url: string;
  method: string;
  params: unknown;
  headers: Record<string, string>;
}

function fakeFetch(handlers: Record<string, (params: unknown) => unknown>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    calls.push({ url, method, params, headers: init?.headers as Record<string, string> });
    const handler = handlers[`${url} ${method}`];
    if (!handler) throw new Error(`unexpected ${url} ${method}`);
    return Response.json({ result: handler(params) });
  }) as Fetch;
  return { fetch: fetchFn, calls };
}

function nearResult(value: unknown) {
  return { result: [...Buffer.from(JSON.stringify(value))] };
}

const relay = { url: "relay", apiKey: "jwt" };
const KEY = "ed25519:E3QUgiS1wcMR5PCuBKjaGHcTSN137t6c8645s6bN4fq7";

describe("solver relay", () => {
  it("asks for an exact-input quote with the API key", async () => {
    const { fetch, calls } = fakeFetch({ "relay quote": () => [] });
    await requestQuote(relay, "nep141:wrap.near", "nep141:usdc.near", "100", fetch);
    expect(calls[0]?.params).toEqual([
      {
        defuse_asset_identifier_in: "nep141:wrap.near",
        defuse_asset_identifier_out: "nep141:usdc.near",
        exact_amount_in: "100",
        min_deadline_ms: 20_000,
      },
    ]);
    expect(calls[0]?.headers["X-API-Key"]).toBe("jwt");
  });

  it("publishes signed swaps exactly as the contract stored them", async () => {
    const payload = '{"signer_id":"purse.near"}';
    const { fetch, calls } = fakeFetch({
      "near query": (params) => {
        const method = (params as { method_name: string }).method_name;
        if (method === "intents_key") return nearResult(KEY);
        return nearResult([
          [3, { status: "Signed", intent: { payload, signature: "ed25519:sig", deadline_ns: 9 } }],
          [4, { status: "SigningFailed", intent: { payload, signature: null, deadline_ns: 9 } }],
        ]);
      },
      "relay publish_intent": () => ({ status: "OK", intent_hash: "h" }),
    });
    const swaps = await openSwaps("near", "purse.near", fetch);
    expect(swaps).toEqual([
      {
        req_id: 3,
        deadline_ns: 9,
        entry: { standard: "raw_ed25519", payload, public_key: KEY, signature: "ed25519:sig" },
      },
    ]);
    const swap = swaps[0];
    if (!swap) throw new Error("no swap");
    expect(await publishSwap(relay, "q1", swap.entry, fetch)).toEqual({
      status: "OK",
      intent_hash: "h",
    });
    expect(calls.at(-1)?.params).toEqual([{ quote_hashes: ["q1"], signed_data: swap.entry }]);
  });

  it("has nothing to publish before the key is registered", async () => {
    const { fetch, calls } = fakeFetch({ "near query": () => nearResult(null) });
    expect(await openSwaps("near", "purse.near", fetch)).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

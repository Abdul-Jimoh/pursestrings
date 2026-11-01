import { type Fetch, jsonRpc, nearView } from "./rpc.ts";

export const SOLVER_RELAY = "https://solver-relay-v2.chaindefuser.com/rpc";

/** The solver relay needs a JWT from the NEAR Intents Partner Portal in `X-API-Key`. */
export interface RelayConfig {
  url: string;
  apiKey: string;
}

export interface Quote {
  quote_hash: string;
  defuse_asset_identifier_in: string;
  defuse_asset_identifier_out: string;
  amount_in: string;
  amount_out: string;
  expiration_time: string;
}

export interface SignedEntry {
  standard: "raw_ed25519";
  payload: string;
  public_key: string;
  signature: string;
}

export interface PublishResult {
  status: "OK" | "FAILED";
  reason?: string;
  intent_hash: string;
}

export interface SwapStatus {
  intent_hash: string;
  status: "PENDING" | "TX_BROADCASTED" | "SETTLED" | "NOT_FOUND_OR_NOT_VALID";
  status_details?: string;
  data?: { hash?: string };
}

interface Request {
  status: string;
  intent: { payload: string; signature: string | null; deadline_ns: number } | null;
}

export interface OpenSwap {
  req_id: number;
  entry: SignedEntry;
  deadline_ns: number;
}

function relayCall<T>(relay: RelayConfig, method: string, params: unknown, fetchFn: Fetch) {
  return jsonRpc<T>(relay.url, method, [params], fetchFn, { "X-API-Key": relay.apiKey });
}

/**
 * Quotes for selling exactly `amountIn`. A swap request must use a quote's `amount_out` as its
 * `min_out`: the contract signs that exact diff, and the solver's side has to net against it.
 */
export function requestQuote(
  relay: RelayConfig,
  sell: string,
  buy: string,
  amountIn: string,
  fetchFn: Fetch = fetch,
): Promise<Quote[]> {
  return relayCall<Quote[]>(
    relay,
    "quote",
    {
      defuse_asset_identifier_in: sell,
      defuse_asset_identifier_out: buy,
      exact_amount_in: amountIn,
      min_deadline_ms: 60_000,
    },
    fetchFn,
  );
}

/** Signed swaps the account hasn't settled, in the form `execute_intents` and the relay take. */
export async function openSwaps(
  nearRpc: string,
  account: string,
  fetchFn: Fetch = fetch,
): Promise<OpenSwap[]> {
  const key = await nearView<string | null>(nearRpc, account, "intents_key", {}, fetchFn);
  if (!key) return [];
  const open = await nearView<[number, Request][]>(nearRpc, account, "intents_open", {}, fetchFn);
  const swaps: OpenSwap[] = [];
  for (const [reqId, req] of open) {
    if (req.status !== "Signed" || !req.intent?.signature) continue;
    swaps.push({
      req_id: reqId,
      deadline_ns: req.intent.deadline_ns,
      entry: {
        standard: "raw_ed25519",
        payload: req.intent.payload,
        public_key: key,
        signature: req.intent.signature,
      },
    });
  }
  return swaps;
}

export function publishSwap(
  relay: RelayConfig,
  quoteHash: string,
  entry: SignedEntry,
  fetchFn: Fetch = fetch,
): Promise<PublishResult> {
  return relayCall<PublishResult>(
    relay,
    "publish_intent",
    { quote_hashes: [quoteHash], signed_data: entry },
    fetchFn,
  );
}

export function swapStatus(
  relay: RelayConfig,
  intentHash: string,
  fetchFn: Fetch = fetch,
): Promise<SwapStatus> {
  return relayCall<SwapStatus>(relay, "get_status", { intent_hash: intentHash }, fetchFn);
}

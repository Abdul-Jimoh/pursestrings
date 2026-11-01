import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { type Fetch, jsonRpc, RpcError } from "./rpc.ts";

export function txHash(raw: string): string {
  return `0x${bytesToHex(keccak_256(hexToBytes(raw.replace(/^0x/, ""))))}`;
}

/** `stale`: the nonce is already used, by this transaction or the other one at that nonce. */
export type SendOutcome = "sent" | "known" | "stale" | "underpriced" | "error";

export async function sendRaw(
  rpc: string,
  raw: string,
  fetchFn: Fetch = fetch,
): Promise<{ hash: string; outcome: SendOutcome; error?: string }> {
  const hash = txHash(raw);
  try {
    await jsonRpc<string>(rpc, "eth_sendRawTransaction", [raw], fetchFn);
    return { hash, outcome: "sent" };
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    const msg = e.message.toLowerCase();
    const outcome: SendOutcome =
      msg.includes("already known") || msg.includes("known transaction")
        ? "known"
        : msg.includes("nonce too low")
          ? "stale"
          : msg.includes("underpriced")
            ? "underpriced"
            : "error";
    return { hash, outcome, error: e.message };
  }
}

export type ReceiptStatus = "pending" | "success" | "reverted";

export async function receiptStatus(
  rpc: string,
  hash: string,
  fetchFn: Fetch = fetch,
): Promise<ReceiptStatus> {
  const r = await jsonRpc<{ status: string } | null>(
    rpc,
    "eth_getTransactionReceipt",
    [hash],
    fetchFn,
  );
  if (!r) return "pending";
  return r.status === "0x1" ? "success" : "reverted";
}

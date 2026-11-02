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

export async function receipt(
  rpc: string,
  hash: string,
  fetchFn: Fetch = fetch,
): Promise<{ status: ReceiptStatus; block?: number }> {
  const r = await jsonRpc<{ status: string; blockNumber: string } | null>(
    rpc,
    "eth_getTransactionReceipt",
    [hash],
    fetchFn,
  );
  if (!r) return { status: "pending" };
  return { status: r.status === "0x1" ? "success" : "reverted", block: Number(r.blockNumber) };
}

async function blockTime(rpc: string, tag: string, fetchFn: Fetch) {
  const b = await jsonRpc<{ number: string; timestamp: string } | null>(
    rpc,
    "eth_getBlockByNumber",
    [tag, false],
    fetchFn,
  );
  return b ? { number: Number(b.number), time: Number(b.timestamp) } : undefined;
}

/**
 * Whether the MPC network will already attest to a transaction in `block`. It answers only for
 * finalized blocks, and its nodes lag the public `finalized` head by a few minutes, so the
 * finalized head must be at least `marginS` of chain time past the block.
 */
export async function provable(
  rpc: string,
  block: number,
  marginS: number,
  fetchFn: Fetch = fetch,
): Promise<boolean> {
  const head = await blockTime(rpc, "finalized", fetchFn);
  if (!head || head.number < block) return false;
  const included = await blockTime(rpc, `0x${block.toString(16)}`, fetchFn);
  return included !== undefined && head.time - included.time >= marginS;
}

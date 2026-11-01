import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { baseDecode } from "near-api-js";

/** The EVM address of an MPC `derived_public_key` (`secp256k1:<base58 x||y>`). */
export function evmAddress(derivedKey: string): string {
  const xy = baseDecode(derivedKey.replace(/^secp256k1:/, ""));
  return `0x${bytesToHex(keccak_256(xy).slice(-20))}`;
}

type Rlp = Uint8Array | Rlp[];

function rlpDecode(b: Uint8Array, start = 0): [Rlp, number] {
  const p = b[start] ?? 0;
  const len = (off: number, n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + (b[off + i] ?? 0);
    return v;
  };
  if (p < 0x80) return [b.slice(start, start + 1), start + 1];
  if (p <= 0xb7) return [b.slice(start + 1, start + 1 + p - 0x80), start + 1 + p - 0x80];
  if (p <= 0xbf) {
    const n = p - 0xb7;
    const l = len(start + 1, n);
    return [b.slice(start + 1 + n, start + 1 + n + l), start + 1 + n + l];
  }
  const [off, l] =
    p <= 0xf7 ? [start + 1, p - 0xc0] : [start + 1 + (p - 0xf7), len(start + 1, p - 0xf7)];
  const items: Rlp[] = [];
  let i = off;
  while (i < off + l) {
    const [item, next] = rlpDecode(b, i);
    items.push(item);
    i = next;
  }
  return [items, off + l];
}

function rlpEncode(x: Rlp): Uint8Array {
  const prefix = (short: number, len: number) => {
    if (len <= 55) return Uint8Array.of(short + len);
    const lb: number[] = [];
    for (let v = len; v > 0; v = Math.floor(v / 256)) lb.unshift(v % 256);
    return Uint8Array.of(short + 55 + lb.length, ...lb);
  };
  if (x instanceof Uint8Array) {
    if (x.length === 1 && (x[0] ?? 0) < 0x80) return x;
    return concat([prefix(0x80, x.length), x]);
  }
  const body = concat(x.map(rlpEncode));
  return concat([prefix(0xc0, body.length), body]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const big = (b: Rlp) => (b instanceof Uint8Array && b.length ? BigInt(`0x${bytesToHex(b)}`) : 0n);

export interface DecodedTx {
  chainId: bigint;
  nonce: bigint;
  to: string;
  value: bigint;
  data: string;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  /** Recovered from the signature: who the chain will say sent it. */
  from: string;
  /** Set when `data` is an ERC-20 `transfer`. */
  erc20?: { to: string; amount: bigint };
}

/** Decodes a signed EIP-1559 transaction and recovers its sender. */
export function decodeSignedTx(raw: string): DecodedTx {
  const bytes = hexToBytes(raw.replace(/^0x/, ""));
  if (bytes[0] !== 2) throw new Error("not an EIP-1559 transaction");
  const [fields] = rlpDecode(bytes, 1);
  if (!Array.isArray(fields) || fields.length !== 12) throw new Error("malformed transaction");
  const [chainId, nonce, tip, maxFee, gas, to, value, data, access, v, r, s] = fields as [
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Rlp,
    Uint8Array,
    Uint8Array,
    Uint8Array,
  ];
  const unsigned = rlpEncode([chainId, nonce, tip, maxFee, gas, to, value, data, access]);
  const hash = keccak_256(concat([Uint8Array.of(2), unsigned]));
  const sig = new secp256k1.Signature(big(r), big(s)).addRecoveryBit(Number(big(v)));
  const pub = sig.recoverPublicKey(hash).toBytes(false);
  const from = `0x${bytesToHex(keccak_256(pub.slice(1)).slice(-20))}`;
  const dataHex = bytesToHex(data);
  const tx: DecodedTx = {
    chainId: big(chainId),
    nonce: big(nonce),
    to: `0x${bytesToHex(to)}`,
    value: big(value),
    data: `0x${dataHex}`,
    gasLimit: big(gas),
    maxFeePerGas: big(maxFee),
    from,
  };
  if (dataHex.startsWith("a9059cbb") && dataHex.length === 8 + 128) {
    tx.erc20 = {
      to: `0x${dataHex.slice(8 + 24, 8 + 64)}`,
      amount: BigInt(`0x${dataHex.slice(8 + 64)}`),
    };
  }
  return tx;
}

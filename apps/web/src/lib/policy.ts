"use client";

import { JsonRpcProvider } from "near-api-js";

export const NEAR_RPC = process.env.NEXT_PUBLIC_NEAR_RPC ?? "https://rpc.testnet.near.org";
export const RANGE_ACCOUNT =
  process.env.NEXT_PUBLIC_RANGE_ACCOUNT ?? "range.factory.ps-spike-1028.testnet";
export const RANGE_EVM = "0xc2C679d9E3fdB12f4Ef08f5d5d6BC2F47498b0bF";

type Asset =
  | "Near"
  | { Nep141: { token: string } }
  | { Evm: { chain_id: number; token: string | null } }
  | { Intents: { token: string } };

interface Rule {
  asset: Asset;
  per_tx_cap: string;
  windows: { period_s: number; limit: string }[];
  cosign_above: string | null;
}

interface Policy {
  frozen: boolean;
  assets: Rule[];
  recipients: Record<string, Record<string, string | number>>[];
  timelock_s: number;
  velocity: { max: number; period_s: number } | null;
}

const USDC_BASE_SEPOLIA = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

/** Display name and decimals; there's no on-chain metadata lookup for EVM tokens. */
export function assetInfo(a: Asset): { name: string; decimals: number } {
  if (a === "Near") return { name: "NEAR", decimals: 24 };
  if ("Evm" in a) {
    if (a.Evm.token === null) return { name: "ETH (gas)", decimals: 18 };
    return a.Evm.token.toLowerCase() === USDC_BASE_SEPOLIA
      ? { name: "USDC on Base", decimals: 6 }
      : { name: `Token ${a.Evm.token.slice(0, 8)}…`, decimals: 18 };
  }
  if ("Nep141" in a) return { name: a.Nep141.token, decimals: 6 };
  return { name: a.Intents.token, decimals: 6 };
}

export function amount(raw: string, decimals: number): string {
  const v = Number(BigInt(raw)) / 10 ** decimals;
  if (v === 0) return "0";
  return v >= 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v.toPrecision(2);
}

const plural = (n: number, unit: string) => (n === 1 ? unit : `${n} ${unit}s`);

/** "day", "2 days", "hour": reads as "2 per day" or "waits 1 hour" after the caller's words. */
const span = (s: number) =>
  s % 86_400 === 0
    ? plural(s / 86_400, "day")
    : s % 3_600 === 0
      ? plural(s / 3_600, "hour")
      : s % 60 === 0
        ? plural(s / 60, "minute")
        : plural(s, "second");

const withCount = (unit: string) => (/^\d/.test(unit) ? unit : `1 ${unit}`);

export interface PolicyView {
  frozen: boolean;
  rules: { name: string; perTx: string; windows: string; cosign: string | null }[];
  payees: string[];
  velocity: string | null;
  timelock: string;
}

export async function loadPolicy(account = RANGE_ACCOUNT): Promise<PolicyView> {
  const provider = new JsonRpcProvider({ url: NEAR_RPC });
  const p = (await provider.callFunction({
    contractId: account,
    method: "policy",
    args: {},
  })) as Policy;
  return {
    frozen: p.frozen,
    rules: p.assets.map((r) => {
      const { name, decimals } = assetInfo(r.asset);
      return {
        name,
        perTx: amount(r.per_tx_cap, decimals),
        windows: r.windows
          .map((w) => `${amount(w.limit, decimals)} per ${span(w.period_s)}`)
          .join(", "),
        cosign: r.cosign_above ? amount(r.cosign_above, decimals) : null,
      };
    }),
    payees: p.recipients.map((r) => {
      const inner = Object.values(r)[0] ?? {};
      return String(inner.account ?? inner.address ?? inner.receiver ?? "");
    }),
    velocity: p.velocity ? `${p.velocity.max} payments per ${span(p.velocity.period_s)}` : null,
    timelock: withCount(span(p.timelock_s)),
  };
}

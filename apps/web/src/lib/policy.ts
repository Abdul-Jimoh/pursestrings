import { JsonRpcProvider } from "near-api-js";

export const NEAR_RPC = process.env.NEXT_PUBLIC_NEAR_RPC ?? "https://test.rpc.fastnear.com";
export const RANGE_ACCOUNT =
  process.env.NEXT_PUBLIC_RANGE_ACCOUNT ?? "range.factory.ps-spike-1028.testnet";
export const RANGE_EVM = "0xc2C679d9E3fdB12f4Ef08f5d5d6BC2F47498b0bF";

/** Mirrors the contract's JSON (`contracts/pursestrings/src/policy.rs`, `types.rs`). */
export type Asset =
  | "Near"
  | { Nep141: { token: string } }
  | { Evm: { chain_id: number; token: string | null } }
  | { Intents: { token: string } };

export interface Window {
  period_s: number;
  limit: string;
}

export interface Rule {
  asset: Asset;
  per_tx_cap: string;
  windows: Window[];
  cosign_above: string | null;
  risk_check_above: string | null;
}

export type Recipient =
  | { Near: { account: string } }
  | { Evm: { chain_id: number; address: string } }
  | { Intents: { account: string } }
  | { Withdraw: { receiver: string; memo: string | null } };

export interface Velocity {
  max: number;
  period_s: number;
}

export interface Policy {
  version: number;
  frozen: boolean;
  assets: Rule[];
  recipients: Recipient[];
  chains: number[];
  cooldown_s: number;
  velocity: Velocity | null;
  pending_ttl_s: number;
  timelock_s: number;
  floors?: { asset: Asset; min: string }[];
  split?: { account: string; bps: number }[];
  delivery_s?: number;
}

let provider: JsonRpcProvider | undefined;

export async function view<T>(
  account: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  provider ??= new JsonRpcProvider({ url: NEAR_RPC });
  return (await provider.callFunction({
    contractId: account,
    method,
    args,
    blockQuery: { finality: "optimistic" },
  })) as T;
}

export const fetchPolicy = (account: string) => view<Policy>(account, "policy");

const USDC_BASE_SEPOLIA = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const CHAINS: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  84532: "Base Sepolia",
  42161: "Arbitrum",
  11155111: "Sepolia",
};

export const chainName = (id: number) => CHAINS[id] ?? `chain ${id}`;

/** Display name and decimals; there's no on-chain metadata lookup for EVM tokens. */
export function assetInfo(a: Asset): { name: string; decimals: number } {
  if (a === "Near") return { name: "NEAR", decimals: 24 };
  if ("Evm" in a) {
    if (a.Evm.token === null) return { name: `ETH on ${chainName(a.Evm.chain_id)}`, decimals: 18 };
    return a.Evm.token.toLowerCase() === USDC_BASE_SEPOLIA
      ? { name: "USDC on Base", decimals: 6 }
      : { name: `Token ${a.Evm.token.slice(0, 8)}…`, decimals: 18 };
  }
  if ("Nep141" in a) return { name: a.Nep141.token, decimals: 6 };
  return { name: `${a.Intents.token} in Intents`, decimals: 6 };
}

export const sameAsset = (a: Asset, b: Asset) => JSON.stringify(a) === JSON.stringify(b);

export function amount(raw: string, decimals: number): string {
  const v = Number(BigInt(raw)) / 10 ** decimals;
  if (v === 0) return "0";
  return v >= 1
    ? v.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : v.toLocaleString("en-US", { maximumSignificantDigits: 2 });
}

/** "12.5" with 6 decimals → "12500000"; exact, so it never rounds a limit up. */
export function toRaw(display: string, decimals: number): string {
  const s = display.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`"${display}" isn't an amount`);
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0"))).toString();
}

/** The exact inverse of `toRaw`: "12500000" with 6 decimals → "12.5". */
export function fromRaw(raw: string, decimals: number): string {
  const s = raw.padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

const plural = (n: number, unit: string) => (n === 1 ? unit : `${n} ${unit}s`);

/** "day", "2 days", "hour": reads as "2 per day" or "waits 1 hour" after the caller's words. */
export const span = (s: number) =>
  s % 86_400 === 0
    ? plural(s / 86_400, "day")
    : s % 3_600 === 0
      ? plural(s / 3_600, "hour")
      : s % 60 === 0
        ? plural(s / 60, "minute")
        : plural(s, "second");

export const duration = (s: number) => {
  const u = span(s);
  return /^\d/.test(u) ? u : `1 ${u}`;
};

export function recipientName(r: Recipient): string {
  if ("Near" in r) return r.Near.account;
  if ("Evm" in r) return `${r.Evm.address} on ${chainName(r.Evm.chain_id)}`;
  if ("Intents" in r) return `${r.Intents.account} in Intents`;
  return `${r.Withdraw.receiver}${r.Withdraw.memo ? ` (memo ${r.Withdraw.memo})` : ""}, withdrawn`;
}

export interface PolicyView {
  frozen: boolean;
  rules: { name: string; perTx: string; windows: string; cosign: string | null }[];
  payees: string[];
  velocity: string | null;
  timelock: string;
}

export async function loadPolicy(account = RANGE_ACCOUNT): Promise<PolicyView> {
  const p = await fetchPolicy(account);
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
      const inner = Object.values(r)[0] as Record<string, unknown>;
      return String(inner.account ?? inner.address ?? inner.receiver ?? "");
    }),
    velocity: p.velocity ? `${p.velocity.max} payments per ${span(p.velocity.period_s)}` : null,
    timelock: duration(p.timelock_s),
  };
}

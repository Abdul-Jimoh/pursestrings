import type { Asset } from "@pursestrings/sdk";

/** Decimals for tokens the contract can't know (it has no oracle), keyed by contract or address. */
export type Decimals = Record<string, number>;

export function decimalsOf(asset: Asset, known: Decimals): number | undefined {
  if (asset === "Near") return 24;
  if ("Evm" in asset) return asset.Evm.token === null ? 18 : known[asset.Evm.token.toLowerCase()];
  if ("Nep141" in asset) return known[asset.Nep141.token];
  return known[asset.Intents.token];
}

export function whole(raw: string, decimals: number): string {
  const v = BigInt(raw);
  const unit = 10n ** BigInt(decimals);
  const frac = (v % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / unit}.${frac}` : `${v / unit}`;
}

const AMOUNTS = ["per_tx_cap", "cosign_above", "risk_check_above", "limit", "used", "remaining"];

/**
 * Copies an asset rule or budget status, adding `<field>_whole` beside each raw amount. Models
 * misplace 24 decimal places often enough to misstate a limit by a factor of a million.
 */
export function withWhole<T extends { asset: Asset }>(rule: T, known: Decimals): T {
  const d = decimalsOf(rule.asset, known);
  if (d === undefined) return rule;
  const add = (o: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = v;
      if (AMOUNTS.includes(k) && typeof v === "string") out[`${k}_whole`] = whole(v, d);
    }
    return out;
  };
  const top = add(rule as Record<string, unknown>);
  if (Array.isArray(top.windows)) top.windows = (top.windows as Record<string, unknown>[]).map(add);
  return top as T;
}

/** Parses `token:decimals,token:decimals`, as the servers take it from the environment. */
export function parseDecimals(spec: string | undefined): Decimals {
  const out: Decimals = {};
  for (const pair of (spec ?? "").split(",")) {
    const [token, d] = pair.trim().split(":");
    if (token && d && /^\d+$/.test(d)) out[token.toLowerCase()] = Number(d);
  }
  return out;
}

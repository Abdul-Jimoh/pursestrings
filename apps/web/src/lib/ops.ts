import {
  type Asset,
  amount,
  assetInfo,
  duration,
  type Policy,
  type Recipient,
  type Rule,
  recipientName,
  sameAsset,
  span,
  type Velocity,
  type Window,
} from "./policy";

/** The `PolicyOp`s the dashboard writes; the contract accepts more (see `policy.rs`). */
export type Op =
  | { SetAssetRule: Rule }
  | { AddRecipient: Recipient }
  | { RemoveRecipient: Recipient }
  | { SetVelocity: { velocity: Velocity | null } }
  | "Freeze"
  | "Unfreeze"
  | Record<string, unknown>;

// Removing a group frees budget, so it isn't here.
const TIGHT_REMOVALS = [
  "RemoveAsset",
  "RemoveRecipient",
  "RemoveChain",
  "RemoveIntentKind",
  "RemoveMinRate",
  "RemoveEvmGas",
  "RemovePriceFloor",
  "RemoveRefundLimit",
  "RemoveCouncil",
  "RemoveTrust",
];

const le = (a: string, b: string) => BigInt(a) <= BigInt(b);

const thresholdTighter = (n: string | null, c: string | null) =>
  c === null ? true : n === null ? false : le(n, c);

const windowsTighter = (n: Window[], c: Window[]) =>
  c.every((cw) => n.some((nw) => nw.period_s === cw.period_s && le(nw.limit, cw.limit)));

/**
 * Mirrors `classify` in `contracts/pursestrings/src/policy.rs`: anything not provably at least as
 * strict as the current policy waits out the timelock. The contract decides; this only previews.
 */
export function tightens(op: Op, p: Policy): boolean {
  if (op === "Freeze") return true;
  if (op === "Unfreeze") return false;
  if ("SetAssetRule" in op) {
    const n = op.SetAssetRule as Rule;
    const c = p.assets.find((r) => sameAsset(r.asset, n.asset));
    return (
      !!c &&
      le(n.per_tx_cap, c.per_tx_cap) &&
      windowsTighter(n.windows, c.windows) &&
      thresholdTighter(n.cosign_above, c.cosign_above) &&
      thresholdTighter(n.risk_check_above, c.risk_check_above)
    );
  }
  if ("SetVelocity" in op) {
    const n = (op.SetVelocity as { velocity: Velocity | null }).velocity;
    const c = p.velocity;
    return c === null ? true : n === null ? false : n.max <= c.max && n.period_s >= c.period_s;
  }
  if ("SetCooldown" in op) return (op.SetCooldown as { seconds: number }).seconds >= p.cooldown_s;
  if ("SetTimelock" in op) return (op.SetTimelock as { seconds: number }).seconds >= p.timelock_s;
  if ("SetPendingTtl" in op)
    return (op.SetPendingTtl as { seconds: number }).seconds <= p.pending_ttl_s;
  if ("SetPriceFloor" in op) {
    const n = op.SetPriceFloor as { asset: Asset; min: string };
    const c = p.floors?.find((f) => sameAsset(f.asset, n.asset));
    return !!c && le(c.min, n.min);
  }
  if ("SetSplit" in op)
    return JSON.stringify((op.SetSplit as { shares: unknown }).shares) === JSON.stringify(p.split);
  if ("SetDeliveryWindow" in op)
    return (op.SetDeliveryWindow as { seconds: number }).seconds <= (p.delivery_s ?? 0);
  // Trust tiers and refund windows are compared tier by tier on-chain; the preview says "waits".
  return TIGHT_REMOVALS.includes(Object.keys(op)[0] ?? "");
}

const money = (a: Asset, raw: string) => {
  const { name, decimals } = assetInfo(a);
  return `${amount(raw, decimals)} ${name}`;
};

/** One line of plain English per op, for the read-back and the timelock queue. */
export function describe(op: Op): string {
  if (op === "Freeze") return "Freeze the account: refuse every request.";
  if (op === "Unfreeze") return "Unfreeze the account.";
  const [kind, body] = Object.entries(op)[0] ?? ["?", {}];
  switch (kind) {
    case "SetAssetRule": {
      const r = body as Rule;
      const { name } = assetInfo(r.asset);
      const parts = [`largest payment ${money(r.asset, r.per_tx_cap)}`];
      for (const w of r.windows) parts.push(`${money(r.asset, w.limit)} per ${span(w.period_s)}`);
      parts.push(
        r.cosign_above === null ? "no co-sign" : `co-sign above ${money(r.asset, r.cosign_above)}`,
      );
      return `${name}: ${parts.join(", ")}.`;
    }
    case "AddRecipient":
      return `Allow payments to ${recipientName(body as Recipient)}.`;
    case "RemoveRecipient":
      return `Stop payments to ${recipientName(body as Recipient)}.`;
    case "SetVelocity": {
      const v = (body as { velocity: Velocity | null }).velocity;
      return v
        ? `At most ${v.max} payments per ${span(v.period_s)}.`
        : "No limit on payments per hour.";
    }
    case "SetCooldown":
      return `Wait ${duration((body as { seconds: number }).seconds)} between payments.`;
    case "SetTimelock":
      return `Loosening waits ${duration((body as { seconds: number }).seconds)}.`;
    case "RemoveAsset":
      return `Stop all spending of ${assetInfo((body as { asset: Asset }).asset).name}.`;
    case "Migrate":
      return `Move the contract to code ${String((body as { code_hash: string }).code_hash).slice(0, 10)}….`;
    default:
      return `${kind.replace(/([a-z])([A-Z])/g, "$1 $2")}.`;
  }
}

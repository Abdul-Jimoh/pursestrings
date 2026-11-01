import type { Decision, DenyReason } from "./types.ts";

function duration(s: number): string {
  if (s % 86_400 === 0) return s === 86_400 ? "day" : `${s / 86_400} days`;
  if (s % 3_600 === 0) return s === 3_600 ? "hour" : `${s / 3_600} hours`;
  return `${s} s`;
}

/** Renders a raw amount; group amounts are in the group's unit. */
export type FormatAmount = (amount: string, group?: string) => string;

/** One sentence an agent (or a person) can act on. */
export function explainDenial(reason: DenyReason, fmt: FormatAmount = (a) => a): string {
  if (typeof reason === "string") {
    return {
      Frozen: "The owner has frozen this account; nothing can be spent until they unfreeze it.",
      AssetNotAllowed: "The policy has no rule for this asset, so it can't be spent.",
      AssetDestMismatch: "This asset can't be sent to that kind of destination.",
      ChainNotAllowed: "The policy doesn't allow spending on this chain.",
      IntentKindNotAllowed: "The policy doesn't allow this kind of Intents action.",
      RecipientNotAllowed: "The recipient isn't on the owner's allowlist.",
      PairNotAllowed:
        "The owner hasn't set a minimum rate for this swap pair, so it can't be swapped.",
      RateBelowFloor: "The swap pays out less than the owner's minimum rate.",
      FeeBudgetExhausted: "The account's budget for fees it pays itself is used up for now.",
      GasCapsMissing: "The owner hasn't set gas limits for this chain.",
      NoGasBudget: "There's no budget for this chain's gas token.",
      IntentsKeyMissing: "The owner hasn't registered the account's key on intents.near yet.",
    }[reason];
  }
  if ("DuplicateIdempotencyKey" in reason) {
    return `This idempotency key was already used by request ${reason.DuplicateIdempotencyKey.req_id}.`;
  }
  if ("OverPerTxCap" in reason)
    return `Over the per-payment cap of ${fmt(reason.OverPerTxCap.cap)}.`;
  if ("Cooldown" in reason) {
    return `Too soon after the last payment; retry at ${reason.Cooldown.retry_at} (unix s).`;
  }
  if ("Velocity" in reason) {
    return `Too many requests; one frees up in ${reason.Velocity.retry_after_s} s.`;
  }
  if ("OverWindow" in reason) {
    const w = reason.OverWindow;
    return `Over this asset's budget per ${duration(w.period_s)}; ${fmt(w.remaining)} left.`;
  }
  const g = reason.OverGroupWindow;
  return `Over the shared "${g.group}" budget per ${duration(g.period_s)}; ${fmt(g.remaining, g.group)} left across every chain in it.`;
}

export function describeDecision(d: Decision, fmt?: FormatAmount): string {
  if ("Approved" in d) return `approved (request ${d.Approved.req_id})`;
  if ("NeedsCosign" in d)
    return `waiting for the owner's co-sign (request ${d.NeedsCosign.req_id})`;
  if ("NeedsRisk" in d) return `waiting for a risk check (request ${d.NeedsRisk.req_id})`;
  return `denied: ${explainDenial(d.Denied.reason, fmt)}`;
}

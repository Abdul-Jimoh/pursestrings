import type { Decision, DenyReason, QuoteDecision, RefundDecision } from "./types.ts";

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
      BountyMismatch:
        "A bounty payout must go to its claimant, after they submit, for at most the reward.",
      NoTrustRule: "The owner hasn't set trust tiers for this asset, so bounties can't pay in it.",
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
  if ("NeedsCouncil" in d)
    return `waiting for one council member (request ${d.NeedsCouncil.req_id})`;
  if ("NeedsRisk" in d) return `waiting for a risk check (request ${d.NeedsRisk.req_id})`;
  return `denied: ${explainDenial(d.Denied.reason, fmt)}`;
}

export function describeQuote(d: QuoteDecision, fmt: FormatAmount = (a) => a): string {
  if ("Quoted" in d) return `quoted (order ${d.Quoted.order_id})`;
  const r = d.Denied.reason;
  if (r === "Frozen") return "refused: the owner has frozen this account.";
  if (r === "NotForSale") return "refused: the owner hasn't set a price floor for this token.";
  if (r === "TooManyOpenQuotes") return "refused: too many unpaid quotes are open.";
  return `refused: below the owner's floor of ${fmt(r.BelowFloor.floor)}.`;
}

export function describeRefund(d: RefundDecision, fmt: FormatAmount = (a) => a): string {
  if (d === "Refunded") return "refunded";
  const r = d.Denied.reason;
  if (r === "Frozen") return "refused: the owner has frozen this account.";
  if (r === "NotPaid") return "refused: the order isn't paid.";
  if (r === "NoRefundLimit") return "refused: the owner allows no refunds in this token.";
  if ("OverHeld" in r) return `refused: at most ${fmt(r.OverHeld.max)} can be refunded on it.`;
  if ("NotWhole" in r)
    return `refused: before delivery a refund returns the whole ${fmt(r.NotWhole.held)} or nothing.`;
  return `refused: over the refund budget per ${duration(r.OverWindow.period_s)}; ${fmt(r.OverWindow.remaining)} left.`;
}

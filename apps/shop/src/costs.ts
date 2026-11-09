import type { Agent, Decision } from "@pursestrings/sdk";
import type { Chat } from "./seller.ts";

/** Counts what each model call costs, whoever made it: the seller's haggling or a report. */
export function metered(
  model: Chat,
  onUsage: (u: { input: number; output: number }) => void,
): Chat {
  return {
    async chat(messages, tools) {
      const turn = await model.chat(messages, tools);
      onUsage(turn.usage);
      return turn;
    },
  };
}

export interface CostsConfig {
  agent: Agent;
  /** Who buys the model credits and is paid back. Must be on the shop's allowlist. */
  payee: string;
  /** NEAR paid back per US dollar of model use: a fixed rate the operator sets, no oracle. */
  nearPerUsd: number;
  /** Smaller debts wait until they add up, so a payment isn't mostly gas. */
  minYocto: bigint;
  /** The most one payment asks for; keep it under the owner's co-sign threshold. */
  maxYocto: bigint;
  /** After a refusal or an unknown outcome, wait this long before asking again. */
  backoffMs?: number;
  now?: () => number;
}

const YOCTO_PER_NEAR = 10n ** 24n;
const HOUR = 3_600_000;

interface Pending {
  key: string;
  amount: bigint;
  usd: number;
  calls: number;
}

/**
 * The shop pays its own running costs from its earnings, through the same contract as everything
 * else: each payment is a `request_spend` under the owner's cap, allowlist and co-sign rule.
 */
export class Costs {
  private owedUsd = 0;
  private calls = 0;
  private retryAt = 0;
  /** A payment whose outcome isn't known yet goes out again under the same key and amount. */
  private pending: Pending | undefined;
  private readonly c: CostsConfig;
  constructor(c: CostsConfig) {
    this.c = c;
  }

  add(usd: number) {
    this.owedUsd += usd;
    this.calls += 1;
  }

  owed(): bigint {
    // Micro-NEAR first, so the float never reaches the yocto arithmetic.
    const micro = BigInt(Math.round(this.owedUsd * this.c.nearPerUsd * 1e6));
    return (micro * YOCTO_PER_NEAR) / 1_000_000n;
  }

  /** Pays what's owed, up to `maxYocto`, if it's enough to bother. A refusal waits a while. */
  async settle(): Promise<{ decision: Decision; amount: bigint; tx: string } | undefined> {
    const now = (this.c.now ?? Date.now)();
    if (now < this.retryAt) return undefined;
    if (!this.pending) {
      const owed = this.owed();
      if (owed < this.c.minYocto) return undefined;
      let amount = owed;
      if (amount > this.c.maxYocto) amount = this.c.maxYocto;
      const share = Number(amount) / Number(owed);
      this.pending = {
        key: `costs-${now}`,
        amount,
        usd: this.owedUsd * share,
        calls: Math.round(this.calls * share),
      };
    }
    const p = this.pending;
    const out = await this.c.agent.requestSpend({
      asset: "Near",
      amount: p.amount.toString(),
      dest: { Near: { account: this.c.payee } },
      purpose: `model costs: ${p.calls} calls, ${p.usd.toFixed(4)} USD`,
      idempotency_key: p.key,
    });
    const d = out.value;
    if (!d) {
      this.retryAt = now + (this.c.backoffMs ?? HOUR);
      return undefined;
    }
    // A duplicate key means an earlier try with this key was admitted.
    const landed =
      !("Denied" in d) ||
      (typeof d.Denied.reason === "object" && "DuplicateIdempotencyKey" in d.Denied.reason);
    this.pending = undefined;
    if (landed) {
      this.owedUsd = Math.max(0, this.owedUsd - p.usd);
      this.calls = Math.max(0, this.calls - p.calls);
    } else {
      this.retryAt = now + (this.c.backoffMs ?? HOUR);
    }
    return { decision: d, amount: p.amount, tx: out.txHash };
  }
}

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
  now?: () => number;
}

const YOCTO_PER_NEAR = 10n ** 24n;

/**
 * The shop pays its own running costs from its earnings, through the same contract as everything
 * else: each payment is a `request_spend` under the owner's cap, allowlist and co-sign rule.
 */
export class Costs {
  private owedUsd = 0;
  private calls = 0;
  private readonly c: CostsConfig;
  constructor(c: CostsConfig) {
    this.c = c;
  }

  add(usd: number) {
    this.owedUsd += usd;
    this.calls += 1;
  }

  owed(): bigint {
    // Micro-dollars first, so the float never reaches the yocto arithmetic.
    const micro = BigInt(Math.round(this.owedUsd * this.c.nearPerUsd * 1e6));
    return (micro * YOCTO_PER_NEAR) / 1_000_000n;
  }

  /** Pays what's owed if it's enough to bother; a refusal leaves the debt for later. */
  async settle(): Promise<{ decision: Decision; amount: bigint; tx: string } | undefined> {
    const amount = this.owed();
    if (amount < this.c.minYocto) return undefined;
    const usd = this.owedUsd;
    const calls = this.calls;
    const out = await this.c.agent.requestSpend({
      asset: "Near",
      amount: amount.toString(),
      dest: { Near: { account: this.c.payee } },
      purpose: `model costs: ${calls} calls, $${usd.toFixed(4)}`,
      idempotency_key: `costs-${(this.c.now ?? Date.now)()}`,
    });
    if (!out.value) return undefined;
    if (!("Denied" in out.value)) {
      this.owedUsd -= usd;
      this.calls -= calls;
    }
    return { decision: out.value, amount, tx: out.txHash };
  }
}

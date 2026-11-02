export interface Pricing {
  /** USD per million tokens. */
  inPerM: number;
  outPerM: number;
}

export const cost = (u: { input: number; output: number }, p: Pricing) =>
  (u.input * p.inPerM + u.output * p.outPerM) / 1e6;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The Range's spending guard: a hard daily cap on model spend (the Range closes for the rest of
 * the UTC day once it's reached) and a per-account hourly attempt limit.
 */
export class Limits {
  private spent = new Map<string, number>();
  private attempts = new Map<string, number[]>();
  private readonly dailyUsd: number;
  private readonly perHour: number;
  private readonly now: () => number;

  constructor(opts: { dailyUsd: number; perHour: number; now?: () => number }) {
    this.dailyUsd = opts.dailyUsd;
    this.perHour = opts.perHour;
    this.now = opts.now ?? Date.now;
  }

  spentToday(): number {
    return this.spent.get(day(this.now())) ?? 0;
  }

  open(): boolean {
    return this.spentToday() < this.dailyUsd;
  }

  check(account: string): { ok: true } | { ok: false; reason: string } {
    if (!this.open())
      return { ok: false, reason: "closed for today: the daily model budget is used up" };
    const recent = (this.attempts.get(account) ?? []).filter((t) => t > this.now() - 3_600_000);
    if (recent.length >= this.perHour) {
      return { ok: false, reason: `limit of ${this.perHour} attempts an hour per account` };
    }
    return { ok: true };
  }

  record(account: string, usd: number, at = this.now()) {
    const d = day(at);
    this.spent.set(d, (this.spent.get(d) ?? 0) + usd);
    this.attempts.set(account, [...(this.attempts.get(account) ?? []), at]);
  }

  status() {
    return { open: this.open(), spentUsd: this.spentToday(), capUsd: this.dailyUsd };
  }
}

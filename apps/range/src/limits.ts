export interface Pricing {
  /** USD per million tokens. */
  inPerM: number;
  outPerM: number;
}

export const cost = (u: { input: number; output: number }, p: Pricing) =>
  (u.input * p.inPerM + u.output * p.outPerM) / 1e6;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** A key such as `chat:alice.testnet` belongs to `alice.testnet`. */
const owner = (key: string) => key.replace(/^[a-z]+:/, "");

/**
 * The Range's spending guard: a hard daily cap on model spend (the Range closes for the rest of
 * the UTC day once it's reached) and per-account hourly limits. `key` separates kinds of use,
 * such as a Range attempt and a chat message, which count against different hourly limits but
 * the same daily budget.
 */
export class Limits {
  private spent = new Map<string, number>();
  /** Each account's spend per UTC day, so a few accounts can't use up everyone's budget. */
  private spentBy = new Map<string, number>();
  private readonly perAccountUsd: number;
  private attempts = new Map<string, number[]>();
  private readonly dailyUsd: number;
  private readonly perHour: number;
  private readonly now: () => number;

  constructor(opts: {
    dailyUsd: number;
    perHour: number;
    perAccountUsd?: number;
    now?: () => number;
  }) {
    this.dailyUsd = opts.dailyUsd;
    this.perAccountUsd = opts.perAccountUsd ?? Number.POSITIVE_INFINITY;
    this.perHour = opts.perHour;
    this.now = opts.now ?? Date.now;
  }

  spentToday(): number {
    return this.spent.get(day(this.now())) ?? 0;
  }

  open(): boolean {
    return this.spentToday() < this.dailyUsd;
  }

  check(
    key: string,
    perHour = this.perHour,
    what = "attempts",
  ): { ok: true } | { ok: false; reason: string } {
    if (!this.open())
      return { ok: false, reason: "closed for today: the daily model budget is used up" };
    if ((this.spentBy.get(`${day(this.now())}|${owner(key)}`) ?? 0) >= this.perAccountUsd)
      return {
        ok: false,
        reason: "you've used your share of today's model budget: come back after midnight UTC",
      };
    const recent = (this.attempts.get(key) ?? []).filter((t) => t > this.now() - 3_600_000);
    if (recent.length >= perHour) {
      return { ok: false, reason: `limit of ${perHour} ${what} an hour per account` };
    }
    return { ok: true };
  }

  record(account: string, usd: number, at = this.now()) {
    const d = day(at);
    this.spent.set(d, (this.spent.get(d) ?? 0) + usd);
    const mine = `${d}|${owner(account)}`;
    this.spentBy.set(mine, (this.spentBy.get(mine) ?? 0) + usd);
    this.attempts.set(account, [...(this.attempts.get(account) ?? []), at]);
  }

  status() {
    return { open: this.open(), spentUsd: this.spentToday(), capUsd: this.dailyUsd };
  }
}

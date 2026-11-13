/**
 * Limits for "try it without a wallet": a demo buyer the server holds buys a check at the floor
 * price, so visitors with no testnet wallet can watch a real sale. Every try spends the demo
 * account's NEAR, so they're capped per UTC day, run one at a time and a little apart.
 */
export class Trials {
  private used = new Map<string, number>();
  private busy = false;
  private last = Number.NEGATIVE_INFINITY;
  private readonly perDay: number;
  private readonly gapMs: number;
  private readonly now: () => number;
  constructor(perDay: number, gapMs = 20_000, now: () => number = Date.now) {
    this.perDay = perDay;
    this.gapMs = gapMs;
    this.now = now;
  }

  private day() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  left(): number {
    return Math.max(0, this.perDay - (this.used.get(this.day()) ?? 0));
  }

  /** Takes a slot, or says why not. Call `done` when the try has finished, however it ended. */
  start(): { ok: true; done: () => void } | { ok: false; reason: string } {
    if (this.left() === 0)
      return { ok: false, reason: "today's demo checks are used up: come back after midnight UTC" };
    if (this.busy) return { ok: false, reason: "a demo check is running: try again in a minute" };
    if (this.now() - this.last < this.gapMs)
      return { ok: false, reason: "a demo check just ran: try again in a few seconds" };
    this.busy = true;
    this.last = this.now();
    const day = this.day();
    this.used.set(day, (this.used.get(day) ?? 0) + 1);
    return {
      ok: true,
      done: () => {
        this.busy = false;
      },
    };
  }
}

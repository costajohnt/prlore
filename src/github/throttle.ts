export interface RateInfo {
  cost: number;
  remaining: number;
  resetAt: string;
}

interface ThrottleOpts {
  pointsPerMinute?: number;
  minRemaining?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const WINDOW_MS = 60_000;

export class Throttle {
  private readonly pointsPerMinute: number;
  private readonly minRemaining: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private spent: { at: number; cost: number }[] = [];

  constructor(opts: ThrottleOpts = {}) {
    this.pointsPerMinute = opts.pointsPerMinute ?? 1600;
    // A single fetch page (files/reviews/comments/threads all first-page'd) costs ~180 points,
    // so a floor of 100 could let the next page start and then get rejected mid-flight.
    this.minRemaining = opts.minRemaining ?? 400;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private windowSpend(at: number): number {
    this.spent = this.spent.filter((s) => at - s.at < WINDOW_MS);
    return this.spent.reduce((sum, s) => sum + s.cost, 0);
  }

  async beforeRequest(estimatedCost = 2): Promise<void> {
    while (this.windowSpend(this.now()) + estimatedCost > this.pointsPerMinute) {
      const oldest = this.spent[0];
      if (!oldest) break;
      const wait = WINDOW_MS - (this.now() - oldest.at);
      await this.sleep(Math.max(wait, 1));
    }
  }

  async afterResponse(rate: RateInfo): Promise<void> {
    this.spent.push({ at: this.now(), cost: rate.cost });
    if (rate.remaining < this.minRemaining) {
      const wait = new Date(rate.resetAt).getTime() - this.now();
      if (wait > 0) await this.sleep(wait + 1000);
    }
  }
}

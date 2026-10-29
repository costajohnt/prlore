import { BudgetExceededError, type CompleteOptions, type ModelProvider } from "../model/provider.js";

/**
 * Wraps a ModelProvider with a LOWER budget gate than the provider's own cap, without
 * duplicating any spend tracking — spentUsd() delegates to the shared inner counter.
 *
 * Why: AnthropicProvider's `spent` is one monotonic counter with a pre-call gate at
 * maxBudgetUsd. If extraction were allowed to burn right up to that cap, synthesize's
 * reconcile/plan calls (which rethrow BudgetExceededError as a hard failure) would then
 * fail unconditionally — making "extraction budget-partial -> ready-for-preview" (a
 * binding Phase 6 decision) unreachable. Capping extraction below the full budget
 * reserves headroom so synthesis can still complete after a budget-partial extraction.
 */
export function cappedProvider(inner: ModelProvider, capUsd: number): ModelProvider {
  const startSpent = inner.spentUsd();
  let completed = 0;
  let inFlight = 0;

  return {
    spentUsd: () => inner.spentUsd(),
    // The gate counts calls that are still running at the average cost of the calls
    // this wrapper has finished (retries included), not just what they have booked so
    // far. Checking booked spend alone let every concurrent extraction worker pass the
    // gate just under the cap, and each one's retry is only gated by the inner
    // provider's full cap, so extraction could run well past capUsd and eat the
    // synthesis reserve. The average is an estimate, so a small overshoot remains when
    // call costs vary.
    async complete<T>(opts: CompleteOptions<T>): Promise<T> {
      const spent = inner.spentUsd();
      const averageCost = completed === 0 ? 0 : (spent - startSpent) / completed;
      if (spent + inFlight * averageCost >= capUsd) throw new BudgetExceededError(spent, capUsd);
      inFlight++;
      try {
        return await inner.complete(opts);
      } finally {
        inFlight--;
        completed++;
      }
    },
  };
}

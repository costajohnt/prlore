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
  return {
    spentUsd: () => inner.spentUsd(),
    // Overshoot window: the gate above only checks spend BEFORE a call starts, not
    // after. Under concurrent extraction, up to (concurrency - 1) in-flight calls can
    // all read spent < capUsd and pass the gate before any of their cost registers on
    // the shared inner counter — so actual spend can land somewhat over capUsd, bounded
    // by roughly one call's worth of cost per in-flight slot. Same window exists on the
    // real (uncapped) provider at its own maxBudgetUsd cap, for the same reason — this
    // isn't a gap introduced by wrapping, just inherited from a pre-call-only gate.
    // Accepted for v1: the bound is small relative to typical budgets and closing it
    // would need a reservation/rollback protocol the spend model doesn't have yet.
    async complete<T>(opts: CompleteOptions<T>): Promise<T> {
      const spent = inner.spentUsd();
      if (spent >= capUsd) throw new BudgetExceededError(spent, capUsd);
      return inner.complete(opts);
    },
  };
}

// Approximate month length used throughout the reconciler/analyzer for recency and
// trend windows. Not calendar-accurate (months vary 28-31 days); the tolerance is
// fine for half-life decay and 6/12/36-month lookback windows, which don't need
// calendar precision.
export const MONTH_MS = 30 * 86_400_000;

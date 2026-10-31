import { createHash } from "node:crypto";
import type { MineConfig } from "../schemas/mine-config.js";

export function configHash(config: MineConfig): string {
  const identity: Record<string, unknown> = {
    repo: config.repo,
    baseUrl: config.baseUrl,
    // Day granularity: `--days N` recomputes `since` from the clock every run, and a
    // millisecond-fresh hash would reset (and quarantine) the corpus on every invocation.
    since: config.timeRange.since ? config.timeRange.since.slice(0, 10) : null,
    maxPrs: config.timeRange.maxPrs,
  };
  // The authors filter changes WHICH PRs survive into the corpus, so switching
  // it against the same stateDir must not reuse a checkpoint built under a
  // different filter. Normalized (lowercased + sorted) so case/order variants
  // of the same filter share a checkpoint instead of needlessly refetching.
  // Included only when non-empty so the no-filter case still hashes identically
  // to configs that predate this field, preserving checkpoint compatibility for
  // every existing .prlore stateDir that never used --author.
  if (config.authors.length > 0) {
    identity.authors = [...config.authors].map((a) => a.toLowerCase()).sort();
  }
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

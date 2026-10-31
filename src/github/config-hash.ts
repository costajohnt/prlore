import { createHash } from "node:crypto";
import type { MineConfig } from "../schemas/mine-config.js";

export function configHash(config: MineConfig): string {
  const identity: Record<string, unknown> = {
    repo: config.repo,
    baseUrl: config.baseUrl,
    // `--days N` recomputes `since` from the clock every run, so the identity is the
    // user's N, not the derived instant; an explicit --since hashes its exact UTC instant.
    since: config.timeRange.days === undefined && config.timeRange.since ? new Date(config.timeRange.since).toISOString() : null,
    maxPrs: config.timeRange.maxPrs,
  };
  if (config.timeRange.days !== undefined) identity.days = config.timeRange.days;
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

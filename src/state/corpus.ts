import type { MineConfig } from "../schemas/mine-config.js";
import { NormalizedPrSchema, type NormalizedPr } from "../schemas/normalized-pr.js";
import { readJsonl } from "./jsonl.js";

export async function readCorpus(
  path: string,
): Promise<{ prs: NormalizedPr[]; drifted: number }> {
  let invalidSeq = 0;
  const raw = await readJsonl<unknown>(
    path,
    (r) => r,
    (r) => {
      const n = (r as { number?: unknown } | null)?.number;
      return typeof n === "number" ? n : `invalid-${invalidSeq++}`; // unique key per invalid line
    },
  );
  const prs: NormalizedPr[] = [];
  let drifted = 0;
  for (const item of raw) {
    const parsed = NormalizedPrSchema.safeParse(item);
    if (parsed.success) prs.push(parsed.data);
    else drifted++;
  }
  return { prs, drifted };
}

/**
 * The slice of the corpus a run synthesizes over. The corpus accumulates across
 * incremental re-runs, so the run's own window is re-applied here: rows older than
 * `since` (which slides with --days) drop out, and only the newest maxPrs are kept.
 */
export function windowCorpus(prs: NormalizedPr[], config: MineConfig): NormalizedPr[] {
  const since = config.timeRange.since ? new Date(config.timeRange.since).toISOString() : null;
  const inRange = since ? prs.filter((p) => p.updatedAt >= since) : prs;
  const { maxPrs } = config.timeRange;
  if (inRange.length <= maxPrs) return inRange;
  const newest = new Set(
    [...inRange].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, maxPrs).map((p) => p.number),
  );
  return inRange.filter((p) => newest.has(p.number));
}

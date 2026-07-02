import { join } from "node:path";
import { loadCheckpoint, saveCheckpoint } from "../state/checkpoint.js";
import { readCorpus } from "../state/corpus.js";
import { Extractor, type ExtractSummary, type ExtractorDeps } from "./extractor.js";

export async function extractFromCorpus(
  stateDir: string,
  deps: Omit<ExtractorDeps, "stateDir">,
): Promise<ExtractSummary & { drifted: number }> {
  const { prs, drifted } = await readCorpus(join(stateDir, "corpus.jsonl"));
  const extractor = new Extractor({ ...deps, stateDir });
  for (const pr of prs) extractor.enqueue(pr);
  const summary = await extractor.drain();

  const cp = await loadCheckpoint(stateDir);
  // A budget-partial run must not advance the stage: some PRs never got a provider
  // call, so their candidates are missing. Per-item failures still count toward
  // `failed` (accepted loss, spec §10), but leaving the stage at "extracting" lets a
  // resume with a raised budget re-run cheaply, since already-cached PRs are free hits.
  if (cp && cp.stage === "extracting" && summary.skippedBudget === 0) {
    cp.stage = "analyzing";
    await saveCheckpoint(stateDir, cp);
  }

  return { ...summary, drifted };
}

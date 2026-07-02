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
  if (cp && cp.stage === "extracting") {
    cp.stage = "analyzing";
    await saveCheckpoint(stateDir, cp);
  }

  return { ...summary, drifted };
}

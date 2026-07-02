import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CandidateLearningSchema, type CandidateLearning } from "../schemas/candidate-learning.js";
import type { NormalizedPr } from "../schemas/normalized-pr.js";
import { atomicWriteFile } from "../state/atomic.js";
import { EXTRACTOR_PROMPT_VERSION } from "./extract-one.js";

const EntrySchema = z.object({ key: z.string(), candidates: z.array(CandidateLearningSchema) });

export function cacheKey(pr: NormalizedPr, model: string): string {
  return createHash("sha256")
    .update(`${pr.number}|${pr.updatedAt}|${EXTRACTOR_PROMPT_VERSION}|${model}`)
    .digest("hex");
}

function cachePath(stateDir: string, pr: NormalizedPr): string {
  return join(stateDir, "extraction-cache", `${pr.number}.json`);
}

export async function readCache(
  stateDir: string,
  pr: NormalizedPr,
  model: string,
): Promise<CandidateLearning[] | null> {
  try {
    const raw = JSON.parse(await readFile(cachePath(stateDir, pr), "utf8"));
    const entry = EntrySchema.parse(raw);
    return entry.key === cacheKey(pr, model) ? entry.candidates : null;
  } catch {
    return null; // missing, corrupt, or schema-drifted → miss
  }
}

export async function writeCache(
  stateDir: string,
  pr: NormalizedPr,
  model: string,
  candidates: CandidateLearning[],
): Promise<void> {
  const path = cachePath(stateDir, pr);
  await atomicWriteFile(path, JSON.stringify({ key: cacheKey(pr, model), candidates }));
}

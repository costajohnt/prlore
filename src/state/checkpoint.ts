import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { CheckpointSchema, type Checkpoint } from "../schemas/checkpoint.js";
import { atomicWriteFile } from "./atomic.js";

const FILE = "checkpoint.json";

/**
 * Single owner of the config-hash reset: the old corpus (fetched under a different
 * repo/authors/time range) is moved into superseded-<ts>/ and the fresh checkpoint is
 * written before the caller makes any network call, so a crash in between can never
 * leave an old-hash checkpoint next to an empty corpus.
 */
export async function resetState(stateDir: string, configHash: string, now: () => number = Date.now): Promise<Checkpoint> {
  const corpus = join(stateDir, "corpus.jsonl");
  const superseded = join(stateDir, `superseded-${now()}`);
  try {
    await mkdir(superseded, { recursive: true });
    await rename(corpus, join(superseded, "corpus.jsonl"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const cp: Checkpoint = { configHash, stage: "fetching", cursor: null, overflowQueue: [], maxUpdatedAt: null, counters: {} };
  await saveCheckpoint(stateDir, cp);
  return cp;
}

export async function saveCheckpoint(stateDir: string, cp: Checkpoint): Promise<void> {
  await atomicWriteFile(join(stateDir, FILE), JSON.stringify(cp, null, 2));
}

export async function loadCheckpoint(
  stateDir: string,
  now: () => number = Date.now,
): Promise<Checkpoint | null> {
  const path = join(stateDir, FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return CheckpointSchema.parse(JSON.parse(text));
  } catch {
    const quarantine = join(stateDir, `corrupt-${now()}`);
    await mkdir(quarantine, { recursive: true });
    await rename(path, join(quarantine, FILE));
    return null;
  }
}

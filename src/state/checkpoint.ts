import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { CheckpointSchema, type Checkpoint } from "../schemas/checkpoint.js";
import { atomicWriteFile } from "./atomic.js";

const FILE = "checkpoint.json";

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

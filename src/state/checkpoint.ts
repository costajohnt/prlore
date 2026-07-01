import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CheckpointSchema, type Checkpoint } from "../schemas/checkpoint.js";

const FILE = "checkpoint.json";

export async function saveCheckpoint(stateDir: string, cp: Checkpoint): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, FILE);
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(cp, null, 2), "utf8");
  await rename(tmp, path); // atomic on POSIX: readers never see a half-written file
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

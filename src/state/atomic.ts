import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Shared tmp-write + rename primitive: rename is atomic on POSIX, so readers never
// observe a half-written file. Callers pass the FINAL path; the parent directory is
// created if missing so callers don't need their own mkdir before calling this.
export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Shared tmp-write + rename primitive: rename is atomic on POSIX, so readers never
// observe a half-written file. Callers pass the FINAL path; the parent directory is
// created if missing so callers don't need their own mkdir before calling this.
// The temp name is random and opened with "wx" (O_CREAT|O_EXCL), so a pre-planted
// `<path>.tmp` symlink (e.g. checked into a mined repo) is never followed. rename
// replaces a symlink at the final path instead of writing through it.
export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

// The state dir lives inside the mined checkout by default, so its contents are
// as trusted as that checkout. A symlink anywhere in it (corpus.jsonl, the
// extraction-cache dir, the dir itself) would redirect state writes outside the
// repo, so refuse to run on one. A missing state dir is fine: it gets created.
export function assertNoSymlinks(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink()) throw new Error(`refusing to use state dir: ${path} is a symlink`);
  if (st.isDirectory()) for (const name of readdirSync(path)) assertNoSymlinks(join(path, name));
}

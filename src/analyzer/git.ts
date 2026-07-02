import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

// Exit code 1 is "no results" for git grep / git log -S filters — return the
// (possibly empty) stdout instead of throwing. Real failures exit 128+.
export const realGit: GitRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    if (e.code === 1) return e.stdout ?? "";
    throw err;
  }
};

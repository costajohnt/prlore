import type { GitRunner } from "./git.js";

export interface History {
  files: string[];
  lastTouched: Map<string, number>;
  commitCount: Map<string, number>;
  recencyPercentile: Map<string, number>;
}

export async function collectHistory(git: GitRunner, repoPath: string): Promise<History> {
  const tracked = new Set(
    (await git(["ls-files"], repoPath)).split("\n").map((l) => l.trim()).filter(Boolean),
  );

  const log = await git(["log", "--format=%x01%ct", "--name-only"], repoPath);
  const lastTouched = new Map<string, number>();
  const commitCount = new Map<string, number>();
  let ts = 0;
  for (const rawLine of log.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("\x01")) {
      ts = Number(line.slice(1));
      continue;
    }
    if (!tracked.has(line)) continue;
    commitCount.set(line, (commitCount.get(line) ?? 0) + 1);
    lastTouched.set(line, Math.max(lastTouched.get(line) ?? 0, ts));
  }

  const files = [...tracked];
  const touchTimes = files.map((f) => lastTouched.get(f) ?? 0);
  const recencyPercentile = new Map<string, number>();
  for (const f of files) {
    const mine = lastTouched.get(f) ?? 0;
    const below = touchTimes.filter((t) => t < mine).length;
    recencyPercentile.set(f, files.length > 1 ? below / (files.length - 1) : 0);
  }

  return { files, lastTouched, commitCount, recencyPercentile };
}

export function parseCodeowners(content: string): { pattern: string; owners: string[] }[] {
  const entries: { pattern: string; owners: string[] }[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern && owners.length > 0) entries.push({ pattern, owners });
  }
  return entries;
}

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
  const sorted = [...touchTimes].sort((a, b) => a - b);
  const lowerBound = (t: number): number => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const recencyPercentile = new Map<string, number>();
  for (const f of files) {
    const mine = lastTouched.get(f) ?? 0;
    recencyPercentile.set(f, files.length > 1 ? lowerBound(mine) / (files.length - 1) : 0);
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

/**
 * GitHub CODEOWNERS matching semantics: last matching entry wins, `*` matches
 * everything, and a leading `/` (repo-root anchor) is stripped since we only
 * match against area-relative paths.
 */
export function ownersForPath(
  entries: { pattern: string; owners: string[] }[],
  areaPath: string,
): string[] | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const raw = entries[i]!;
    const p = raw.pattern.replace(/^\//, "").replace(/\/$/, "");
    if (p === "*" || areaPath === p || areaPath.startsWith(`${p}/`)) {
      return raw.owners.length > 0 ? raw.owners : undefined;
    }
  }
  return undefined;
}

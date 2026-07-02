import type { Migration } from "../schemas/patterns-model.js";
import type { GitRunner } from "./git.js";

function excludePathspecs(excludes?: string[]): string[] {
  if (!excludes || excludes.length === 0) return [];
  return ["--", ".", ...excludes.map((e) => `:(exclude)${e}`)];
}

export async function grepCount(
  git: GitRunner,
  repoPath: string,
  token: string,
  excludes?: string[],
): Promise<number> {
  const args = ["grep", "-F", "-c", "-e", token, ...excludePathspecs(excludes)];
  const out = await git(args, repoPath);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(":") + 1) || 0), 0);
}

export async function pickaxeCount(
  git: GitRunner,
  repoPath: string,
  token: string,
  sinceIso?: string,
  untilIso?: string,
  excludes?: string[],
): Promise<number> {
  const args = ["log", `-S${token}`, "--oneline"];
  if (sinceIso) args.push(`--since=${sinceIso}`);
  if (untilIso) args.push(`--until=${untilIso}`);
  args.push(...excludePathspecs(excludes));
  const out = await git(args, repoPath);
  return out.split("\n").filter((l) => l.trim()).length;
}

const MONTH_MS = 30 * 86400_000;

export async function verifyMigrations(
  git: GitRunner,
  repoPath: string,
  candidates: { from: string; to: string }[],
  now: () => number,
  excludes?: string[],
): Promise<Migration[]> {
  const migrations: Migration[] = [];
  for (const { from, to } of candidates) {
    const [oldCount, newCount] = await Promise.all([
      grepCount(git, repoPath, from, excludes),
      grepCount(git, repoPath, to, excludes),
    ]);
    if (newCount === 0) continue; // destination absent → not a migration

    const t = now();
    const twelveMonthsAgo = new Date(t - 12 * MONTH_MS).toISOString();
    const thirtySixMonthsAgo = new Date(t - 36 * MONTH_MS).toISOString();
    const [recent, prior] = await Promise.all([
      pickaxeCount(git, repoPath, from, twelveMonthsAgo, undefined, excludes),
      pickaxeCount(git, repoPath, from, thirtySixMonthsAgo, twelveMonthsAgo, excludes),
    ]);
    const trend = recent < prior ? "falling" : recent > prior ? "rising" : "flat";

    migrations.push({
      from,
      to,
      status: oldCount === 0 ? "complete" : "in-progress",
      evidence: { oldCount, newCount, trend },
    });
  }
  return migrations;
}

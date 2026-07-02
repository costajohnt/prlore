import type { Migration } from "../schemas/patterns-model.js";
import type { GitRunner } from "./git.js";

export async function grepCount(git: GitRunner, repoPath: string, token: string): Promise<number> {
  const out = await git(["grep", "-F", "-c", "-e", token], repoPath);
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
): Promise<number> {
  const args = ["log", `-S${token}`, "--oneline"];
  if (sinceIso) args.push(`--since=${sinceIso}`);
  if (untilIso) args.push(`--until=${untilIso}`);
  const out = await git(args, repoPath);
  return out.split("\n").filter((l) => l.trim()).length;
}

const MONTH_MS = 30 * 86400_000;

export async function verifyMigrations(
  git: GitRunner,
  repoPath: string,
  candidates: { from: string; to: string }[],
  now: () => number,
): Promise<Migration[]> {
  const migrations: Migration[] = [];
  for (const { from, to } of candidates) {
    const [oldCount, newCount] = await Promise.all([
      grepCount(git, repoPath, from),
      grepCount(git, repoPath, to),
    ]);
    if (newCount === 0) continue; // destination absent → not a migration

    const t = now();
    const twelveMonthsAgo = new Date(t - 12 * MONTH_MS).toISOString();
    const thirtySixMonthsAgo = new Date(t - 36 * MONTH_MS).toISOString();
    const [recent, prior] = await Promise.all([
      pickaxeCount(git, repoPath, from, twelveMonthsAgo),
      pickaxeCount(git, repoPath, from, thirtySixMonthsAgo, twelveMonthsAgo),
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

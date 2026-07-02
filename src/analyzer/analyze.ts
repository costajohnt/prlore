import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ModelProvider } from "../model/provider.js";
import type { MineConfig } from "../schemas/mine-config.js";
import { PatternsModelSchema, type PatternsModel } from "../schemas/patterns-model.js";
import { atomicWriteFile } from "../state/atomic.js";
import { collectHistory, ownersForPath, parseCodeowners } from "./collect.js";
import { detectAreas, pickExemplars } from "./areas.js";
import { collectTooling } from "./tooling.js";
import { realGit, type GitRunner } from "./git.js";
import { verifyMigrations } from "./probes.js";

export interface AnalyzeDeps {
  provider: ModelProvider;
  git?: GitRunner;
  now?: () => number;
  stateDir?: string;
}

const AnalyzerDraftSchema = z.object({
  areaDescriptions: z.array(z.object({ path: z.string(), description: z.string() })),
  patterns: z.array(
    z.object({
      statement: z.string().min(1),
      scope: z.array(z.string()),
      exemplars: z.array(z.string()),
      confidence: z.number().min(0).max(1),
    }),
  ),
  migrationCandidates: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).max(5),
});

const EXCERPT_CAP = 8_000;
const CODEOWNERS_PATHS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

const SYSTEM = `You analyze a code repository to build its "current patterns" model.
The most-recently-touched areas define present-day canon; low-recency areas are legacy
context that new code should not copy. Report only patterns the exemplars support.
Propose migrationCandidates only as concrete greppable token pairs (an old API/symbol
being replaced by a new one). Respond with ONLY JSON matching the requested shape.`;

export async function analyze(
  repoPath: string,
  config: MineConfig,
  deps: AnalyzeDeps,
): Promise<PatternsModel> {
  const git = deps.git ?? realGit;
  const now = deps.now ?? Date.now;

  const history = await collectHistory(git, repoPath);
  const areas = detectAreas(history);
  const exemplars = pickExemplars(areas, history, config.focusAreas);
  const meta = await collectTooling(history.files, (p) => readFile(join(repoPath, p), "utf8"));

  let owners: { pattern: string; owners: string[] }[] = [];
  for (const candidate of CODEOWNERS_PATHS) {
    if (history.files.includes(candidate)) {
      owners = parseCodeowners(await readFile(join(repoPath, candidate), "utf8"));
      break;
    }
  }

  const excerpts: { area: string; path: string; text: string }[] = [];
  for (const e of exemplars) {
    try {
      const text = (await readFile(join(repoPath, e.path), "utf8")).slice(0, EXCERPT_CAP);
      excerpts.push({ ...e, text });
    } catch {
      // unreadable exemplar (binary, permissions) — skip silently
    }
  }

  const areaTable = areas
    .map(
      (a) =>
        `- ${a.path} | stack: ${a.stack.join(",") || "?"} | recency: ${a.recencyScore.toFixed(2)} | churn: ${a.churn} | files: ${a.files.length}`,
    )
    .join("\n");
  const excerptBlocks = excerpts
    .map((e) => `--- ${e.path} (area: ${e.area}) ---\n${e.text}`)
    .join("\n\n");

  const prompt = `## User intent
${config.intent}

## Repo meta
languages: ${meta.languages.join(", ") || "unknown"}
frameworks: ${meta.frameworks.join(", ") || "none detected"}
tooling: ${meta.tooling.join(", ") || "none detected"}

## Areas (recency 0..1 — higher is more current)
${areaTable}

## Exemplar files (top recency x churn per area)
${excerptBlocks}

Produce the JSON draft: areaDescriptions for every area listed, patterns supported by
the exemplars (scope as path globs), and up to 5 migrationCandidates as greppable
token pairs.`;

  const draft = await deps.provider.complete({
    system: SYSTEM,
    prompt,
    schema: AnalyzerDraftSchema,
    maxTokens: 8192,
  });

  const migrations = await verifyMigrations(git, repoPath, draft.migrationCandidates, now);

  const descriptions = new Map(draft.areaDescriptions.map((d) => [d.path, d.description]));

  const model: PatternsModel = PatternsModelSchema.parse({
    areas: areas.map((a) => {
      const own = ownersForPath(owners, a.path);
      return {
        path: a.path,
        stack: a.stack,
        recencyScore: a.recencyScore,
        ...(own ? { owners: own } : {}),
        description: descriptions.get(a.path) ?? "",
      };
    }),
    patterns: draft.patterns,
    migrations,
    meta,
  });

  if (deps.stateDir) {
    await atomicWriteFile(join(deps.stateDir, "patterns.json"), JSON.stringify(model, null, 2));
  }
  return model;
}

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { realGit, type GitRunner } from "../analyzer/git.js";
import type { ModelProvider } from "../model/provider.js";
import type { CandidateLearning } from "../schemas/candidate-learning.js";
import type { MineConfig } from "../schemas/mine-config.js";
import type { NormalizedPr } from "../schemas/normalized-pr.js";
import type { PatternsModel } from "../schemas/patterns-model.js";
import {
  ProvenanceSchema,
  type ContestedItem,
  type Provenance,
  type RuleRecord,
} from "../schemas/provenance.js";
import { loadCheckpoint, saveCheckpoint } from "../state/checkpoint.js";
import { clusterCandidates } from "./cluster.js";
import { mergeCodeOnlyPatterns, reconcileClusters, type ReconciledRule } from "./reconcile.js";
import { renderDraft } from "./render.js";
import { INCLUDE_THRESHOLD, scoreRule } from "./score.js";
import { planDoc } from "./select.js";
import { verifyEvidence } from "./verify-evidence.js";

export interface SynthesizeDeps {
  provider: ModelProvider;
  repoPath: string; // for the reconciliation probes
  git?: GitRunner; // default realGit
  now?: () => number; // default Date.now
  stateDir?: string; // when given: atomic writes + guarded stage flip
  excludes?: string[]; // threaded into reconcile probes
}

function toRuleRecord(rule: ReconciledRule, nowMs: number): RuleRecord {
  const score = rule.syntheticScore ?? scoreRule(rule.evidence, rule.verdict, nowMs);
  const lastCorroborated =
    rule.verdict === "corroborated" || rule.verdict === "trending-toward"
      ? new Date(nowMs).toISOString()
      : null;
  return {
    id: String(rule.id),
    statement: rule.statement,
    category: rule.category,
    polarity: rule.polarity,
    scope: rule.scope,
    score,
    verdict: rule.verdict,
    ...(rule.rationale ? { rationale: rule.rationale } : {}),
    evidence: rule.evidence,
    exemplars: rule.exemplars,
    lastCorroborated,
  };
}

function toContestedItem(rule: ReconciledRule): ContestedItem {
  return {
    id: String(rule.id),
    statement: rule.statement,
    reason: rule.contestedReason ?? "contested",
    sides: [{ statement: rule.statement, evidence: rule.evidence }],
  };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = path + ".tmp";
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path); // atomic on POSIX: readers never see a half-written file
}

export async function synthesize(
  config: MineConfig,
  patterns: PatternsModel,
  candidates: CandidateLearning[],
  prs: NormalizedPr[],
  deps: SynthesizeDeps,
): Promise<{ draft: string; provenance: Provenance; contested: ContestedItem[] }> {
  const { provider, repoPath, git = realGit, now = Date.now, stateDir, excludes } = deps;

  const verified = verifyEvidence(candidates, prs);
  const { clusters, conflictPairs } = await clusterCandidates(verified, provider);
  const reconciled = await reconcileClusters(clusters, conflictPairs, patterns, {
    provider,
    git,
    repoPath,
    now,
    excludes,
  });
  const merged = mergeCodeOnlyPatterns(reconciled, patterns);

  // Three-way disjoint split: contested first (its corroboration weight is 0, so it
  // would otherwise always land in `dropped`), then the score threshold.
  const contested: ContestedItem[] = [];
  const rules: RuleRecord[] = [];
  const dropped: RuleRecord[] = [];
  for (const rule of merged) {
    if (rule.verdict === "contested") {
      contested.push(toContestedItem(rule));
      continue;
    }
    const record = toRuleRecord(rule, now());
    if (record.score < INCLUDE_THRESHOLD) dropped.push(record);
    else rules.push(record);
  }
  rules.sort((a, b) => b.score - a.score);

  const plan = await planDoc(rules, config.intent, patterns.areas, provider);
  const draft = renderDraft(plan, rules, contested, config);

  const provenance = ProvenanceSchema.parse({
    generatedAt: new Date(now()).toISOString(),
    intent: config.intent,
    rules,
    dropped,
    contested,
  });

  if (stateDir) {
    await mkdir(stateDir, { recursive: true });
    await atomicWrite(join(stateDir, "draft.md"), draft);
    await atomicWrite(join(stateDir, "provenance.json"), JSON.stringify(provenance, null, 2));

    // Guarded stage flip: only advance from "analyzing"; a missing checkpoint or a
    // checkpoint at any other stage is left untouched (same pattern as extractFromCorpus).
    const cp = await loadCheckpoint(stateDir);
    if (cp && cp.stage === "analyzing") {
      cp.stage = "ready-for-preview";
      await saveCheckpoint(stateDir, cp);
    }
  }

  return { draft, provenance, contested };
}

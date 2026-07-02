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
  type EvidenceRecord,
  type Provenance,
  type RuleRecord,
} from "../schemas/provenance.js";
import { loadCheckpoint, saveCheckpoint } from "../state/checkpoint.js";
import { clusterCandidates } from "./cluster.js";
import { mergeCodeOnlyPatterns, reconcileClusters, type ReconciledRule } from "./reconcile.js";
import { renderDraft } from "./render.js";
import { authorityOf, INCLUDE_THRESHOLD, recurrenceOf, scoreRule } from "./score.js";
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

// Evidence-strength tie-break used ONLY to pick which side's statement leads a
// merged pair item: scoreRule can't be used here because corroborationOf("contested")
// is 0, so both sides would always score 0 and the comparison would be meaningless.
function evidenceStrength(rule: ReconciledRule): number {
  return authorityOf(rule.evidence) * recurrenceOf(rule.evidence);
}

function contestedSide(rule: ReconciledRule): { statement: string; evidence: EvidenceRecord[] } {
  return { statement: rule.statement, evidence: rule.evidence };
}

// 3b conflict-pair items: one disagreement, one ContestedItem, both sides carried.
// id = the two rule ids joined "+", lower first, for a deterministic stable key.
function pairedContestedItem(a: ReconciledRule, b: ReconciledRule): ContestedItem {
  const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
  const leader = evidenceStrength(a) >= evidenceStrength(b) ? a : b;
  // Prefer whichever side carries a specific reason (e.g. a 3a-origin "recent
  // maintainer guidance..." reason) over the generic 3b "conflicting guidance".
  const reason =
    (a.contestedReason && a.contestedReason !== "conflicting guidance" && a.contestedReason) ||
    (b.contestedReason && b.contestedReason !== "conflicting guidance" && b.contestedReason) ||
    a.contestedReason ||
    b.contestedReason ||
    "contested";
  return {
    id: `${String(lo.id)}+${String(hi.id)}`,
    statement: leader.statement,
    reason,
    sides: [contestedSide(a), contestedSide(b)],
  };
}

// 3a-only items: single rule, no conflicting counterpart. When a code trend probe
// ran (the demotion the maintainer's recent guidance is contesting), surface it as
// a second, evidence-free side so the reader sees what's actually being disputed.
function singleContestedItem(rule: ReconciledRule): ContestedItem {
  const sides = [contestedSide(rule)];
  if (rule.probeResult) {
    const { token, head, recent, prior } = rule.probeResult;
    sides.push({ statement: `code trend: ${token} head ${head}, recent ${recent} vs prior ${prior}`, evidence: [] });
  }
  return {
    id: String(rule.id),
    statement: rule.statement,
    reason: rule.contestedReason ?? "contested",
    sides,
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
): Promise<{ draft: string; provenance: Provenance; contested: ContestedItem[]; warnings: string[] }> {
  const { provider, repoPath, git = realGit, now = Date.now, stateDir, excludes } = deps;
  const warnings: string[] = [];

  const verified = verifyEvidence(candidates, prs);
  const counters = { clusterFallbacks: 0 };
  const { clusters, conflictPairs } = await clusterCandidates(verified, provider, { counters });
  if (counters.clusterFallbacks > 0) {
    warnings.push(`cluster fallback used for ${counters.clusterFallbacks} bucket(s)`);
  }
  // Reconcile/plan fallbacks are invisible externally by design — a BudgetExceededError
  // from either now rethrows (see reconcile.ts / select.ts) instead of degrading silently,
  // and non-budget failures there keep their existing deterministic-fallback behavior.
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
  const contestedById = new Map(merged.filter((r) => r.verdict === "contested").map((r) => [r.id, r]));
  const consumed = new Set<ReconciledRule["id"]>();
  for (const rule of merged) {
    if (rule.verdict === "contested") {
      if (consumed.has(rule.id)) continue; // already emitted as the other half of a pair
      const partner = rule.contestedWith !== undefined ? contestedById.get(rule.contestedWith) : undefined;
      if (partner) {
        contested.push(pairedContestedItem(rule, partner));
        consumed.add(rule.id);
        consumed.add(partner.id);
      } else {
        contested.push(singleContestedItem(rule));
        consumed.add(rule.id);
      }
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

    // Guarded stage flip: advance from "analyzing" OR "synthesizing" — synthesize
    // owns the analyzing->synthesizing->ready-for-preview transition, but upstream
    // job managers may or may not have already pre-flipped the checkpoint to
    // "synthesizing" before calling in. A missing checkpoint or a checkpoint at any
    // other stage is left untouched (same pattern as extractFromCorpus).
    const cp = await loadCheckpoint(stateDir);
    if (cp && (cp.stage === "analyzing" || cp.stage === "synthesizing")) {
      cp.stage = "ready-for-preview";
      await saveCheckpoint(stateDir, cp);
    }
  }

  return { draft, provenance, contested, warnings };
}

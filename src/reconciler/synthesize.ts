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
import { atomicWriteFile } from "../state/atomic.js";
import { loadCheckpoint, saveCheckpoint } from "../state/checkpoint.js";
import { clusterCandidates } from "./cluster.js";
import { dedupeAcrossBuckets } from "./dedupe.js";
import { mergeCodeOnlyPatterns, reconcileClusters, type ReconciledRule } from "./reconcile.js";
import { renderDraft } from "./render.js";
import { authorityOf, failsRecurrenceFloor, INCLUDE_THRESHOLD, recurrenceOf, scoreRule } from "./score.js";
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
  // syntheticScore (mergeCodeOnlyPatterns) already bakes in its own confidence-derived
  // value and bypasses scoreRule entirely, so it also bypasses the generality penalty —
  // consistent with those rules never carrying a generality tag (probe-verified
  // code-only patterns, not model-tagged clusters).
  const score = rule.syntheticScore ?? scoreRule(rule.evidence, rule.verdict, nowMs, rule.generality);
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
    ...(rule.generality ? { generality: rule.generality } : {}),
    ...(rule.mergedFrom && rule.mergedFrom.length > 0 ? { mergedFrom: rule.mergedFrom.map(String) } : {}),
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

  // Cross-bucket dedup pass (v0.3 Task 3): runs here — after reconcile + the
  // code-only merge, before RuleRecord/scoring — so the union of a merged pair's
  // evidence feeds recurrence/scoring for the surviving (kept) record, rather than
  // scoring each duplicate separately and then trying to reconcile two already-scored
  // rules. See v03-t3-report.md for why "highest-score member" (the plan's literal
  // adjudication rule) can't apply at this pre-scoring position.
  const { rules: deduped, warning: dedupeWarning } = await dedupeAcrossBuckets(merged, provider);
  if (dedupeWarning) warnings.push(dedupeWarning);

  // Three-way disjoint split: contested first (its corroboration weight is 0, so it
  // would otherwise always land in `dropped`), then the score threshold.
  const contested: ContestedItem[] = [];
  const rules: RuleRecord[] = [];
  const dropped: RuleRecord[] = [];
  const contestedById = new Map(deduped.filter((r) => r.verdict === "contested").map((r) => [r.id, r]));
  const consumed = new Set<ReconciledRule["id"]>();
  for (const rule of deduped) {
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
    // Recurrence floor, after scoring but before the include-threshold split (spec
    // v0.3 Task 1): synthetic code-only rules (mergeCodeOnlyPatterns — no PR evidence
    // at all) are exempt, since they're probe-verified against the codebase, not
    // gossip from a single PR thread.
    if (rule.syntheticScore === undefined && failsRecurrenceFloor(rule.evidence)) {
      dropped.push({ ...record, droppedReason: "recurrence-floor" });
      continue;
    }
    if (record.score < INCLUDE_THRESHOLD) dropped.push(record);
    else rules.push(record);
  }
  rules.sort((a, b) => b.score - a.score);

  // v0.3 Task 4: tiered rendering. `rules` is already score-desc sorted, so the
  // top output.maxRules is a plain index slice — a structural partition, not a
  // filter, which is what keeps "a rule is either in a section or the tail,
  // never both" true by construction rather than by a runtime check. planDoc
  // (and therefore every planned section) only ever sees the full-tier slice:
  // feeding it every rule and demoting the overflow afterward would let a
  // section legitimately reference a rule this pass then wants in the compact
  // tail, so the cut has to happen BEFORE planning, not after. The tail bypasses
  // planning entirely and renders as compact one-liners (see render.ts).
  const maxRules = config.output.maxRules;
  const tiered: RuleRecord[] = rules.map((r, i) => ({
    ...r,
    renderedTier: i < maxRules ? "full" : "compact",
  }));
  const fullRules = tiered.filter((r) => r.renderedTier === "full");
  const tailRules = tiered.filter((r) => r.renderedTier === "compact");

  const plan = await planDoc(fullRules, config.intent, patterns.areas, provider);
  const draft = renderDraft(plan, fullRules, contested, config, tailRules);

  const provenance = ProvenanceSchema.parse({
    generatedAt: new Date(now()).toISOString(),
    intent: config.intent,
    rules: tiered,
    dropped,
    contested,
  });

  if (stateDir) {
    await atomicWriteFile(join(stateDir, "draft.md"), draft);
    await atomicWriteFile(join(stateDir, "provenance.json"), JSON.stringify(provenance, null, 2));

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

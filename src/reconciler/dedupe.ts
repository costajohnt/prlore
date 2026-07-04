import { z } from "zod";
import { BudgetExceededError, type ModelProvider } from "../model/provider.js";
import type { EvidenceRecord } from "../schemas/provenance.js";
import type { ReconciledRule } from "./reconcile.js";

// v0.3 Task 3: clustering runs per category bucket (cluster.ts's CATEGORIES loop), so
// two rules stating the same underlying norm from different buckets (e.g. a
// TTY-gating convention filed once under "style" and once under "process") never get
// a chance to merge — clusterCandidates only ever compares candidates within a single
// bucket. This pass runs ONE additional provider call over every non-contested rule's
// one-liner, across ALL buckets at once, and proposes sets of ids that name the same
// norm. LLM-proposes/code-decides: every proposed set is independently re-verified
// here before anything is merged; a set that fails verification is dropped whole
// (never partially applied).
export interface MergedGroup {
  keptId: ReconciledRule["id"];
  absorbedIds: ReconciledRule["id"][];
}

export interface DedupeResult {
  rules: ReconciledRule[];
  merged: MergedGroup[];
  // Set only when the provider call itself failed (and wasn't a BudgetExceededError,
  // which rethrows instead of degrading). Not part of the literal binding-contract
  // return shape in the plan doc — see the v03-t3-report.md disclosure — but additive
  // and the simplest way for synthesize to thread a warning without a side-channel
  // mutable counter (cluster.ts's `opts.counters` pattern) for a pass that runs
  // exactly once, not per-bucket.
  warning?: string;
}

const DedupeDraftSchema = z.object({
  mergeSets: z.array(
    z.object({
      ids: z.array(z.union([z.number().int(), z.string().min(1)])),
    }),
  ),
});
type DedupeDraft = z.infer<typeof DedupeDraftSchema>;

const SYSTEM = `You review a flat list of engineering-convention rules, each shown as
"[id] statement". Some rules from DIFFERENT categories may state the SAME underlying norm in
different words (e.g. "gate TTY-only output behind isatty()" and "don't print ANSI codes when
not attached to a terminal" are the same rule). Propose sets of ids that should be merged because
they assert the same norm. Only propose a merge when you are confident the rules mean the same
thing — do not merge rules that are merely related or in the same topic area. Respond with ONLY
JSON matching the schema.`;

// The prompt's first line is a distinguishing marker so callers (including test
// doubles) can route this call without confusing it for the cluster call's bare
// "[i] statement (polarity)" lines or the reconcile/plan calls' "meta:"/"intent:"
// prefixes.
function buildPrompt(rules: ReconciledRule[]): string {
  const lines = rules.map((r) => `[${r.id}] ${r.statement}`);
  return ["dedupe:", ...lines].join("\n");
}

// Evidence dedup-by-(pr,quote): same precedent as cluster.ts's mergeEvidence.
function mergeEvidence(members: ReconciledRule[]): EvidenceRecord[] {
  const seen = new Set<string>();
  const out: EvidenceRecord[] = [];
  for (const m of members) {
    for (const e of m.evidence) {
      const key = JSON.stringify([e.pr, e.quote]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

// Adjudication note (plan-ambiguity, disclosed in v03-t3-report.md): the plan says
// "merge keeps highest-score member", but this pass runs BEFORE scoring (scoreRule
// needs the merged evidence as an input, so scoring after merge is correct and
// scoring the pass itself would be circular). Deterministic proxy used instead: most
// evidence entries, then most distinct PRs, then lowest id.
function pickKeptMember(members: ReconciledRule[]): ReconciledRule {
  return [...members].sort((a, b) => {
    if (b.evidence.length !== a.evidence.length) return b.evidence.length - a.evidence.length;
    const prsA = new Set(a.evidence.map((e) => e.pr)).size;
    const prsB = new Set(b.evidence.map((e) => e.pr)).size;
    if (prsB !== prsA) return prsB - prsA;
    return compareIds(a.id, b.id);
  })[0]!;
}

// "Lowest id" tie-break: numeric ids (cluster.ts's global cluster ids) compare
// numerically; mixed/string ids (mergeCodeOnlyPatterns' "code-N" synthetic ids) fall
// back to string comparison. Only used to break exact ties on the two counts above,
// so any deterministic total order is sufficient.
function compareIds(a: ReconciledRule["id"], b: ReconciledRule["id"]): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export async function dedupeAcrossBuckets(
  rules: ReconciledRule[],
  provider: ModelProvider,
): Promise<DedupeResult> {
  const contestedIds = new Set(rules.filter((r) => r.verdict === "contested").map((r) => String(r.id)));
  // Synthetic code-only rules (mergeCodeOnlyPatterns, no PR evidence) are included:
  // they're non-contested rules like any other, and a code-derived pattern CAN
  // restate a norm a PR thread also asserted (disclosed in v03-t3-report.md).
  const nonContested = rules.filter((r) => r.verdict !== "contested");

  let draft: DedupeDraft;
  try {
    draft = await provider.complete({
      system: SYSTEM,
      prompt: buildPrompt(nonContested),
      schema: DedupeDraftSchema,
      maxTokens: 4096,
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    return { rules, merged: [], warning: "cross-bucket dedup pass failed; rules left unmerged" };
  }

  const byId = new Map(rules.map((r) => [String(r.id), r]));
  const claimed = new Set<string>();
  const validSets: ReconciledRule[][] = [];

  for (const set of draft.mergeSets ?? []) {
    const idsStr = (set.ids ?? []).map(String);
    if (idsStr.length < 2) continue; // nothing to merge

    // (a) all ids exist and are non-contested.
    if (!idsStr.every((id) => byId.has(id) && !contestedIds.has(id))) continue;

    const members = idsStr.map((id) => byId.get(id)!);
    // (b) all share polarity.
    const polarity = members[0]!.polarity;
    if (!members.every((m) => m.polarity === polarity)) continue;

    // (c) sets are disjoint: drop any set overlapping an earlier (already-accepted) one.
    if (idsStr.some((id) => claimed.has(id))) continue;

    const uniqueIds = [...new Set(idsStr)];
    if (uniqueIds.length < 2) continue; // collapsed to a single id after de-duping

    for (const id of uniqueIds) claimed.add(id);
    validSets.push(uniqueIds.map((id) => byId.get(id)!));
  }

  if (validSets.length === 0) return { rules, merged: [] };

  const merged: MergedGroup[] = [];
  const absorbedIds = new Set<string>();
  const mergedByKeptId = new Map<string, ReconciledRule>();

  for (const members of validSets) {
    const kept = pickKeptMember(members);
    const others = members.filter((m) => m !== kept);
    const evidence = mergeEvidence([kept, ...others]);
    // Fix (cross-task seam: dedup x recurrence floor x synthetic rules): a synthetic
    // code-only member (mergeCodeOnlyPatterns, no PR evidence, probe-verified) can
    // lose pickKeptMember to a PR-evidenced member every time (evidence count is the
    // primary sort key, and a synthetic member always has zero). The `...kept` spread
    // below only carries the KEPT member's own syntheticScore, so a losing synthetic
    // member's probe signal used to vanish outright — dropping both the recurrence-
    // floor exemption (synthesize.ts checks `rule.syntheticScore === undefined`) and
    // the confidence value itself. Carry the MAX syntheticScore across every member
    // of the merge set forward onto the merged record, regardless of which member
    // pickKeptMember chose. synthesize.ts's toRuleRecord takes
    // max(syntheticScore, scoreRule(...)) for the final score, so a strong PR side
    // can still outscore a weak probe once both are considered.
    const syntheticScores = members
      .map((m) => m.syntheticScore)
      .filter((s): s is number => s !== undefined);
    const mergedRule: ReconciledRule = {
      ...kept,
      evidence,
      mergedFrom: [...(kept.mergedFrom ?? []), ...others.map((o) => o.id)],
      ...(syntheticScores.length > 0 ? { syntheticScore: Math.max(...syntheticScores) } : {}),
    };
    mergedByKeptId.set(String(kept.id), mergedRule);
    for (const o of others) absorbedIds.add(String(o.id));
    merged.push({ keptId: kept.id, absorbedIds: others.map((o) => o.id) });
  }

  const outRules = rules
    .filter((r) => !absorbedIds.has(String(r.id)))
    .map((r) => mergedByKeptId.get(String(r.id)) ?? r);

  return { rules: outRules, merged };
}

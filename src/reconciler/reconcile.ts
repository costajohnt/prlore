import { z } from "zod";
import type { GitRunner } from "../analyzer/git.js";
import { trendFor } from "../analyzer/probes.js";
import { BudgetExceededError, type ModelProvider } from "../model/provider.js";
import type { PatternsModel } from "../schemas/patterns-model.js";
import type { EvidenceRecord, Verdict } from "../schemas/provenance.js";
import { MONTH_MS } from "../util/time.js";
import { HIGH_AUTHORITY } from "./authority.js";
import type { Cluster } from "./cluster.js";
import { scoreRule } from "./score.js";

export type ReconciledRule = Omit<Cluster, "id"> & {
  id: number | string;
  verdict: Verdict;
  contestedReason?: string; // set iff verdict === "contested"
  // Set only for 3b conflict-pair contested outcomes: the OTHER rule's id in the
  // pair, so a downstream consumer (synthesize) can merge the two into one
  // ContestedItem with both sides instead of emitting two separate items for what
  // is really one disagreement. 3a-only contested rules (no conflicting cluster)
  // never get this set.
  contestedWith?: number | string;
  probeResult?: { token: string; head: number; recent: number; prior: number };
  exemplars: string[];
  syntheticScore?: number;
};

const ReconciliationDraftSchema = z.object({
  proposals: z.array(
    z.object({
      clusterId: z.number().int().min(0),
      proposedVerdict: z.enum(["corroborated", "trending-toward", "unobservable", "trending-away", "contradicted-stable"]),
      probeToken: z.string().min(1).optional(),
      probeExpectation: z.enum(["presence-supports", "presence-contradicts"]).optional(),
    }),
  ),
});
type ReconciliationDraft = z.infer<typeof ReconciliationDraftSchema>;
type Proposal = ReconciliationDraft["proposals"][number];

const SYSTEM = `You review a set of proposed engineering conventions ("clusters") against a
summary of the repo's structural patterns model. For each cluster, propose a verdict: one of
corroborated, trending-toward, unobservable, trending-away, contradicted-stable. If the cluster's
claim concerns a specific token that can be searched for in the codebase (an API name, function,
import, config key, etc.), supply probeToken (the exact token to search for) and probeExpectation:
"presence-supports" if the token's presence in the code supports the claim, "presence-contradicts"
if the claim asserts the token should NOT appear. Respond with ONLY JSON matching the schema.`;

const CONTESTED_SCORE_THRESHOLD = 0.3;

function buildPrompt(clusters: Cluster[], patterns: PatternsModel): string {
  const metaLine = `meta: languages=${patterns.meta.languages.join(",")} frameworks=${patterns.meta.frameworks.join(",")} tooling=${patterns.meta.tooling.join(",")}`;
  const areaLines = patterns.areas.map((a) => `${a.path} (${a.stack.join("/")}, ${a.recencyScore})`);
  const patternLines = patterns.patterns.map((p) => `- ${p.statement}`);
  const migrationLines = patterns.migrations.map(
    (m) => `${m.from} -> ${m.to} (${m.status}, ${m.evidence.trend})`,
  );
  const clusterLines = clusters.map((c) => `[${c.id}] ${c.statement} (${c.polarity}, ${c.category})`);
  return [metaLine, ...areaLines, ...patternLines, ...migrationLines, "", ...clusterLines].join("\n");
}

function hasRecentHighAuthorityEvidence(evidence: EvidenceRecord[], now: number): boolean {
  return evidence.some((e) => {
    if (!e.verified || !HIGH_AUTHORITY.has(e.association)) return false;
    const ageMs = now - new Date(e.createdAt).getTime();
    return ageMs <= 6 * MONTH_MS;
  });
}

async function applyProbeRule(
  git: GitRunner,
  repoPath: string,
  now: () => number,
  excludes: string[] | undefined,
  token: string,
  expectation: "presence-supports" | "presence-contradicts",
): Promise<{ verdict: Verdict; probeResult: { token: string; head: number; recent: number; prior: number } }> {
  const probe = await trendFor(git, repoPath, token, now, excludes);
  let verdict: Verdict;
  if (expectation === "presence-supports") {
    verdict = probe.head === 0 ? "contradicted-stable" : probe.trend === "falling" ? "trending-away" : "corroborated";
  } else {
    verdict = probe.head === 0 ? "corroborated" : probe.trend === "falling" ? "trending-toward" : "trending-away";
  }
  return {
    verdict,
    probeResult: { token, head: probe.head, recent: probe.recent, prior: probe.prior },
  };
}

export async function reconcileClusters(
  clusters: Cluster[],
  conflictPairs: [number, number][],
  patterns: PatternsModel,
  deps: { provider: ModelProvider; git: GitRunner; repoPath: string; now: () => number; excludes?: string[] },
): Promise<ReconciledRule[]> {
  const { provider, git, repoPath, now, excludes } = deps;

  let draft: ReconciliationDraft;
  try {
    draft = await provider.complete({
      system: SYSTEM,
      prompt: buildPrompt(clusters, patterns),
      schema: ReconciliationDraftSchema,
      maxTokens: 4096,
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    draft = { proposals: [] };
  }

  const proposalByCluster = new Map<number, Proposal>();
  for (const p of draft.proposals) {
    if (!proposalByCluster.has(p.clusterId)) proposalByCluster.set(p.clusterId, p);
  }

  const rules: ReconciledRule[] = [];
  const ruleByClusterId = new Map<number, ReconciledRule>();

  for (const cluster of clusters) {
    const proposal = proposalByCluster.get(cluster.id);
    let verdict: Verdict;
    let probeResult: ReconciledRule["probeResult"];

    if (proposal?.probeToken) {
      const expectation = proposal.probeExpectation ?? "presence-supports";
      const result = await applyProbeRule(git, repoPath, now, excludes, proposal.probeToken, expectation);
      verdict = result.verdict;
      probeResult = result.probeResult;
    } else if (proposal && (proposal.proposedVerdict === "corroborated" || proposal.proposedVerdict === "unobservable")) {
      // No-probe rule: the model may only assert these two values without probe evidence;
      // any other proposal (or no proposal at all) demotes to "unobservable".
      verdict = proposal.proposedVerdict;
    } else {
      verdict = "unobservable";
    }

    const rule: ReconciledRule = {
      ...cluster,
      verdict,
      exemplars: [],
      ...(probeResult ? { probeResult } : {}),
    };
    rules.push(rule);
    ruleByClusterId.set(cluster.id, rule);
  }

  // Contested overrides (code-only), run after the probe/no-probe rules above.
  // 3a: recent maintainer guidance contradicting a code-driven demotion → contested.
  for (const rule of rules) {
    if (rule.verdict !== "trending-away" && rule.verdict !== "contradicted-stable") continue;
    if (!hasRecentHighAuthorityEvidence(rule.evidence, now())) continue;
    rule.verdict = "contested";
    rule.contestedReason = "recent maintainer guidance contradicts code trend";
  }

  // 3b: conflicting-guidance pairs, scored on each side's CURRENT verdict.
  for (const [a, b] of conflictPairs) {
    const ruleA = ruleByClusterId.get(a);
    const ruleB = ruleByClusterId.get(b);
    if (!ruleA || !ruleB) continue;

    // Contested is sticky: a side already contested (3a) must never be silently
    // resolved by the score comparison — corroborationOf(contested)=0 would make
    // it lose every pairing. Instead the conflict drags the other side in too,
    // and the already-contested side keeps its existing contestedReason.
    if (ruleA.verdict === "contested" || ruleB.verdict === "contested") {
      if (ruleA.verdict !== "contested") {
        ruleA.verdict = "contested";
        ruleA.contestedReason = "conflicting guidance";
      }
      if (ruleB.verdict !== "contested") {
        ruleB.verdict = "contested";
        ruleB.contestedReason = "conflicting guidance";
      }
      ruleA.contestedWith = ruleB.id;
      ruleB.contestedWith = ruleA.id;
      continue;
    }

    const scoreA = scoreRule(ruleA.evidence, ruleA.verdict, now());
    const scoreB = scoreRule(ruleB.evidence, ruleB.verdict, now());

    if (scoreA >= CONTESTED_SCORE_THRESHOLD && scoreB >= CONTESTED_SCORE_THRESHOLD) {
      ruleA.verdict = "contested";
      ruleA.contestedReason = "conflicting guidance";
      ruleB.verdict = "contested";
      ruleB.contestedReason = "conflicting guidance";
      ruleA.contestedWith = ruleB.id;
      ruleB.contestedWith = ruleA.id;
    } else if (scoreA === scoreB) {
      // Tie below threshold: both contested.
      ruleA.verdict = "contested";
      ruleA.contestedReason = "conflicting guidance";
      ruleB.verdict = "contested";
      ruleB.contestedReason = "conflicting guidance";
      ruleA.contestedWith = ruleB.id;
      ruleB.contestedWith = ruleA.id;
    } else if (scoreA < scoreB) {
      ruleA.verdict = "trending-away";
    } else {
      ruleB.verdict = "trending-away";
    }
  }

  return rules;
}

const SIGNIFICANT_WORD_MIN_LENGTH = 5;

function significantWords(statement: string): Set<string> {
  const tokens = statement.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(tokens.filter((t) => t.length >= SIGNIFICANT_WORD_MIN_LENGTH));
}

export function mergeCodeOnlyPatterns(rules: ReconciledRule[], patterns: PatternsModel): ReconciledRule[] {
  const ruleWordSets = rules.map((r) => significantWords(r.statement));
  const synthetic: ReconciledRule[] = [];
  let n = 0;

  for (const pattern of patterns.patterns) {
    const patternWords = significantWords(pattern.statement);
    const covered = ruleWordSets.some((words) => {
      for (const w of patternWords) if (words.has(w)) return true;
      return false;
    });
    if (covered) continue;

    synthetic.push({
      id: `code-${n}`,
      statement: pattern.statement,
      category: "architecture",
      polarity: "prescriptive",
      scope: pattern.scope,
      evidence: [],
      exemplars: pattern.exemplars,
      verdict: "corroborated",
      syntheticScore: 0.3 + 0.4 * pattern.confidence,
    });
    n++;
  }

  return [...rules, ...synthetic];
}

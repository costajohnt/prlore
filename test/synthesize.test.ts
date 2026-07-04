import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BudgetExceededError, type CompleteOptions, type ModelProvider } from "../src/model/provider.js";
import { synthesize, type SynthesizeDeps } from "../src/reconciler/synthesize.js";
import { INCLUDE_THRESHOLD } from "../src/reconciler/score.js";
import type { DocPlan } from "../src/reconciler/select.js";
import type { CandidateLearning } from "../src/schemas/candidate-learning.js";
import { MineConfigSchema } from "../src/schemas/mine-config.js";
import type { NormalizedPr } from "../src/schemas/normalized-pr.js";
import type { PatternsModel } from "../src/schemas/patterns-model.js";
import { ProvenanceSchema } from "../src/schemas/provenance.js";
import type { Checkpoint } from "../src/schemas/checkpoint.js";
import { loadCheckpoint, saveCheckpoint } from "../src/state/checkpoint.js";
import { buildFixtureRepo } from "./helpers/fixture-repo.js";

const NOW = new Date("2026-07-01T00:00:00Z").getTime();
const now = () => NOW;

// ---- fixture candidates + fake PRs (verifyEvidence runs for real) ---------

const QUOTE_C1 = "please always use oldApi for every widget we ship";
const QUOTE_C2 = "we should use newApi for all new modules going forward";
const QUOTE_C3 = "remember to update the changelog on every single release";

function mkCandidates(c1CreatedAt = "2023-06-01T00:00:00Z"): CandidateLearning[] {
  return [
    {
      statement: "Always use oldApi for widgets",
      category: "style",
      polarity: "prescriptive",
      scope: [],
      evidence: [
        { pr: 1, author: "owner1", association: "OWNER", quote: QUOTE_C1, createdAt: c1CreatedAt },
      ],
    },
    {
      statement: "Use newApi for new modules",
      category: "architecture",
      polarity: "prescriptive",
      scope: [],
      evidence: [
        { pr: 2, author: "owner1", association: "OWNER", quote: QUOTE_C2, createdAt: "2026-06-01T00:00:00Z" },
      ],
    },
    {
      statement: "Update the changelog on every release",
      category: "process",
      polarity: "prescriptive",
      scope: [],
      evidence: [
        { pr: 3, author: "member1", association: "MEMBER", quote: QUOTE_C3, createdAt: "2026-05-01T00:00:00Z" },
      ],
    },
  ];
}

// Fix 2 makes evidence.createdAt corpus-ground-truth: once a quote verifies against
// a PR, the PR's own mergedAt/updatedAt (not the model's claimed date) drives
// staleness. updatedAt is therefore a parameter so each test's PR-1 fixture can
// carry the date its scenario actually needs (stale vs. recent).
function mkPr(number: number, body: string, updatedAt = "2026-06-01T00:00:00Z"): NormalizedPr {
  return {
    number,
    title: `PR ${number}`,
    body,
    author: "someone",
    authorAssociation: "OWNER",
    state: "MERGED",
    mergedAt: null,
    updatedAt,
    labels: [],
    files: [],
    threads: [],
    reviews: [],
    comments: [],
  };
}

// PR 1 (oldApi) is genuinely stale (2023) — matches the §11 stale-demotion scenario
// used by Tests 1, 2, and 4. Test 3 (recent maintainer guidance) builds its own
// PR-1 fixture with a recent date instead of reusing this one.
const prs: NormalizedPr[] = [
  mkPr(1, `Reviewing the widget code. ${QUOTE_C1}. Thanks!`, "2023-06-01T00:00:00Z"),
  mkPr(2, `Architecture note: ${QUOTE_C2}, no exceptions.`),
  mkPr(3, `Process reminder: ${QUOTE_C3} before tagging.`),
];

// One code-only pattern NOT covered by any candidate statement -> synthetic rule "code-0".
const patterns: PatternsModel = {
  areas: [],
  patterns: [
    { statement: "Prefer composition over inheritance", scope: [], exemplars: ["src/b.ts"], confidence: 0.5 },
  ],
  migrations: [],
  meta: { languages: [], frameworks: [], tooling: [] },
};

// ---- scripted fake provider ------------------------------------------------

// Global cluster ids follow the fixed category enumeration order (style,
// architecture, testing, process, tooling, domain), one candidate per bucket:
//   0 = c1 (style), 1 = c2 (architecture), 2 = c3 (process).
const reconcileDraft = {
  proposals: [
    // anti-vacuous: the model claims corroborated; the probe (oldApi head 5, falling) must override
    { clusterId: 0, proposedVerdict: "corroborated", probeToken: "oldApi", probeExpectation: "presence-supports" },
    { clusterId: 1, proposedVerdict: "corroborated" },
    { clusterId: 2, proposedVerdict: "unobservable" },
  ],
};

const defaultPlan: DocPlan = {
  title: "Fixture Conventions",
  overview: "How we build the fixture project.",
  perArea: false,
  sections: [
    { heading: "Core", ruleIds: ["1", "code-0"] },
    { heading: "Process", ruleIds: ["2"] },
  ],
};

function scriptedProvider(planFor: (prompt: string) => DocPlan = () => defaultPlan) {
  let calls = 0;
  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      calls++;
      if (prompt.startsWith("intent:")) return planFor(prompt) as T; // plan call
      if (prompt.startsWith("meta:")) return reconcileDraft as T; // reconcile call
      if (prompt.startsWith("dedupe:")) return { mergeSets: [] } as T; // dedup call: no-op by default
      // cluster call: one group per "[i] statement (polarity)" candidate line
      const lines = prompt.split("\n").filter((l) => /^\[\d+\]/.test(l));
      const groups = lines.map((line, i) => ({
        memberIndexes: [i],
        canonicalStatement: line.replace(/^\[\d+\]\s*/, "").replace(/ \((?:prescriptive|proscriptive)\)$/, ""),
      }));
      return { groups } as T;
    },
  };
  return { provider, callCount: () => calls };
}

const baseConfig = MineConfigSchema.parse({ repo: "acme/widgets", intent: "help new contributors" });

function mkCheckpoint(stage: Checkpoint["stage"]): Checkpoint {
  return { configHash: "abc", stage, cursor: null, overflowQueue: [], maxUpdatedAt: null, counters: {} };
}

// ---- Test 1: end-to-end + MUST-PASS §11 stale demotion ---------------------

test("end-to-end: stale oldApi rule is probe-demoted into provenance.dropped, draft carries surviving + synthetic rules, files and checkpoint land", async () => {
  const repo = await buildFixtureRepo();
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-synth-"));
  await saveCheckpoint(stateDir, mkCheckpoint("analyzing"));
  const { provider, callCount } = scriptedProvider();
  const candidates = mkCandidates(); // c1 OWNER evidence from 2023-06-01: stale

  const deps: SynthesizeDeps = { provider, repoPath: repo, now, stateDir };
  const { draft, provenance, contested } = await synthesize(baseConfig, patterns, candidates, prs, deps);

  // draft: surviving PR-derived rule + code-only synthetic pattern present, stale rule absent
  expect(draft).toContain("Use newApi for new modules");
  expect(draft).toContain("Prefer composition over inheritance");
  expect(draft).not.toContain("Always use oldApi for widgets");

  // stale demotion with provenance retained: probe decided trending-away, score below threshold
  const droppedC1 = provenance.dropped.find((r) => r.id === "0");
  expect(droppedC1).toBeDefined();
  expect(droppedC1!.statement).toBe("Always use oldApi for widgets");
  expect(droppedC1!.verdict).toBe("trending-away"); // probe overrode the model's "corroborated"
  expect(droppedC1!.score).toBeLessThan(INCLUDE_THRESHOLD);
  expect(droppedC1!.evidence).toHaveLength(1); // RuleRecord kept whole

  // three-way split disjoint; rules sorted score desc
  expect(contested).toEqual([]);
  expect(provenance.contested).toEqual([]);
  const ruleIds = provenance.rules.map((r) => r.id);
  expect(ruleIds).not.toContain("0");
  expect(new Set(ruleIds)).toEqual(new Set(["1", "2", "code-0"]));
  for (let i = 1; i < provenance.rules.length; i++) {
    expect(provenance.rules[i]!.score).toBeLessThanOrEqual(provenance.rules[i - 1]!.score);
  }

  // synthetic rule uses syntheticScore; corroborated rules get lastCorroborated = now-ISO
  const synthetic = provenance.rules.find((r) => r.id === "code-0")!;
  expect(synthetic.score).toBeCloseTo(0.3 + 0.4 * 0.5, 5);
  expect(synthetic.exemplars).toEqual(["src/b.ts"]);
  expect(synthetic.lastCorroborated).toBe(new Date(NOW).toISOString());
  expect(provenance.rules.find((r) => r.id === "1")!.lastCorroborated).toBe(new Date(NOW).toISOString());
  expect(provenance.rules.find((r) => r.id === "2")!.lastCorroborated).toBeNull(); // unobservable

  // schema round-trip
  expect(ProvenanceSchema.parse(JSON.parse(JSON.stringify(provenance)))).toEqual(provenance);
  expect(provenance.generatedAt).toBe(new Date(NOW).toISOString());
  expect(provenance.intent).toBe(baseConfig.intent);

  // on-disk artifacts equal returned values
  expect(await readFile(join(stateDir, "draft.md"), "utf8")).toBe(draft);
  expect(JSON.parse(await readFile(join(stateDir, "provenance.json"), "utf8"))).toEqual(provenance);

  // guarded stage flip: analyzing -> ready-for-preview
  const cp = await loadCheckpoint(stateDir);
  expect(cp!.stage).toBe("ready-for-preview");

  // provider economy: 3 non-empty buckets + reconcile + dedup + plan (v0.3 Task 3:
  // buckets + 3)
  expect(callCount()).toBe(6);
});

// ---- Test 2: MUST-PASS §11 different intents -> different docs -------------

test("different intents produce different docs from the same unchanged candidates", async () => {
  const repo = await buildFixtureRepo();
  const candidates = mkCandidates();
  const preCopy = structuredClone(candidates);

  const planFor = (prompt: string): DocPlan =>
    prompt.includes("onboard an AI agent")
      ? {
          title: "AI Agent Onboarding",
          overview: "Ground rules for agents working in this repo.",
          perArea: false,
          sections: [
            { heading: "Start here", ruleIds: ["1"] },
            { heading: "Code patterns", ruleIds: ["code-0", "2"] },
          ],
        }
      : {
          title: "Best Practices Enforcement",
          overview: "Rules to enforce in review.",
          perArea: false,
          sections: [{ heading: "Enforced rules", ruleIds: ["2", "1", "code-0"] }],
        };

  const configA = MineConfigSchema.parse({ repo: "acme/widgets", intent: "onboard an AI agent" });
  const configB = MineConfigSchema.parse({ repo: "acme/widgets", intent: "enforce best practices" });

  const provA = scriptedProvider(planFor);
  const resA = await synthesize(configA, patterns, candidates, prs, { provider: provA.provider, repoPath: repo, now });
  const provB = scriptedProvider(planFor);
  const resB = await synthesize(configB, patterns, candidates, prs, { provider: provB.provider, repoPath: repo, now });

  expect(resA.draft).not.toBe(resB.draft);
  expect(resA.draft).toContain("# AI Agent Onboarding");
  expect(resB.draft).toContain("# Best Practices Enforcement");
  expect(resA.draft).not.toContain("# Best Practices Enforcement");
  expect(resB.draft).not.toContain("# AI Agent Onboarding");
  expect(resA.draft).toContain("Use newApi for new modules");
  expect(resB.draft).toContain("Use newApi for new modules");
  expect(resA.provenance.intent).toBe("onboard an AI agent");
  expect(resB.provenance.intent).toBe("enforce best practices");

  // ADR 003: the same extraction is reused across intents — inputs must not be mutated
  expect(candidates).toEqual(preCopy);
});

// ---- Test 3: contested end-to-end ------------------------------------------

test("recent maintainer guidance against the code trend lands in contested, in neither rules nor dropped, and renders the contested section", async () => {
  const repo = await buildFixtureRepo();
  const { provider } = scriptedProvider();
  const candidates = mkCandidates("2026-06-15T00:00:00Z"); // recent OWNER evidence -> 3a fires
  // Fix 2: createdAt is corpus ground truth once a quote verifies, so this scenario
  // needs its own PR-1 fixture dated recently (the shared `prs` PR-1 is stale, for
  // the §11 stale-demotion tests) rather than reusing the module-level `prs`.
  const recentPrs: NormalizedPr[] = [
    mkPr(1, `Reviewing the widget code. ${QUOTE_C1}. Thanks!`, "2026-06-15T00:00:00Z"),
    ...prs.slice(1),
  ];

  const { draft, provenance, contested } = await synthesize(baseConfig, patterns, candidates, recentPrs, {
    provider,
    repoPath: repo,
    now,
  });

  expect(draft).toContain("## Needs your call (contested)");
  expect(draft).toContain("Always use oldApi for widgets");

  // Fix 6: a 3a-only contested rule (no conflicting cluster) gets a single item;
  // since a code-trend probe ran (probeToken "oldApi"), a second evidence-free
  // side is appended describing what the maintainer's guidance is contesting.
  expect(contested).toHaveLength(1);
  expect(contested[0]!.id).toBe("0");
  expect(contested[0]!.statement).toBe("Always use oldApi for widgets");
  expect(contested[0]!.reason).toContain("maintainer");
  expect(contested[0]!.sides).toHaveLength(2);
  expect(contested[0]!.sides[0]!.statement).toBe("Always use oldApi for widgets");
  expect(contested[0]!.sides[0]!.evidence).toHaveLength(1);
  expect(contested[0]!.sides[1]!.statement).toBe("code trend: oldApi head 5, recent 1 vs prior 2");
  expect(contested[0]!.sides[1]!.evidence).toEqual([]);
  expect(provenance.contested).toEqual(contested);

  // disjoint three-way split: contested appears in NEITHER rules NOR dropped
  expect(provenance.rules.some((r) => r.id === "0")).toBe(false);
  expect(provenance.dropped.some((r) => r.id === "0")).toBe(false);
});

// ---- Test 4: stage guard ----------------------------------------------------

test("checkpoint at a non-analyzing stage is untouched; missing checkpoint and missing stateDir are tolerated", async () => {
  const repo = await buildFixtureRepo();
  const candidates = mkCandidates();

  // pre-seeded at "fetching": run must not flip it
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-synth-guard-"));
  await saveCheckpoint(stateDir, mkCheckpoint("fetching"));
  const provA = scriptedProvider();
  await synthesize(baseConfig, patterns, candidates, prs, { provider: provA.provider, repoPath: repo, now, stateDir });
  const cp = await loadCheckpoint(stateDir);
  expect(cp!.stage).toBe("fetching");
  // artifacts still written; only the stage flip is guarded
  expect(await readFile(join(stateDir, "draft.md"), "utf8")).toContain("Use newApi for new modules");

  // stateDir given but NO checkpoint: tolerated, and none is invented
  const emptyDir = await mkdtemp(join(tmpdir(), "prlore-synth-nocp-"));
  const provB = scriptedProvider();
  await synthesize(baseConfig, patterns, candidates, prs, { provider: provB.provider, repoPath: repo, now, stateDir: emptyDir });
  expect(await loadCheckpoint(emptyDir)).toBeNull();

  // no stateDir at all: returns fine
  const provC = scriptedProvider();
  const res = await synthesize(baseConfig, patterns, candidates, prs, { provider: provC.provider, repoPath: repo, now });
  expect(res.draft.length).toBeGreaterThan(0);
  expect(ProvenanceSchema.parse(res.provenance)).toEqual(res.provenance);
});

// ---- Fix 3: stage guard also accepts "synthesizing" ------------------------

test("Fix 3: checkpoint pre-flipped to \"synthesizing\" by a job manager also flips to ready-for-preview", async () => {
  const repo = await buildFixtureRepo();
  const candidates = mkCandidates();
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-synth-synchecking-"));
  await saveCheckpoint(stateDir, mkCheckpoint("synthesizing"));
  const { provider } = scriptedProvider();

  await synthesize(baseConfig, patterns, candidates, prs, { provider, repoPath: repo, now, stateDir });

  const cp = await loadCheckpoint(stateDir);
  expect(cp!.stage).toBe("ready-for-preview");
});

// ---- Fix 4: budget exhaustion surfaces instead of degrading silently -------

test("Fix 4: BudgetExceededError from the reconcile call propagates out of synthesize, not swallowed", async () => {
  const repo = await buildFixtureRepo();
  const candidates = mkCandidates();
  let calls = 0;
  const budgetProvider: ModelProvider = {
    spentUsd: () => 5,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      calls++;
      if (prompt.startsWith("meta:")) throw new BudgetExceededError(5, 5); // reconcile call
      // cluster call: same scripted behavior as scriptedProvider()
      const lines = prompt.split("\n").filter((l) => /^\[\d+\]/.test(l));
      const groups = lines.map((line, i) => ({
        memberIndexes: [i],
        canonicalStatement: line.replace(/^\[\d+\]\s*/, "").replace(/ \((?:prescriptive|proscriptive)\)$/, ""),
      }));
      return { groups } as T;
    },
  };

  await expect(
    synthesize(baseConfig, patterns, candidates, prs, { provider: budgetProvider, repoPath: repo, now }),
  ).rejects.toBeInstanceOf(BudgetExceededError);
  expect(calls).toBeGreaterThan(0); // clustering did run before the budget-exhausted reconcile call
});

test("Fix 4: a cluster-bucket fallback produces a warnings entry", async () => {
  const repo = await buildFixtureRepo();
  const candidates = mkCandidates();
  let calls = 0;
  const flakyClusterProvider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      calls++;
      if (prompt.startsWith("intent:")) return defaultPlan as T; // plan call
      if (prompt.startsWith("meta:")) return reconcileDraft as T; // reconcile call
      if (prompt.startsWith("dedupe:")) return { mergeSets: [] } as T; // dedup call: no-op
      throw new Error("model unavailable for clustering"); // every cluster bucket falls back
    },
  };

  const { warnings } = await synthesize(baseConfig, patterns, candidates, prs, {
    provider: flakyClusterProvider,
    repoPath: repo,
    now,
  });

  // mkCandidates() spans 3 categories (style, architecture, process) -> 3 buckets fall back
  expect(warnings).toEqual(["cluster fallback used for 3 bucket(s)"]);
});

test("Fix 4: no warnings when clustering succeeds without falling back", async () => {
  const repo = await buildFixtureRepo();
  const candidates = mkCandidates();
  const { provider } = scriptedProvider();

  const { warnings } = await synthesize(baseConfig, patterns, candidates, prs, { provider, repoPath: repo, now });

  expect(warnings).toEqual([]);
});

// ---- Fix 6: conflict-pair contested rules merge into ONE ContestedItem ----

test("Fix 6: a 3b conflict-pair contested outcome merges both sides into a single ContestedItem", async () => {
  const repo = await buildFixtureRepo();

  // Two candidates in the same category (style), deliberately conflicting, with
  // asymmetric evidence strength (3 PRs vs 2) so "higher-scored side leads" is
  // unambiguous rather than resolved by a tie-break.
  const mkEvidence = (prNums: number[]) =>
    prNums.map((pr) => ({
      pr, author: "owner1", association: "OWNER" as const,
      quote: `quote body text number ${pr} for indentation style`, createdAt: "2026-06-25T00:00:00Z",
    }));
  const candidates: CandidateLearning[] = [
    { statement: "Use tabs for indentation", category: "style", polarity: "prescriptive", scope: [], evidence: mkEvidence([1, 2]) },
    { statement: "Use spaces for indentation", category: "style", polarity: "proscriptive", scope: [], evidence: mkEvidence([3, 4, 5]) },
  ];
  const conflictPrs: NormalizedPr[] = [1, 2, 3, 4, 5].map((n) => ({
    number: n, title: `PR ${n}`, body: `quote body text number ${n} for indentation style`,
    author: "owner1", authorAssociation: "OWNER", state: "MERGED", mergedAt: "2026-06-25T00:00:00Z",
    updatedAt: "2026-06-25T00:00:00Z", labels: [], files: [], threads: [], reviews: [], comments: [],
  }));

  let clusterCallSeen = false;
  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      if (prompt.startsWith("intent:")) return { title: "T", overview: "", perArea: false, sections: [] } as T; // plan
      if (prompt.startsWith("meta:")) {
        // reconcile: both proposed "corroborated" (no probe) -> strong-enough scores clear 3b's threshold
        return { proposals: [
          { clusterId: 0, proposedVerdict: "corroborated" },
          { clusterId: 1, proposedVerdict: "corroborated" },
        ] } as T;
      }
      // dedup call: both surviving rules here are the two contested-pair halves, so
      // there is nothing eligible to propose (a contested id would be rejected anyway).
      if (prompt.startsWith("dedupe:")) return { mergeSets: [] } as T;
      clusterCallSeen = true;
      return {
        groups: [
          { memberIndexes: [0], canonicalStatement: "Use tabs for indentation", conflictsWithGroup: 1 },
          { memberIndexes: [1], canonicalStatement: "Use spaces for indentation" },
        ],
      } as T;
    },
  };

  const emptyPatterns: PatternsModel = { areas: [], patterns: [], migrations: [], meta: { languages: [], frameworks: [], tooling: [] } };
  const { contested, provenance } = await synthesize(baseConfig, emptyPatterns, candidates, conflictPrs, { provider, repoPath: repo, now });

  expect(clusterCallSeen).toBe(true);
  expect(contested).toHaveLength(1); // ONE item, not two, for the one disagreement
  expect(contested[0]!.id).toBe("0+1"); // lower id first, joined "+"
  expect(contested[0]!.statement).toBe("Use spaces for indentation"); // higher-scored side (3 PRs > 2 PRs) leads
  expect(contested[0]!.reason).toBe("conflicting guidance");
  expect(contested[0]!.sides).toHaveLength(2);
  const sideStatements = contested[0]!.sides.map((s) => s.statement).sort();
  expect(sideStatements).toEqual(["Use spaces for indentation", "Use tabs for indentation"]);
  expect(contested[0]!.sides.find((s) => s.statement === "Use tabs for indentation")!.evidence).toHaveLength(2);
  expect(contested[0]!.sides.find((s) => s.statement === "Use spaces for indentation")!.evidence).toHaveLength(3);
  expect(provenance.contested).toEqual(contested);
});

// ---- v0.3 Task 1: recurrence floor + synthetic exemption -------------------
//
// One rule per bucket keeps cluster ids deterministic (style=0, architecture=1,
// process=2, matching the fixed CATEGORIES enumeration order and skipping the
// empty testing/tooling/domain buckets) without needing a scripted cluster
// response — both the cluster and plan calls are made to fall back to their
// deterministic degradation paths (see cluster.ts's fallbackDraft / select.ts's
// fallbackDraft) by throwing for any prompt that isn't the reconcile ("meta:")
// call, so only the reconcile proposals need to be scripted.

test("Task 1: recurrence floor drops a single-PR CONTRIBUTOR rule but keeps its anti-vacuous twins (1-PR OWNER, 2-PR CONTRIBUTOR) and exempts a synthetic code-only rule", async () => {
  const repo = await buildFixtureRepo();

  const QUOTE_FLOOR = "please rename these temp helper variables to snake case for consistency";
  const QUOTE_OWNER = "always store secrets in vault and never inline them in the codebase";
  const QUOTE_SQUASH_A = "please squash your commits into one before merging this branch";
  const QUOTE_SQUASH_B = "remember to squash commits together before merge every single time";

  const floorCandidates: CandidateLearning[] = [
    {
      statement: "Rename temp variables to snake_case",
      category: "style",
      polarity: "prescriptive",
      scope: [],
      evidence: [
        { pr: 1, author: "contrib1", association: "CONTRIBUTOR", quote: QUOTE_FLOOR, createdAt: "2026-06-15T00:00:00Z" },
      ],
    },
    {
      statement: "Store secrets in vault only",
      category: "architecture",
      polarity: "prescriptive",
      scope: [],
      evidence: [
        { pr: 2, author: "owner1", association: "OWNER", quote: QUOTE_OWNER, createdAt: "2026-06-15T00:00:00Z" },
      ],
    },
    {
      statement: "Squash commits before merging",
      category: "process",
      polarity: "prescriptive",
      scope: [],
      evidence: [
        { pr: 3, author: "contrib1", association: "CONTRIBUTOR", quote: QUOTE_SQUASH_A, createdAt: "2026-06-15T00:00:00Z" },
        { pr: 4, author: "contrib1", association: "CONTRIBUTOR", quote: QUOTE_SQUASH_B, createdAt: "2026-06-15T00:00:00Z" },
      ],
    },
  ];

  const mkFloorPr = (number: number, body: string, association: NormalizedPr["authorAssociation"]): NormalizedPr => ({
    number, title: `PR ${number}`, body, author: "someone", authorAssociation: association,
    state: "MERGED", mergedAt: null, updatedAt: "2026-06-15T00:00:00Z",
    labels: [], files: [], threads: [], reviews: [], comments: [],
  });

  const floorPrs: NormalizedPr[] = [
    mkFloorPr(1, `Style nit: ${QUOTE_FLOOR}. Thanks!`, "CONTRIBUTOR"),
    mkFloorPr(2, `Architecture: ${QUOTE_OWNER}. Non-negotiable.`, "OWNER"),
    mkFloorPr(3, `Process note: ${QUOTE_SQUASH_A}.`, "CONTRIBUTOR"),
    mkFloorPr(4, `Reminder: ${QUOTE_SQUASH_B}.`, "CONTRIBUTOR"),
  ];

  // Uncovered by any candidate statement above (no shared >=5-char word) -> becomes
  // synthetic rule "code-0" via mergeCodeOnlyPatterns, with empty PR evidence.
  const floorPatterns: PatternsModel = {
    areas: [],
    patterns: [
      { statement: "Document every public API endpoint thoroughly", scope: [], exemplars: ["src/api.ts"], confidence: 0.4 },
    ],
    migrations: [],
    meta: { languages: [], frameworks: [], tooling: [] },
  };

  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      if (prompt.startsWith("meta:")) {
        return {
          proposals: [
            { clusterId: 0, proposedVerdict: "corroborated" },
            { clusterId: 1, proposedVerdict: "corroborated" },
            { clusterId: 2, proposedVerdict: "corroborated" },
          ],
        } as T;
      }
      // Dedup call: these three statements share no norm, so no-op is the honest response.
      if (prompt.startsWith("dedupe:")) return { mergeSets: [] } as T;
      // Cluster and plan calls both fall back to their deterministic paths.
      throw new Error("no-op: clustering and planning both fall back deterministically");
    },
  };

  const { draft, provenance } = await synthesize(baseConfig, floorPatterns, floorCandidates, floorPrs, {
    provider,
    repoPath: repo,
    now,
  });

  // Floored: a 1-PR CONTRIBUTOR rule. Its raw score (authority 0.5 x recurrence 0.5 x
  // recency ~1 x corroboration 1 = 0.25) clears INCLUDE_THRESHOLD (0.15) on its own,
  // which is exactly why this must be asserted against dropped/draft rather than
  // just trusting the score comparison — the floor is a genuinely separate gate.
  const floored = provenance.dropped.find((r) => r.statement === "Rename temp variables to snake_case");
  expect(floored).toBeDefined();
  expect(floored!.droppedReason).toBe("recurrence-floor");
  expect(provenance.rules.some((r) => r.statement === "Rename temp variables to snake_case")).toBe(false);
  expect(draft).not.toContain("Rename temp variables to snake_case");

  // Anti-vacuous twin #1: a 1-PR OWNER rule survives — maintainer-tier evidence exempts it.
  const ownerRule = provenance.rules.find((r) => r.statement === "Store secrets in vault only");
  expect(ownerRule).toBeDefined();
  expect(ownerRule!.droppedReason).toBeUndefined();
  expect(draft).toContain("Store secrets in vault only");

  // Anti-vacuous twin #2: a 2-distinct-PR CONTRIBUTOR rule survives — recurrence clears the floor.
  const squashRule = provenance.rules.find((r) => r.statement === "Squash commits before merging");
  expect(squashRule).toBeDefined();
  expect(draft).toContain("Squash commits before merging");

  // Synthetic code-only rule (mergeCodeOnlyPatterns, no PR evidence at all) is exempt.
  const synthetic = provenance.rules.find((r) => r.id === "code-0");
  expect(synthetic).toBeDefined();
  expect(synthetic!.evidence).toEqual([]);
  expect(draft).toContain("Document every public API endpoint thoroughly");

  // Disjoint three-way split still holds: nothing appears in both rules and dropped.
  const ruleIds = new Set(provenance.rules.map((r) => r.id));
  for (const d of provenance.dropped) expect(ruleIds.has(d.id)).toBe(false);
});

// ---- v0.3 Task 2: generality-scoped scoring penalty ------------------------
//
// Two rules with IDENTICAL scoring inputs (2 distinct CONTRIBUTOR-authored PRs each,
// no reconcile proposal so both default to "unobservable") in different category
// buckets (so cluster ids are deterministic: style=0, architecture=1, per the fixed
// CATEGORIES enumeration order). The cluster call tags one bucket's group
// "repo-wide" and the other "site-specific" — the only thing that differs. Base
// score: authority(CONTRIBUTOR)=0.5 x recurrence(2 PRs)=0.75 x corroboration
// (unobservable)=0.6 = 0.225, which clears INCLUDE_THRESHOLD (0.15) on its own, so
// this is a genuine anti-vacuous pair: only the 0.5x site-specific multiplier
// (0.225 x 0.5 = 0.1125 < 0.15) explains the drop, not some other gate (both rules
// have 2 distinct PRs, so Task 1's recurrence floor exempts both regardless).

const GEN_REPO_WIDE_STATEMENT = "Wrap every outbound api call in the shared retry helper";
const GEN_SITE_SPECIFIC_STATEMENT = "Wrap every outbound call through buildCursorSuffix directly";

test("Task 2: a site-specific rule's 0.5x penalty drops it below INCLUDE_THRESHOLD while its scoring-identical repo-wide twin survives; provenance carries the tag", async () => {
  const repo = await buildFixtureRepo();

  const quoteRwA = "please wrap every outbound api call in the shared retry helper";
  const quoteRwB = "remember to wrap every outbound api call in the shared retry helper always";
  const quoteSsA = "please wrap every outbound call through buildcursorsuffix directly";
  const quoteSsB = "remember to wrap every outbound call through buildcursorsuffix directly always";

  const genCandidates: CandidateLearning[] = [
    {
      statement: GEN_REPO_WIDE_STATEMENT,
      category: "style",
      polarity: "prescriptive",
      scope: [],
      evidence: [
        { pr: 10, author: "contrib1", association: "CONTRIBUTOR", quote: quoteRwA, createdAt: "2026-06-20T00:00:00Z" },
        { pr: 11, author: "contrib1", association: "CONTRIBUTOR", quote: quoteRwB, createdAt: "2026-06-20T00:00:00Z" },
      ],
    },
    {
      statement: GEN_SITE_SPECIFIC_STATEMENT,
      category: "architecture",
      polarity: "prescriptive",
      scope: [],
      evidence: [
        { pr: 12, author: "contrib1", association: "CONTRIBUTOR", quote: quoteSsA, createdAt: "2026-06-20T00:00:00Z" },
        { pr: 13, author: "contrib1", association: "CONTRIBUTOR", quote: quoteSsB, createdAt: "2026-06-20T00:00:00Z" },
      ],
    },
  ];

  const mkGenPr = (number: number, quote: string): NormalizedPr => ({
    number, title: `PR ${number}`, body: `Reviewing this. ${quote}. Thanks!`,
    author: "contrib1", authorAssociation: "CONTRIBUTOR", state: "MERGED", mergedAt: null,
    updatedAt: "2026-06-20T00:00:00Z", labels: [], files: [], threads: [], reviews: [], comments: [],
  });
  const genPrs: NormalizedPr[] = [
    mkGenPr(10, quoteRwA), mkGenPr(11, quoteRwB), mkGenPr(12, quoteSsA), mkGenPr(13, quoteSsB),
  ];

  const genPatterns: PatternsModel = { areas: [], patterns: [], migrations: [], meta: { languages: [], frameworks: [], tooling: [] } };

  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      if (prompt.startsWith("intent:")) {
        return { title: "T", overview: "", perArea: false, sections: [{ heading: "All", ruleIds: ["0"] }] } as T;
      }
      if (prompt.startsWith("meta:")) {
        return { proposals: [] } as T; // no proposals -> every cluster defaults to unobservable
      }
      // Dedup call: repo-wide and site-specific are deliberately DIFFERENT norms here
      // (retry helper vs. a specific internal helper), so no-op is the honest response.
      // Must be checked before the cluster-call `includes` branches below, since this
      // prompt's rule list also contains the repo-wide statement text.
      if (prompt.startsWith("dedupe:")) return { mergeSets: [] } as T;
      if (prompt.includes(GEN_REPO_WIDE_STATEMENT)) {
        return { groups: [{ memberIndexes: [0], canonicalStatement: GEN_REPO_WIDE_STATEMENT, generality: "repo-wide" }] } as T;
      }
      return { groups: [{ memberIndexes: [0], canonicalStatement: GEN_SITE_SPECIFIC_STATEMENT, generality: "site-specific" }] } as T;
    },
  };

  const { draft, provenance } = await synthesize(baseConfig, genPatterns, genCandidates, genPrs, {
    provider,
    repoPath: repo,
    now,
  });

  const survivor = provenance.rules.find((r) => r.statement === GEN_REPO_WIDE_STATEMENT);
  expect(survivor).toBeDefined();
  expect(survivor!.generality).toBe("repo-wide");
  expect(survivor!.score).toBeCloseTo(0.225, 4);
  expect(draft).toContain(GEN_REPO_WIDE_STATEMENT);

  const droppedRule = provenance.dropped.find((r) => r.statement === GEN_SITE_SPECIFIC_STATEMENT);
  expect(droppedRule).toBeDefined();
  expect(droppedRule!.generality).toBe("site-specific");
  expect(droppedRule!.score).toBeCloseTo(0.1125, 4);
  expect(droppedRule!.droppedReason).toBeUndefined(); // plain score-threshold drop, not the recurrence floor
  expect(provenance.rules.some((r) => r.statement === GEN_SITE_SPECIFIC_STATEMENT)).toBe(false);
  expect(draft).not.toContain(GEN_SITE_SPECIFIC_STATEMENT);
});

// ---- v0.3 Task 3: cross-bucket dedup pass -----------------------------------
//
// Same underlying norm ("gate TTY-only output"), filed under two different
// categories (style, process) so clusterCandidates' per-bucket buckets never see
// them together — this is exactly the ink-run gap the pass exists to close. Both
// candidates get OWNER evidence (HIGH_AUTHORITY) so the recurrence floor never
// enters into it; only the dedup pass's own merge explains the outcome.

const TTY_STYLE_STATEMENT = "Gate TTY-only output behind an isatty check";
const TTY_PROCESS_STATEMENT = "Don't print ANSI codes unless attached to a terminal";

test("Task 3: same norm filed under two different categories merges into one rule; provenance carries mergedFrom; call count = buckets + 3", async () => {
  const repo = await buildFixtureRepo();

  const quoteStyle = "please gate tty-only output behind an isatty check before printing";
  const quoteProcess = "do not print ansi codes unless we are attached to a terminal";

  const ttyCandidates: CandidateLearning[] = [
    {
      statement: TTY_STYLE_STATEMENT,
      category: "style",
      polarity: "prescriptive",
      scope: [],
      evidence: [{ pr: 20, author: "owner1", association: "OWNER", quote: quoteStyle, createdAt: "2026-06-20T00:00:00Z" }],
    },
    {
      statement: TTY_PROCESS_STATEMENT,
      category: "process",
      polarity: "prescriptive",
      scope: [],
      evidence: [{ pr: 21, author: "owner1", association: "OWNER", quote: quoteProcess, createdAt: "2026-06-20T00:00:00Z" }],
    },
  ];

  const mkTtyPr = (number: number, quote: string): NormalizedPr => ({
    number, title: `PR ${number}`, body: `Reviewing this. ${quote}. Thanks!`,
    author: "owner1", authorAssociation: "OWNER", state: "MERGED", mergedAt: null,
    updatedAt: "2026-06-20T00:00:00Z", labels: [], files: [], threads: [], reviews: [], comments: [],
  });
  const ttyPrs: NormalizedPr[] = [mkTtyPr(20, quoteStyle), mkTtyPr(21, quoteProcess)];

  const ttyPatterns: PatternsModel = { areas: [], patterns: [], migrations: [], meta: { languages: [], frameworks: [], tooling: [] } };

  let calls = 0;
  let dedupePrompt = "";
  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      calls++;
      if (prompt.startsWith("intent:")) {
        return { title: "T", overview: "", perArea: false, sections: [{ heading: "All", ruleIds: ["0"] }] } as T;
      }
      if (prompt.startsWith("meta:")) {
        // Both clusters (style=0, process=1, per the fixed CATEGORIES enumeration
        // order with only style/process non-empty) propose "corroborated", no probe.
        return { proposals: [
          { clusterId: 0, proposedVerdict: "corroborated" },
          { clusterId: 1, proposedVerdict: "corroborated" },
        ] } as T;
      }
      if (prompt.startsWith("dedupe:")) {
        // Both rule ids appear as one-liners in the prompt; propose merging them.
        dedupePrompt = prompt;
        return { mergeSets: [{ ids: [0, 1] }] } as T;
      }
      // cluster call: one singleton group per bucket (one candidate per bucket here)
      return { groups: [{ memberIndexes: [0], canonicalStatement: prompt.replace(/^\[0\]\s*/, "").replace(/ \(prescriptive\)$/, "") }] } as T;
    },
  };

  const { draft, provenance } = await synthesize(baseConfig, ttyPatterns, ttyCandidates, ttyPrs, {
    provider,
    repoPath: repo,
    now,
  });

  expect(dedupePrompt).toContain(`[0] ${TTY_STYLE_STATEMENT}`);
  expect(dedupePrompt).toContain(`[1] ${TTY_PROCESS_STATEMENT}`);

  // Exactly one surviving rule; the absorbed id is gone entirely (not even in dropped).
  expect(provenance.rules).toHaveLength(1);
  expect(provenance.dropped).toHaveLength(0);
  const kept = provenance.rules[0]!;
  expect(kept.id).toBe("0"); // tie-break (equal evidence/PR counts) -> lowest id
  expect(kept.statement).toBe(TTY_STYLE_STATEMENT); // kept member's own statement, not a synthesized one
  expect(kept.mergedFrom).toEqual(["1"]);
  expect(kept.evidence).toHaveLength(2); // union of both rules' evidence
  expect(new Set(kept.evidence.map((e) => e.pr))).toEqual(new Set([20, 21]));

  // The absorbed rule's statement never renders on its own; the kept statement does.
  expect(draft).toContain(TTY_STYLE_STATEMENT);
  expect(draft).not.toContain(TTY_PROCESS_STATEMENT);

  // provider economy: 2 non-empty buckets (style, process) + reconcile + dedup + plan
  expect(calls).toBe(5);
});

// ---- v0.3 Task 4: tiered rendering (maxRules + compact tail) ----------------
//
// Reuses Test 1's exact fixture (candidates/prs/patterns/scriptedProvider) so
// the surviving rules and their scores are already pinned by that test:
// code-0 (synthetic, score 0.5) > "1" (newApi, score ~0.472) > "2" (changelog,
// score 0.3). output.maxRules: 2 puts code-0 and "1" in the full tier and "2"
// alone in the compact tail — the lowest-scored survivor, not an arbitrary one.

test("Task 4: output.maxRules caps full-detail rendering; the seam feeds planDoc only the full tier, so an overflow section reference is dropped and the overflow rule renders compact instead", async () => {
  const repo = await buildFixtureRepo();
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-synth-maxrules-"));
  await saveCheckpoint(stateDir, mkCheckpoint("analyzing"));
  const { provider, callCount } = scriptedProvider(); // defaultPlan puts "2" in a "Process" section
  const candidates = mkCandidates(); // c1 OWNER evidence from 2023-06-01: stale, probe-demoted, dropped
  const cappedConfig = MineConfigSchema.parse({
    repo: "acme/widgets",
    intent: "help new contributors",
    output: { maxRules: 2 },
  });

  const { draft, provenance } = await synthesize(cappedConfig, patterns, candidates, prs, {
    provider,
    repoPath: repo,
    now,
    stateDir,
  });

  // Full tier: rendered inside its planned "Core" section, in full form.
  expect(draft).toContain("## Core");
  expect(draft).toContain("- **Use newApi for new modules**");
  expect(draft).toContain("- **Prefer composition over inheritance**");

  // defaultPlan's "Process" section named ONLY the overflow rule ("2") — planDoc
  // never saw it (fed only the top-2 slice), so enforce() dropped it as an
  // unknown id and the now-empty section vanished rather than rendering "2" in
  // full. This is the seam: planDoc/select receives only the top-maxRules rules.
  expect(draft).not.toContain("## Process");

  // Overflow tier: compact tail, no rationale/bold treatment, own trailing section.
  expect(draft).toContain("## Additional conventions (lower signal)");
  expect(draft).toContain("- Update the changelog on every release");
  expect(draft).not.toContain("**Update the changelog on every release**");

  // Ordering: tail section after the planned sections.
  expect(draft.indexOf("## Additional conventions (lower signal)")).toBeGreaterThan(draft.indexOf("## Core"));

  // provenance.rules is untouched in size/shape by tiering (still full records for
  // every non-dropped, non-contested rule) — only renderedTier is added.
  expect(new Set(provenance.rules.map((r) => r.id))).toEqual(new Set(["1", "2", "code-0"]));
  const byId = new Map(provenance.rules.map((r) => [r.id, r]));
  expect(byId.get("code-0")!.renderedTier).toBe("full");
  expect(byId.get("1")!.renderedTier).toBe("full");
  expect(byId.get("2")!.renderedTier).toBe("compact");

  // A rule never appears in BOTH a planned section's ruleIds and the tail —
  // structural, not just a rendering accident: the id sets are disjoint because
  // they're built from disjoint index slices of the same sorted array.
  const fullTierIds = new Set(provenance.rules.filter((r) => r.renderedTier === "full").map((r) => r.id));
  const compactTierIds = new Set(provenance.rules.filter((r) => r.renderedTier === "compact").map((r) => r.id));
  for (const id of fullTierIds) expect(compactTierIds.has(id)).toBe(false);

  // No extra provider calls: maxRules only changes which rules planDoc/render see,
  // not how many times the provider is invoked (still buckets + reconcile + dedup + plan).
  expect(callCount()).toBe(6);
});

test("Task 4: no tail section at all when every surviving rule fits under output.maxRules (the default, 60)", async () => {
  const repo = await buildFixtureRepo();
  const { provider } = scriptedProvider();
  const candidates = mkCandidates();

  const { draft, provenance } = await synthesize(baseConfig, patterns, candidates, prs, { provider, repoPath: repo, now });

  expect(draft).not.toContain("Additional conventions");
  expect(provenance.rules.every((r) => r.renderedTier === "full")).toBe(true);
});

// ---- Fix: trimToBudget re-arming with a large --max-rules must not lie -----
//
// The README tells users to pass a large --max-rules for "no cap". With maxRules
// set well above the surviving rule count, every rule tiers "full" BEFORE planDoc
// runs (see the seam comment above). If the plan then crams all of them into one
// section, select.ts's enforce()/trimToBudget silently removes the lowest-score
// overflow to stay under its own 400-line budget -- a wholly separate cap from
// output.maxRules. Pre-fix, those trimmed rules keep provenance.renderedTier ===
// "full" while rendering in NEITHER the planned section NOR the compact tail
// (tailRules was computed before enforce() ran, so it never gets them either):
// the tier field lies about where a rule ended up. This test constructs exactly
// that re-armed scenario -- 450 single-PR-OWNER rules, one plan section naming
// all of them (estimate = 6 + 3 + 450 = 459 > 400) -- and asserts every surviving
// rule actually renders where its own renderedTier claims it does.

test("Fix: a trimToBudget-dropped rule is routed into the compact tail, not left claiming renderedTier \"full\" while rendering nowhere", async () => {
  const repo = await buildFixtureRepo();
  const N = 450;

  const trimCandidates: CandidateLearning[] = [];
  const trimPrs: NormalizedPr[] = [];
  for (let i = 0; i < N; i++) {
    const quote = `rule number ${i} requires consistent handling across the whole codebase`;
    trimCandidates.push({
      statement: `Follow convention number ${i} everywhere`,
      category: "style",
      polarity: "prescriptive",
      scope: [],
      evidence: [{ pr: i + 1, author: "owner1", association: "OWNER", quote, createdAt: "2026-06-20T00:00:00Z" }],
    });
    trimPrs.push({
      number: i + 1, title: `PR ${i + 1}`, body: `Review note. ${quote}. Thanks!`,
      author: "owner1", authorAssociation: "OWNER", state: "MERGED", mergedAt: null,
      updatedAt: "2026-06-20T00:00:00Z", labels: [], files: [], threads: [], reviews: [], comments: [],
    });
  }

  const trimPatterns: PatternsModel = { areas: [], patterns: [], migrations: [], meta: { languages: [], frameworks: [], tooling: [] } };

  const trimProvider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      if (prompt.startsWith("intent:")) {
        const ids = Array.from({ length: N }, (_, i) => String(i));
        return { title: "T", overview: "o", perArea: false, sections: [{ heading: "Everything", ruleIds: ids }] } as T;
      }
      if (prompt.startsWith("meta:")) {
        const proposals = Array.from({ length: N }, (_, i) => ({ clusterId: i, proposedVerdict: "corroborated" as const }));
        return { proposals } as T;
      }
      if (prompt.startsWith("dedupe:")) return { mergeSets: [] } as T;
      // cluster call: one singleton group per candidate line, same default scripted shape.
      const lines = prompt.split("\n").filter((l) => /^\[\d+\]/.test(l));
      const groups = lines.map((line, i) => ({
        memberIndexes: [i],
        canonicalStatement: line.replace(/^\[\d+\]\s*/, "").replace(/ \((?:prescriptive|proscriptive)\)$/, ""),
      }));
      return { groups } as T;
    },
  };

  // "no cap" style value: far above the surviving rule count, so every rule
  // tiers "full" before planDoc/enforce ever runs.
  const noCapConfig = MineConfigSchema.parse({
    repo: "acme/widgets",
    intent: "help new contributors",
    output: { maxRules: 1000 },
  });

  const { draft, provenance } = await synthesize(noCapConfig, trimPatterns, trimCandidates, trimPrs, {
    provider: trimProvider,
    repoPath: repo,
    now,
  });

  expect(provenance.rules).toHaveLength(N); // sanity: all 450 clear scoring, none dropped/contested

  // Sanity: the budget trim actually fired for this scenario (not a no-op test) --
  // some of the 450 rules must have been demoted out of the "full" tier.
  const compactTierRules = provenance.rules.filter((r) => r.renderedTier === "compact");
  expect(compactTierRules.length).toBeGreaterThan(0);
  expect(compactTierRules.length).toBeLessThan(N);

  // Every surviving rule must render exactly where its own renderedTier claims:
  // "full" inside its planned section (bold bullet), "compact" as a tail one-liner.
  for (const rule of provenance.rules) {
    if (rule.renderedTier === "full") {
      expect(draft).toContain(`**${rule.statement}**`);
    } else {
      expect(draft).toContain(`- ${rule.statement}`);
    }
  }
});

test("Task 3: a proposal naming a contested id is rejected (both sides survive untouched)", async () => {
  const repo = await buildFixtureRepo();
  const { provider } = scriptedProvider();
  const candidates = mkCandidates("2026-06-15T00:00:00Z"); // recent OWNER evidence -> 3a contested fires for id 0

  const recentPrs: NormalizedPr[] = [
    mkPr(1, `Reviewing the widget code. ${QUOTE_C1}. Thanks!`, "2026-06-15T00:00:00Z"),
    ...prs.slice(1),
  ];

  // A malicious/erroneous dedup proposal naming the contested id (0) alongside a
  // legitimate non-contested one (1) — the whole set must be rejected, not partially
  // applied, and id 0 must still surface as contested rather than silently vanishing.
  const provWithBadProposal: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>(opts: CompleteOptions<T>): Promise<T> {
      if (opts.prompt.startsWith("dedupe:")) return { mergeSets: [{ ids: [0, 1] }] } as T;
      return provider.complete(opts);
    },
  };

  const { provenance, contested } = await synthesize(baseConfig, patterns, candidates, recentPrs, {
    provider: provWithBadProposal,
    repoPath: repo,
    now,
  });

  expect(contested).toHaveLength(1);
  expect(contested[0]!.id).toBe("0");
  expect(provenance.rules.some((r) => r.id === "1")).toBe(true);
  expect(provenance.rules.find((r) => r.id === "1")!.mergedFrom).toBeUndefined();
});

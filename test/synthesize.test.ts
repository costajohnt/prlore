import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { CompleteOptions, ModelProvider } from "../src/model/provider.js";
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

function mkPr(number: number, body: string): NormalizedPr {
  return {
    number,
    title: `PR ${number}`,
    body,
    author: "someone",
    authorAssociation: "OWNER",
    state: "MERGED",
    mergedAt: null,
    updatedAt: "2026-06-01T00:00:00Z",
    labels: [],
    files: [],
    threads: [],
    reviews: [],
    comments: [],
  };
}

const prs: NormalizedPr[] = [
  mkPr(1, `Reviewing the widget code. ${QUOTE_C1}. Thanks!`),
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

  // provider economy: 3 non-empty buckets + reconcile + plan
  expect(callCount()).toBe(5);
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

  const { draft, provenance, contested } = await synthesize(baseConfig, patterns, candidates, prs, {
    provider,
    repoPath: repo,
    now,
  });

  expect(draft).toContain("## Needs your call (contested)");
  expect(draft).toContain("Always use oldApi for widgets");

  expect(contested).toHaveLength(1);
  expect(contested[0]!.id).toBe("0");
  expect(contested[0]!.statement).toBe("Always use oldApi for widgets");
  expect(contested[0]!.reason).toContain("maintainer");
  expect(contested[0]!.sides).toHaveLength(1);
  expect(contested[0]!.sides[0]!.statement).toBe("Always use oldApi for widgets");
  expect(contested[0]!.sides[0]!.evidence).toHaveLength(1);
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

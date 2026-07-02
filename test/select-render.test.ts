import { expect, test } from "vitest";
import { BudgetExceededError, type CompleteOptions, type ModelProvider } from "../src/model/provider.js";
import { planDoc, type DocPlan } from "../src/reconciler/select.js";
import { renderDraft } from "../src/reconciler/render.js";
import { MineConfigSchema } from "../src/schemas/mine-config.js";
import type { PatternsModel } from "../src/schemas/patterns-model.js";
import type { ContestedItem, EvidenceRecord, RuleRecord } from "../src/schemas/provenance.js";

function mkRule(id: string, score: number, opts: Partial<RuleRecord> = {}): RuleRecord {
  return {
    id,
    statement: `statement for ${id}`,
    category: "style",
    polarity: "prescriptive",
    scope: [],
    score,
    verdict: "corroborated",
    evidence: [],
    exemplars: [],
    lastCorroborated: null,
    ...opts,
  };
}

function ev(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    pr: 1,
    author: "someone",
    association: "OWNER",
    quote: "a sufficiently long quote for verification purposes",
    createdAt: "2026-06-01T00:00:00Z",
    verified: true,
    ...overrides,
  };
}

function fakeProvider(draft: unknown) {
  const prompts: string[] = [];
  const p: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      prompts.push(prompt);
      return draft as T;
    },
  };
  return { p, prompts };
}

const emptyAreas: PatternsModel["areas"] = [];

const baseConfig = MineConfigSchema.parse({ repo: "acme/widgets", intent: "help new contributors" });

// ---- Behavior 1: unknown-id dropping + duplicate-id first-wins -----------

test("unknown ruleIds are dropped and a duplicate id keeps only its first occurrence, removing the section if left empty", async () => {
  const rules = [mkRule("r1", 0.9), mkRule("r2", 0.8)];
  const draft: DocPlan = {
    title: "Conventions",
    overview: "overview",
    perArea: false,
    sections: [
      { heading: "Core", ruleIds: ["r1", "ghost", "r2"] },
      { heading: "Extra", ruleIds: ["r2"] },
    ],
  };
  const { p } = fakeProvider(draft);

  const plan = await planDoc(rules, "help new contributors", emptyAreas, p);

  expect(plan.sections).toHaveLength(1); // "Extra" disappears once its only id is stripped as a dup
  expect(plan.sections[0]!.heading).toBe("Core");
  expect(plan.sections[0]!.ruleIds).toEqual(["r1", "r2"]); // "ghost" silently dropped
  expect(plan.sections.some((s) => s.heading === "Extra")).toBe(false);
});

// ---- Behavior 2: high-score rescue ----------------------------------------

test("an omitted rule with score >= 0.5 is rescued into a trailing Other conventions section; a low-score omission stays out entirely", async () => {
  const r1 = mkRule("r1", 0.9);
  const r2 = mkRule("r2", 0.6);
  const r3 = mkRule("r3", 0.2);
  const draft: DocPlan = {
    title: "Conventions",
    overview: "overview",
    perArea: false,
    sections: [{ heading: "Core", ruleIds: ["r1"] }],
  };
  const { p } = fakeProvider(draft);

  const plan = await planDoc([r1, r2, r3], "intent", emptyAreas, p);

  const other = plan.sections.find((s) => s.heading === "Other conventions");
  expect(other).toBeDefined();
  expect(other!.ruleIds).toContain("r2");
  expect(plan.sections.some((s) => s.ruleIds.includes("r3"))).toBe(false); // r3 (score 0.2) in NO section
});

// ---- Behavior 3: line-budget trim -----------------------------------------

test("line-budget trim keeps estimate <= 400 lines by dropping the lowest-score rules first", async () => {
  const rules: RuleRecord[] = [];
  for (let i = 0; i < 500; i++) {
    rules.push(mkRule(`r${i}`, i / 500));
  }
  const draft: DocPlan = {
    title: "Conventions",
    overview: "overview",
    perArea: false,
    sections: [{ heading: "Everything", ruleIds: rules.map((r) => r.id) }],
  };
  const { p } = fakeProvider(draft);

  const plan = await planDoc(rules, "intent", emptyAreas, p);

  const survivingIds = new Set(plan.sections.flatMap((s) => s.ruleIds));
  const estimate = 6 + plan.sections.reduce((sum, s) => sum + 3 + s.ruleIds.length, 0);
  expect(estimate).toBeLessThanOrEqual(400); // budget enforced

  const scoreById = new Map(rules.map((r) => [r.id, r.score]));
  const survivingScores = [...survivingIds].map((id) => scoreById.get(id)!);
  const trimmedScores = rules.filter((r) => !survivingIds.has(r.id)).map((r) => r.score);
  expect(trimmedScores.length).toBeGreaterThan(0); // sanity: something was actually trimmed
  expect(Math.min(...survivingScores)).toBeGreaterThan(Math.max(...trimmedScores)); // highest scores kept
});

// ---- Behavior 3b: provider-throw fallback ---------------------------------

test("provider throw: planDoc degrades to a deterministic score-desc plan that still respects the line budget", async () => {
  const rules: RuleRecord[] = [];
  for (let i = 0; i < 500; i++) {
    rules.push(mkRule(`r${i}`, i / 500));
  }
  const throwing: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>(): Promise<T> {
      throw new Error("model unavailable");
    },
  };

  const plan = await planDoc(rules, "intent", emptyAreas, throwing);

  expect(plan.title).toBe("Project conventions");
  expect(plan.perArea).toBe(false);
  expect(plan.sections).toHaveLength(1);
  expect(plan.sections[0]!.heading).toBe("Conventions");

  const estimate = 6 + plan.sections.reduce((sum, s) => sum + 3 + s.ruleIds.length, 0);
  expect(estimate).toBeLessThanOrEqual(400); // budget trim still applies to the fallback

  const surviving = plan.sections[0]!.ruleIds;
  const scoreById = new Map(rules.map((r) => [r.id, r.score]));
  const survivingScores = surviving.map((id) => scoreById.get(id)!);
  for (let i = 1; i < survivingScores.length; i++) {
    expect(survivingScores[i]!).toBeLessThanOrEqual(survivingScores[i - 1]!); // score-desc order
  }
  const survivingSet = new Set(surviving);
  const trimmedScores = rules.filter((r) => !survivingSet.has(r.id)).map((r) => r.score);
  expect(trimmedScores.length).toBeGreaterThan(0);
  expect(Math.min(...survivingScores)).toBeGreaterThan(Math.max(...trimmedScores)); // top scores kept
});

// ---- Fix 4: BudgetExceededError rethrows instead of falling back ----------

test("Fix 4: BudgetExceededError from the provider propagates out of planDoc, not swallowed into a fallback plan", async () => {
  const rules = [mkRule("r1", 0.9)];
  const budgetProvider: ModelProvider = {
    spentUsd: () => 5,
    async complete<T>(): Promise<T> {
      throw new BudgetExceededError(5, 5);
    },
  };

  await expect(planDoc(rules, "intent", emptyAreas, budgetProvider)).rejects.toBeInstanceOf(BudgetExceededError);
});

// ---- Behavior 4: prompt carries intent verbatim + rule ids ---------------

test("planDoc's prompt carries the intent verbatim and each rule line carries its id", async () => {
  const rules = [mkRule("r1", 0.9, { statement: "use tabs" }), mkRule("r2", 0.4, { statement: "never use var" })];
  const draft: DocPlan = {
    title: "Conventions",
    overview: "overview",
    perArea: false,
    sections: [{ heading: "Core", ruleIds: ["r1"] }],
  };
  const { p, prompts } = fakeProvider(draft);
  const intent = "onboard a new backend engineer to the payments service";

  await planDoc(rules, intent, emptyAreas, p);

  expect(prompts).toHaveLength(1); // ONE LLM call
  expect(prompts[0]).toContain(intent); // intent carried verbatim
  expect(prompts[0]).toContain("[r1]");
  expect(prompts[0]).toContain("[r2]");
});

// ---- Behavior 5: render structural assertions -----------------------------

function smallPlanFixture(): { plan: DocPlan; rules: RuleRecord[]; contested: ContestedItem[] } {
  const rationaled = mkRule("r1", 0.9, {
    statement: "prefer composition",
    rationale: "keeps modules independently testable",
    evidence: [ev({ pr: 7 }), ev({ pr: 3 }), ev({ pr: 3 })], // duplicate pr=3, unsorted -> ascending distinct #3, #7
  });
  const manyPrs = mkRule("r2", 0.8, {
    statement: "avoid global mutable state",
    evidence: [ev({ pr: 10 }), ev({ pr: 20 }), ev({ pr: 30 }), ev({ pr: 40 })], // 4 distinct -> cites only 3
  });
  const unverifiedOnly = mkRule("r3", 0.7, {
    statement: "keep functions short",
    evidence: [ev({ pr: 99, verified: false })],
  });
  const migrating = mkRule("r4", 0.6, {
    statement: "use the new logger",
    verdict: "trending-toward",
    evidence: [ev({ pr: 5 })],
  });

  const plan: DocPlan = {
    title: "Payments Service Conventions",
    overview: "A guide for new contributors.",
    perArea: false,
    sections: [{ heading: "Architecture", ruleIds: ["r1", "r2", "r3", "r4"] }],
  };
  const contested: ContestedItem[] = [
    { id: "c1", statement: "should we use REST or GraphQL", reason: "maintainers disagree", sides: [] },
  ];
  return { plan, rules: [rationaled, manyPrs, unverifiedOnly, migrating], contested };
}

test("renderDraft produces the documented structure: header comment, title, headings, citations, migration prefix, contested section", () => {
  const { plan, rules, contested } = smallPlanFixture();

  const out = renderDraft(plan, rules, contested, baseConfig);

  expect(out.startsWith("<!-- generated by prlore -->")).toBe(true);
  expect(out).toContain("# Payments Service Conventions");
  expect(out).toContain("## Architecture");
  expect(out).toContain("- **prefer composition** — keeps modules independently testable _(#3, #7)_"); // ascending, distinct
  expect(out).toContain("_(#10, #20, #30)_"); // 4 distinct PRs -> cites only the first 3
  expect(out).not.toContain("#40");
  expect(out).toContain("- **keep functions short**"); // unverified-only evidence
  expect(out).not.toContain("keep functions short** _("); // no citation parens for unverified-only evidence
  expect(out).toContain("- **[migration in progress]** use the new logger"); // trending-toward prefix
  expect(out).toContain("## Needs your call (contested)");
  expect(out).toContain("- should we use REST or GraphQL — maintainers disagree");
});

test("renderDraft omits the contested section entirely when there is nothing contested", () => {
  const { plan, rules } = smallPlanFixture();

  const out = renderDraft(plan, rules, [], baseConfig);

  expect(out).not.toContain("Needs your call");
});

// ---- Fix 7: render sanitizer against markdown injection -------------------

test("Fix 7: a newline-smuggled heading in a statement renders on one line with no injected heading", () => {
  const injected = mkRule("r1", 0.9, { statement: "evil\n## Injected" });
  const plan: DocPlan = { title: "T", overview: "o", perArea: false, sections: [{ heading: "Core", ruleIds: ["r1"] }] };

  const out = renderDraft(plan, [injected], [], baseConfig);

  expect(out).not.toMatch(/\n## Injected/);
  expect(out).toContain("evil ## Injected"); // collapsed onto one line, whitespace-joined
  const lines = out.split("\n");
  expect(lines.filter((l) => l.startsWith("## "))).toEqual(["## Core"]); // no extra heading line
});

test("Fix 7: an HTML comment marker in a statement is stripped so it can't close/reopen a structural comment", () => {
  const injected = mkRule("r1", 0.9, { statement: "close it <!-- prlore:end --> then more" });
  const plan: DocPlan = { title: "T", overview: "o", perArea: false, sections: [{ heading: "Core", ruleIds: ["r1"] }] };

  const out = renderDraft(plan, [injected], [], baseConfig);

  // Only the ONE static generator-header comment marker may remain; the
  // model-derived statement's markers must be stripped.
  expect(out.split("<!--").length - 1).toBe(1);
  expect(out.split("-->").length - 1).toBe(1);
  expect(out).toContain("close it  prlore:end  then more");
});

test("Fix 7: sanitizer applies to rationale, title, overview, section heading, and contested statement/reason", () => {
  const rule = mkRule("r1", 0.9, { statement: "clean", rationale: "bad\n## heading in rationale" });
  const plan: DocPlan = {
    title: "Title\n## injected",
    overview: "overview <!-- prlore:end -->",
    perArea: false,
    sections: [{ heading: "Section\nheading", ruleIds: ["r1"] }],
  };
  const contested: ContestedItem[] = [
    { id: "c1", statement: "statement\n## boom", reason: "reason <!-- x -->", sides: [] },
  ];

  const out = renderDraft(plan, [rule], contested, baseConfig);

  expect(out).not.toContain("\n## injected");
  expect(out).not.toContain("\n## boom");
  expect(out).not.toContain("\n## heading in rationale");
  // Only the ONE static generator-header comment marker may remain.
  expect(out.split("<!--").length - 1).toBe(1);
  expect(out.split("-->").length - 1).toBe(1);
  expect(out).toContain("# Title ## injected");
  expect(out).toContain("overview  prlore:end");
  expect(out).toContain("## Section heading");
  expect(out).toContain("bad ## heading in rationale");
  expect(out).toContain("statement ## boom — reason  x");
});

// ---- Behavior 6: sidecar-only mode ----------------------------------------

test("sidecar-only citations mode never emits inline citation parens", () => {
  const { plan, rules, contested } = smallPlanFixture();
  const sidecarConfig = { ...baseConfig, output: { ...baseConfig.output, citations: "sidecar-only" as const } };

  const out = renderDraft(plan, rules, contested, sidecarConfig);

  expect(out).not.toContain("_(#");
  expect(out).toContain("- **prefer composition** — keeps modules independently testable"); // rationale still renders
});

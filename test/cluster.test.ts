import { expect, test } from "vitest";
import type { CompleteOptions, ModelProvider } from "../src/model/provider.js";
import type { VerifiedCandidate } from "../src/reconciler/verify-evidence.js";
import { clusterCandidates } from "../src/reconciler/cluster.js";

interface Draft {
  groups: {
    memberIndexes: number[];
    canonicalStatement: string;
    conflictsWithGroup?: number;
  }[];
}

type Script = Draft | "throw";

function fakeProvider(scripts: Script[]) {
  const prompts: string[] = [];
  let call = 0;
  const p: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      prompts.push(prompt);
      const script = scripts[call] ?? scripts[scripts.length - 1]!;
      call++;
      if (script === "throw") throw new Error("model unavailable");
      return script as unknown as T;
    },
  };
  return { p, prompts, callCount: () => call };
}

let quoteSeq = 0;
function cand(statement: string, opts: Partial<Omit<VerifiedCandidate, "statement">> = {}): VerifiedCandidate {
  quoteSeq++;
  return {
    statement,
    category: "style",
    scope: [],
    polarity: "prescriptive",
    evidence: [
      {
        pr: 1,
        author: "a",
        association: "OWNER",
        quote: `quote-${quoteSeq}-${statement.slice(0, 12)}`,
        createdAt: "2026-01-01T00:00:00Z",
        verified: true,
      },
    ],
    ...opts,
  };
}

test("same-norm grouping + singleton for unassigned", async () => {
  const c0 = cand("Use exponential backoff on retries");
  const c1 = cand("Retry with exponential backoff");
  const c2 = cand("Log all errors to stderr");
  const draft: Draft = {
    groups: [{ memberIndexes: [0, 1], canonicalStatement: "Use exponential backoff" }],
  };
  const { p } = fakeProvider([draft]);

  const { clusters, conflictPairs } = await clusterCandidates([c0, c1, c2], p);

  expect(clusters).toHaveLength(2);
  const grouped = clusters.find((cl) => cl.statement === "Use exponential backoff");
  expect(grouped).toBeDefined();
  const quotes = grouped!.evidence.map((e) => e.quote).sort();
  expect(quotes).toEqual([c0.evidence[0]!.quote, c1.evidence[0]!.quote].sort());

  const singleton = clusters.find((cl) => cl.id !== grouped!.id);
  expect(singleton).toBeDefined();
  expect(singleton!.statement).toBe(c2.statement);
  expect(singleton!.evidence.map((e) => e.quote)).toEqual([c2.evidence[0]!.quote]);

  expect(conflictPairs).toEqual([]);
});

test("conflict pair links the two returned clusters' actual ids", async () => {
  // An earlier non-empty bucket (architecture) is processed first so the testing
  // bucket's global cluster ids are offset from its group-local indexes 0/1 — this
  // would catch a bug that echoes conflictsWithGroup's bucket-local index as if it
  // were already a global cluster id.
  const offset = cand("An unrelated architecture rule", { category: "architecture" });
  const c0 = cand("Always use tabs", { category: "testing" });
  const c1 = cand("Always use spaces", { category: "testing" });
  const archDraft: Draft = { groups: [] };
  const testingDraft: Draft = {
    groups: [
      { memberIndexes: [0], canonicalStatement: "Use tabs", conflictsWithGroup: 1 },
      { memberIndexes: [1], canonicalStatement: "Use spaces" },
    ],
  };
  const { p } = fakeProvider([archDraft, testingDraft]);

  const { clusters, conflictPairs } = await clusterCandidates([offset, c0, c1], p);

  expect(clusters).toHaveLength(3);
  expect(conflictPairs).toHaveLength(1);
  const tabsCluster = clusters.find((c) => c.statement === "Use tabs")!;
  const spacesCluster = clusters.find((c) => c.statement === "Use spaces")!;
  expect(tabsCluster.id).not.toBe(0); // proves ids aren't just the bucket-local group index
  const pairSet = new Set(conflictPairs[0]);
  expect(pairSet).toEqual(new Set([tabsCluster.id, spacesCluster.id]));
});

test("cross-category isolation: exactly one call per non-empty bucket, prompts scoped to their own bucket", async () => {
  const c0 = cand("Style rule about tab width", { category: "style" });
  const c1 = cand("Testing rule about mock isolation", { category: "testing" });
  const draftStyle: Draft = { groups: [] };
  const draftTesting: Draft = { groups: [] };
  const { p, prompts, callCount } = fakeProvider([draftStyle, draftTesting]);

  const { clusters } = await clusterCandidates([c0, c1], p);

  expect(callCount()).toBe(2);
  const styleCluster = clusters.find((c) => c.category === "style");
  const testingCluster = clusters.find((c) => c.category === "testing");
  expect(styleCluster).toBeDefined();
  expect(testingCluster).toBeDefined();
  expect(styleCluster!.statement).toBe(c0.statement);
  expect(testingCluster!.statement).toBe(c1.statement);

  const stylePrompt = prompts.find((pr) => pr.includes(c0.statement));
  expect(stylePrompt).toBeDefined();
  expect(stylePrompt!.includes(c1.statement)).toBe(false);

  const testingPrompt = prompts.find((pr) => pr.includes(c1.statement));
  expect(testingPrompt).toBeDefined();
  expect(testingPrompt!.includes(c0.statement)).toBe(false);
});

test("fallback: throwing bucket falls back to exact-normalized-statement merge; other bucket unaffected", async () => {
  const p0 = cand("Always  pin versions", { category: "process" });
  const p1 = cand("always pin versions", { category: "process" });
  const p2 = cand("Pin the lockfile too", { category: "process" });
  const d0 = cand("Use snake_case for python", { category: "domain" });
  const d1 = cand("Use camelCase for javascript", { category: "domain" });
  const domainDraft: Draft = {
    groups: [
      { memberIndexes: [0], canonicalStatement: "Use snake_case for python" },
      { memberIndexes: [1], canonicalStatement: "Use camelCase for javascript" },
    ],
  };
  const { p } = fakeProvider(["throw", domainDraft]);
  const counters = { clusterFallbacks: 0 };

  const { clusters, conflictPairs } = await clusterCandidates(
    [p0, p1, p2, d0, d1],
    p,
    { counters },
  );

  expect(counters.clusterFallbacks).toBe(1);

  const processClusters = clusters.filter((c) => c.category === "process");
  expect(processClusters).toHaveLength(2);
  const merged = processClusters.find((c) => c.evidence.length === 2);
  expect(merged).toBeDefined();
  expect(merged!.statement).toBe(p0.statement); // canonical = first member's own statement
  expect(merged!.evidence.map((e) => e.quote).sort()).toEqual(
    [p0.evidence[0]!.quote, p1.evidence[0]!.quote].sort(),
  );
  const distinct = processClusters.find((c) => c.evidence.length === 1);
  expect(distinct).toBeDefined();
  expect(distinct!.statement).toBe(p2.statement);

  const domainClusters = clusters.filter((c) => c.category === "domain");
  expect(domainClusters).toHaveLength(2);
  expect(domainClusters.map((c) => c.statement).sort()).toEqual(
    [d0.statement, d1.statement].sort(),
  );

  expect(conflictPairs).toEqual([]);
});

test("cross-group duplicate index: first claim wins, no double-membership", async () => {
  const c0 = cand("Prefer const over let");
  const c1 = cand("Never use var");
  const draft: Draft = {
    groups: [
      { memberIndexes: [0, 1], canonicalStatement: "Prefer const, never var" },
      { memberIndexes: [1], canonicalStatement: "Never use var (dupe claim)" },
    ],
  };
  const { p } = fakeProvider([draft]);

  const { clusters } = await clusterCandidates([c0, c1], p);

  // Candidate 1's evidence lands ONLY in the first-claiming cluster.
  const first = clusters.find((c) => c.statement === "Prefer const, never var");
  expect(first).toBeDefined();
  expect(first!.evidence.map((e) => e.quote).sort()).toEqual(
    [c0.evidence[0]!.quote, c1.evidence[0]!.quote].sort(),
  );
  // Group1 is empty after first-claim filtering and produces no cluster.
  expect(clusters.find((c) => c.statement === "Never use var (dupe claim)")).toBeUndefined();
  expect(clusters).toHaveLength(1);

  // Total membership covers every candidate exactly once.
  const counts = new Map<string, number>();
  for (const q of clusters.flatMap((c) => c.evidence.map((e) => e.quote))) {
    counts.set(q, (counts.get(q) ?? 0) + 1);
  }
  expect(counts.get(c0.evidence[0]!.quote)).toBe(1);
  expect(counts.get(c1.evidence[0]!.quote)).toBe(1);
  expect(counts.size).toBe(2);
});

test("polarity majority and first non-empty rationale in member order", async () => {
  const c0 = cand("Never commit secrets", { polarity: "proscriptive" });
  const c1 = cand("Do not commit credentials", { polarity: "proscriptive", rationale: "" });
  const c2 = cand("Keep secrets out of the repo", { polarity: "prescriptive", rationale: "because X" });
  const draft: Draft = {
    groups: [{ memberIndexes: [0, 1, 2], canonicalStatement: "Never commit secrets" }],
  };
  const { p } = fakeProvider([draft]);

  const { clusters } = await clusterCandidates([c0, c1, c2], p);

  expect(clusters).toHaveLength(1);
  expect(clusters[0]!.polarity).toBe("proscriptive"); // 2-1 majority
  expect(clusters[0]!.rationale).toBe("because X"); // first NON-EMPTY in member order
});

test("polarity tie falls back to the first member's polarity (memberIndexes order)", async () => {
  const c0 = cand("Use feature flags", { polarity: "prescriptive" });
  const c1 = cand("Don't ship unflagged features", { polarity: "proscriptive" });
  const draft: Draft = {
    groups: [{ memberIndexes: [0, 1], canonicalStatement: "Gate features behind flags" }],
  };
  const { p } = fakeProvider([draft]);

  const { clusters } = await clusterCandidates([c0, c1], p);

  expect(clusters).toHaveLength(1);
  expect(clusters[0]!.polarity).toBe("prescriptive"); // tie -> first member listed
});

test("out-of-range index ignored, no candidate lost", async () => {
  const c0 = cand("Keep functions small");
  const c1 = cand("Write docstrings for public functions");
  const draft: Draft = {
    groups: [{ memberIndexes: [0, 7], canonicalStatement: "Keep functions small" }],
  };
  const { p } = fakeProvider([draft]);

  const { clusters } = await clusterCandidates([c0, c1], p);

  const allQuotes = clusters.flatMap((c) => c.evidence.map((e) => e.quote));
  expect(allQuotes.sort()).toEqual(
    [c0.evidence[0]!.quote, c1.evidence[0]!.quote].sort(),
  );

  const grouped = clusters.find((c) =>
    c.evidence.some((e) => e.quote === c0.evidence[0]!.quote),
  );
  expect(grouped).toBeDefined();
  expect(grouped!.evidence).toHaveLength(1);

  const singleton = clusters.find((c) =>
    c.evidence.some((e) => e.quote === c1.evidence[0]!.quote),
  );
  expect(singleton).toBeDefined();
  expect(singleton!.evidence).toHaveLength(1);
  expect(singleton!.statement).toBe(c1.statement);

  // every input candidate's evidence appears in exactly one cluster
  const counts = new Map<string, number>();
  for (const q of allQuotes) counts.set(q, (counts.get(q) ?? 0) + 1);
  expect([...counts.values()].every((n) => n === 1)).toBe(true);
});

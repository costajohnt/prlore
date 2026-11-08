import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { resumableProvider } from "../src/jobs/resumable-provider.js";
import type { CompleteOptions, ModelProvider } from "../src/model/provider.js";
import { clusterCandidates, MAX_CLUSTER_LEVELS } from "../src/reconciler/cluster.js";
import { dedupeAcrossBuckets } from "../src/reconciler/dedupe.js";
import type { ReconciledRule } from "../src/reconciler/reconcile.js";
import type { VerifiedCandidate } from "../src/reconciler/verify-evidence.js";

// Follow-ups from the review of the batched-synthesis fix (audit 2026-11-07 deep H2).

const lineRe = /^\[(\w+)\] (.*) \((prescriptive|proscriptive)\)$/gm;
const shown = (prompt: string) => [...prompt.matchAll(lineRe)].map((m) => m[2]!);

function cand(statement: string, i: number, polarity: VerifiedCandidate["polarity"] = "prescriptive"): VerifiedCandidate {
  return {
    statement,
    category: "style",
    scope: [],
    polarity,
    evidence: [{ pr: i + 1, author: "a", association: "OWNER", quote: statement, createdAt: "2026-01-01T00:00:00Z", verified: true }],
  };
}

test("recursive clustering stops at MAX_CLUSTER_LEVELS and reports it", async () => {
  // A stingy model: merges only the first two lines it is shown, so each level shrinks
  // by one group per call and would otherwise recurse for many levels.
  let calls = 0;
  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      calls++;
      const lines = shown(prompt);
      const groups = [
        { memberIndexes: lines.length > 1 ? [0, 1] : [0], canonicalStatement: lines[0]!, generality: "repo-wide" },
        ...lines.slice(2).map((s, i) => ({ memberIndexes: [i + 2], canonicalStatement: s, generality: "repo-wide" })),
      ];
      return { groups } as T;
    },
  };
  const counters = { clusterFallbacks: 0, clusterDepthCaps: 0 };
  const input = Array.from({ length: 64 }, (_, i) => cand(`S${i}`, i));
  const { clusters } = await clusterCandidates(input, provider, { counters, batchSize: 4 });

  expect(MAX_CLUSTER_LEVELS).toBe(4);
  expect(counters.clusterDepthCaps).toBe(1);
  // 64 -> 48 -> 36 -> 27 -> 20 units over four levels of ceil(n/4) calls, then exact grouping.
  expect(calls).toBe(16 + 12 + 9 + 7);
  expect(clusters).toHaveLength(20);
  expect(clusters.flatMap((c) => c.evidence.map((e) => e.quote)).sort()).toEqual(input.map((c) => c.statement).sort());
});

test("an upper-level merge cannot swallow a conflict found by a lower level", async () => {
  // Lower calls see full statements: they group by topic letter and flag A vs B as a
  // conflict. The upper call sees only the canonical statements and merges everything.
  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      const lines = shown(prompt);
      if (lines.every((l) => /^topic [AB]$/.test(l))) {
        return { groups: [{ memberIndexes: lines.map((_, i) => i), canonicalStatement: "topic", generality: "repo-wide" }] } as T;
      }
      const letters = [...new Set(lines.map((l) => l.split(" ")[1]!))];
      const groups = letters.map((k) => ({
        memberIndexes: lines.flatMap((l, i) => (l.split(" ")[1] === k ? [i] : [])),
        canonicalStatement: `topic ${k}`,
        generality: "repo-wide",
        ...(k === "A" && letters.includes("B") ? { conflictsWithGroup: letters.indexOf("B") } : {}),
      }));
      return { groups } as T;
    },
  };
  const input = [
    cand("topic A one", 0),
    cand("topic B one", 1, "proscriptive"),
    cand("topic A two", 2),
    cand("topic B two", 3, "proscriptive"),
  ];
  const { clusters, conflictPairs } = await clusterCandidates(input, provider, { batchSize: 3 });

  for (const c of clusters) {
    const letters = new Set(c.evidence.map((e) => e.quote.split(" ")[1]));
    expect(letters.size).toBe(1);
  }
  expect(conflictPairs.length).toBeGreaterThan(0);
  const byId = new Map(clusters.map((c) => [c.id, c]));
  for (const [a, b] of conflictPairs) {
    expect(new Set([byId.get(a)!.evidence[0]!.quote.split(" ")[1], byId.get(b)!.evidence[0]!.quote.split(" ")[1]])).toEqual(
      new Set(["A", "B"]),
    );
  }
});

test("a dedupe batch cannot merge a rule it was never shown", async () => {
  const rule = (id: number): ReconciledRule => ({
    id,
    statement: `rule ${id}`,
    category: "style",
    polarity: "prescriptive",
    scope: [],
    evidence: [],
    verdict: "corroborated",
    exemplars: [],
  });
  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      // Second batch (rules 2 and 3) names rule 0 from the first batch.
      return { mergeSets: prompt.includes("[2] rule 2") ? [{ ids: [0, 2] }] : [] } as T;
    },
  };
  const result = await dedupeAcrossBuckets([0, 1, 2, 3].map(rule), provider, 2);
  expect(result.merged).toEqual([]);
  expect(result.rules).toHaveLength(4);
});

test("prune() keeps only the saved replies this run used", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prlore-cache-"));
  const schema = z.object({ answer: z.string() });
  let innerCalls = 0;
  const inner: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      innerCalls++;
      return { answer: prompt } as T;
    },
  };

  const first = resumableProvider(inner, dir, "s");
  await first.complete({ prompt: "a", schema });
  await first.complete({ prompt: "b", schema });
  expect(await readdir(dir)).toHaveLength(2);

  const second = resumableProvider(inner, dir, "s");
  expect(await second.complete({ prompt: "a", schema })).toEqual({ answer: "a" });
  expect(innerCalls).toBe(2); // "a" came from the saved reply
  await second.prune();
  expect(await readdir(dir)).toHaveLength(1);
  expect(await second.complete({ prompt: "a", schema })).toEqual({ answer: "a" });
  expect(innerCalls).toBe(2);
});

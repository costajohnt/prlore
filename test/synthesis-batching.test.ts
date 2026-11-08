import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { realGit } from "../src/analyzer/git.js";
import type { GqlTransport } from "../src/github/client.js";
import type { RawActor, RawPrNode } from "../src/github/normalize.js";
import { JobManager } from "../src/jobs/manager.js";
import { AnthropicProvider } from "../src/model/anthropic.js";
import { OpenAICompatibleProvider } from "../src/model/openai-compatible.js";
import {
  BudgetExceededError,
  OutputTruncatedError,
  type CompleteOptions,
  type ModelProvider,
} from "../src/model/provider.js";
import { clusterCandidates, type Cluster } from "../src/reconciler/cluster.js";
import { reconcileClusters } from "../src/reconciler/reconcile.js";
import type { VerifiedCandidate } from "../src/reconciler/verify-evidence.js";
import { MineConfigSchema } from "../src/schemas/mine-config.js";
import type { PatternsModel } from "../src/schemas/patterns-model.js";
import { buildFixtureRepo } from "./helpers/fixture-repo.js";

// Audit 2026-11-07 deep H2: synthesis was one model call per stage with a 4096-token
// output cap and no truncation check.

const answer = z.object({ answer: z.string() });

test("AnthropicProvider throws OutputTruncatedError on stop_reason max_tokens, without a schema retry", async () => {
  const create = vi.fn(async () => ({
    content: [{ type: "text", text: '{"answer":"cut o' }],
    usage: { input_tokens: 10, output_tokens: 4096 },
    stop_reason: "max_tokens",
  }));
  const p = new AnthropicProvider({ maxBudgetUsd: 10 }, { messages: { create } } as never);
  await expect(p.complete({ prompt: "q", schema: answer })).rejects.toBeInstanceOf(OutputTruncatedError);
  expect(create).toHaveBeenCalledTimes(1);
});

test("OpenAICompatibleProvider throws OutputTruncatedError on finish_reason length, without a schema retry", async () => {
  const fetchFn = vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"cut' }, finish_reason: "length" }] }), {
      status: 200,
    }),
  );
  const p = new OpenAICompatibleProvider({ baseUrl: "https://x", model: "m", maxBudgetUsd: 10 }, fetchFn as never);
  await expect(p.complete({ prompt: "q", schema: answer })).rejects.toBeInstanceOf(OutputTruncatedError);
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

// ---- clustering ------------------------------------------------------------------

const lines = (prompt: string) => [...prompt.matchAll(/^\[(\w+)\] (.*)$/gm)].map((m) => ({ id: m[1]!, text: m[2]! }));

/** A model that groups "Rule K ..." lines by K, says Rule 0 conflicts with Rule 1, and
 * truncates whenever it is shown more than `maxLines` lines. */
function clusterModel(maxLines: number) {
  let calls = 0;
  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      calls++;
      const shown = lines(prompt);
      if (shown.length > maxLines) throw new OutputTruncatedError(4096);
      const byKey = new Map<string, number[]>();
      shown.forEach((l, i) => {
        const key = /Rule (\d+)/.exec(l.text)![1]!;
        byKey.set(key, [...(byKey.get(key) ?? []), i]);
      });
      const keys = [...byKey.keys()];
      const groups = keys.map((k) => ({
        memberIndexes: byKey.get(k)!,
        canonicalStatement: `Rule ${k}`,
        generality: "repo-wide",
        ...(k === "0" && keys.includes("1") ? { conflictsWithGroup: keys.indexOf("1") } : {}),
      }));
      return { groups } as T;
    },
  };
  return { provider, calls: () => calls };
}

function candidates(n: number, norms: number): VerifiedCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    statement: `Rule ${i % norms} as phrased in review ${i}`,
    category: i % 3 === 0 ? "testing" : "style",
    scope: [],
    polarity: i % norms === 1 ? "proscriptive" : "prescriptive",
    evidence: [
      { pr: i + 1, author: "a", association: "OWNER", quote: `q${i}`, createdAt: "2026-01-01T00:00:00Z", verified: true },
    ],
  }));
}

// Order-free view of a clustering: each cluster as category, statement, and member quotes.
function shape(result: { clusters: Cluster[]; conflictPairs: [number, number][] }) {
  const byId = new Map(result.clusters.map((c) => [c.id, c]));
  const key = (c: Cluster) => `${c.category}|${c.statement}|${c.evidence.map((e) => e.quote).sort().join(",")}`;
  return {
    clusters: result.clusters.map(key).sort(),
    conflicts: result.conflictPairs.map(([a, b]) => [key(byId.get(a)!), key(byId.get(b)!)].sort().join(" <> ")).sort(),
  };
}

test("500 candidates clustered in batches give the same clusters as one call", async () => {
  const input = candidates(500, 25);

  const single = clusterModel(Infinity);
  const oneCall = await clusterCandidates(input, single.provider, { batchSize: 1000 });
  expect(single.calls()).toBe(2); // one per category bucket

  const batched = clusterModel(60);
  const counters = { clusterFallbacks: 0 };
  const multi = await clusterCandidates(input, batched.provider, { counters });
  expect(batched.calls()).toBeGreaterThan(2);
  expect(counters.clusterFallbacks).toBe(0);

  expect(shape(multi)).toEqual(shape(oneCall));
  expect(oneCall.clusters).toHaveLength(50); // all 25 norms appear in both buckets
  expect(shape(oneCall).conflicts).toHaveLength(2); // Rule 0 vs Rule 1, per bucket
});

test("a truncated cluster reply is split and retried, and still merges across the halves", async () => {
  const input = candidates(50, 5).map((c) => ({ ...c, category: "style" as const }));
  const truncating = clusterModel(20); // batch of 50 fits the batch size but not the output cap
  const result = await clusterCandidates(input, truncating.provider);
  const reference = await clusterCandidates(input, clusterModel(Infinity).provider);
  expect(shape(result)).toEqual(shape(reference));
  expect(result.clusters).toHaveLength(5);
});

test("a single candidate whose reply still truncates fails loudly instead of falling back", async () => {
  const counters = { clusterFallbacks: 0 };
  await expect(clusterCandidates(candidates(1, 1), clusterModel(0).provider, { counters })).rejects.toBeInstanceOf(
    OutputTruncatedError,
  );
  expect(counters.clusterFallbacks).toBe(0);
});

// ---- reconcile -------------------------------------------------------------------

const patterns: PatternsModel = {
  areas: [],
  patterns: [],
  migrations: [],
  meta: { languages: [], frameworks: [], tooling: [] },
} as unknown as PatternsModel;

function reconcileModel(maxLines: number) {
  let calls = 0;
  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      calls++;
      const shown = lines(prompt);
      if (shown.length > maxLines) throw new OutputTruncatedError(4096);
      return { proposals: shown.map((l) => ({ clusterId: Number(l.id), proposedVerdict: "corroborated" })) } as T;
    },
  };
  return { provider, calls: () => calls };
}

const clusters = (n: number): Cluster[] =>
  Array.from({ length: n }, (_, id) => ({
    id,
    statement: `Rule ${id}`,
    category: "style",
    polarity: "prescriptive",
    scope: [],
    evidence: [],
  }));

test("reconcile covers 500 clusters across batches, splitting a truncated batch", async () => {
  const model = reconcileModel(30); // batches of 40 truncate and split into 20s
  const warnings: string[] = [];
  const rules = await reconcileClusters(clusters(500), [], patterns, {
    provider: model.provider,
    git: realGit,
    repoPath: ".",
    now: () => Date.parse("2026-06-01T00:00:00Z"),
    warnings,
  });
  expect(rules).toHaveLength(500);
  expect(rules.every((r) => r.verdict === "corroborated")).toBe(true);
  expect(warnings).toEqual([]);
  expect(model.calls()).toBe(12 * 3 + 1); // 12 batches of 40 truncate and split in two; the last 20 fit
});

test("reconcile rethrows truncation of a single cluster instead of degrading every rule", async () => {
  await expect(
    reconcileClusters(clusters(3), [], patterns, {
      provider: reconcileModel(0).provider,
      git: realGit,
      repoPath: ".",
      now: Date.now,
    }),
  ).rejects.toBeInstanceOf(OutputTruncatedError);
});

// ---- resume after a failed synthesis -----------------------------------------------

const human: RawActor = { login: "alice", __typename: "User" };
const owner: RawActor = { login: "bob", __typename: "User" };
function mkPr(number: number): RawPrNode {
  return {
    number,
    title: `PR ${number}`,
    body: `body ${number}`,
    updatedAt: "2026-06-01T00:00:00Z",
    mergedAt: "2026-06-01T00:00:00Z",
    state: "MERGED",
    author: human,
    authorAssociation: "CONTRIBUTOR",
    labels: { nodes: [] },
    files: { nodes: [{ path: "src/x.ts" }], pageInfo: { hasNextPage: false } },
    reviews: { nodes: [{ author: owner, authorAssociation: "OWNER", state: "APPROVED", body: "looks solid" }], pageInfo: { hasNextPage: false } },
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
  };
}
function fakeGitHub(): GqlTransport {
  return (async (query: string) => {
    if (query.includes("preflight")) return { viewer: { login: "me" }, repository: { nameWithOwner: "o/r" } };
    return {
      rateLimit: { cost: 1, remaining: 5000, resetAt: "2026-12-31T00:00:00Z" },
      repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: "C1" }, nodes: [mkPr(1), mkPr(2)] } },
    };
  }) as GqlTransport;
}

function routedProvider(failPlan: boolean) {
  const calls: string[] = [];
  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt, schema }: CompleteOptions<T>): Promise<T> {
      if (prompt.startsWith("## User intent")) {
        calls.push("analyze");
        return schema.parse({ areaDescriptions: [], patterns: [], migrationCandidates: [] });
      }
      if (prompt.startsWith("## PR #")) {
        calls.push("extract");
        return schema.parse({ learnings: [] });
      }
      if (prompt.startsWith("intent:")) {
        calls.push("plan");
        if (failPlan) throw new BudgetExceededError(10, 10);
        return schema.parse({ title: "Conventions", overview: "auto", sections: [], perArea: false });
      }
      calls.push("other");
      if (prompt.startsWith("meta:")) return schema.parse({ proposals: [] });
      return schema.parse({ mergeSets: [] });
    },
  };
  return { provider, calls };
}

test("a synthesis failure fails the job loudly, and a re-run resumes without re-paying finished calls", async () => {
  const repoPath = await buildFixtureRepo();
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-resume-"));
  const config = MineConfigSchema.parse({ repo: "o/r", intent: "test", timeRange: { since: "2026-01-01T00:00:00Z" } });

  const first = routedProvider(true);
  const m1 = new JobManager();
  const { jobId: j1 } = m1.start(config, { transport: fakeGitHub(), provider: first.provider, stateDir, repoPath });
  await m1.settled();
  const failed = m1.status(j1);
  expect(failed.state).toBe("failed");
  expect(failed.error).toContain("re-run mine to resume");
  expect(first.calls).toContain("analyze");
  expect(existsSync(join(stateDir, "synthesis-cache"))).toBe(true);

  const second = routedProvider(false);
  const m2 = new JobManager();
  const { jobId: j2 } = m2.start(config, { transport: fakeGitHub(), provider: second.provider, stateDir, repoPath });
  await m2.settled();
  expect(m2.status(j2).state).toBe("ready-for-preview");
  // analyze came from the saved reply and extraction from the per-PR cache; only the
  // call that failed is made again.
  expect(second.calls).toEqual(["plan"]);
  expect(existsSync(join(stateDir, "synthesis-cache"))).toBe(false);
});

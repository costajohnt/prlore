import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fetchCorpus } from "../src/github/fetcher.js";
import { Throttle } from "../src/github/throttle.js";
import type { GqlTransport } from "../src/github/client.js";
import type { RawActor, RawPrNode } from "../src/github/normalize.js";
import { JobManager } from "../src/jobs/manager.js";
import type { CompleteOptions, ModelProvider } from "../src/model/provider.js";
import { MineConfigSchema, type MineConfig } from "../src/schemas/mine-config.js";
import type { NormalizedPr } from "../src/schemas/normalized-pr.js";
import { loadCheckpoint } from "../src/state/checkpoint.js";
import { readCorpus, windowCorpus } from "../src/state/corpus.js";
import { buildFixtureRepo } from "./helpers/fixture-repo.js";

// Audit 2026-11-07 deep H1: re-running `mine` with the same flags used to reuse the
// first run's corpus forever. These tests drive a fake GitHub across several runs.

const human: RawActor = { login: "alice", __typename: "User" };
const owner: RawActor = { login: "bob", __typename: "User" };

function mkPr(number: number, updatedAt: string): RawPrNode {
  return {
    number,
    title: `PR ${number}`,
    body: `body for ${number}`,
    updatedAt,
    mergedAt: updatedAt,
    state: "MERGED",
    author: human,
    authorAssociation: "CONTRIBUTOR",
    labels: { nodes: [] },
    files: { nodes: [{ path: "src/x.ts" }], pageInfo: { hasNextPage: false } },
    reviews: {
      nodes: [{ author: owner, authorAssociation: "OWNER", state: "APPROVED", body: `review of ${number} at ${updatedAt}` }],
      pageInfo: { hasNextPage: false },
    },
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
  };
}

/** One page, newest first (GitHub orders UPDATED_AT DESC). */
function fakeGitHub(nodes: RawPrNode[]) {
  const pageCalls: Record<string, unknown>[] = [];
  const transport = (async (query: string, variables: Record<string, unknown>) => {
    if (query.includes("preflight")) return { viewer: { login: "me" }, repository: { nameWithOwner: "o/r" } };
    pageCalls.push(variables);
    return {
      rateLimit: { cost: 1, remaining: 5000, resetAt: "2026-12-31T00:00:00Z" },
      repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: "C1" }, nodes } },
    };
  }) as GqlTransport;
  return { transport, pageCalls };
}

const config: MineConfig = MineConfigSchema.parse({ repo: "o/r", intent: "test", timeRange: { since: "2026-01-01T00:00:00Z" } });
const throttle = () => new Throttle({ now: () => 0, sleep: async () => {} });

test("a re-run fetches PRs updated since the watermark and merges them into the corpus", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-incr-"));

  const run1 = fakeGitHub([mkPr(2, "2026-06-02T00:00:00Z"), mkPr(1, "2026-06-01T00:00:00Z")]);
  const s1 = await fetchCorpus(config, { transport: run1.transport, throttle: throttle(), stateDir });
  expect(s1).toMatchObject({ kept: 2, refreshedFrom: null, maxUpdatedAt: "2026-06-02T00:00:00Z" });

  // PR 3 is new, PR 2 got a new comment, PR 1 is at/below the watermark: the pass stops there.
  const run2 = fakeGitHub([
    mkPr(2, "2026-06-05T00:00:00Z"),
    mkPr(3, "2026-06-03T00:00:00Z"),
    mkPr(1, "2026-06-01T00:00:00Z"),
  ]);
  const delivered: number[] = [];
  const s2 = await fetchCorpus(config, {
    transport: run2.transport,
    throttle: throttle(),
    stateDir,
    onPr: (pr) => delivered.push(pr.number),
  });
  expect(run2.pageCalls).toHaveLength(1);
  expect(run2.pageCalls[0]!.cursor).toBeNull();
  expect(s2).toMatchObject({ kept: 2, fetched: 2, refreshedFrom: "2026-06-02T00:00:00Z", maxUpdatedAt: "2026-06-05T00:00:00Z" });
  expect(delivered).toEqual([2, 3]);

  const { prs } = await readCorpus(join(stateDir, "corpus.jsonl"));
  expect(prs.map((p) => [p.number, p.updatedAt]).sort()).toEqual([
    [1, "2026-06-01T00:00:00Z"],
    [2, "2026-06-05T00:00:00Z"],
    [3, "2026-06-03T00:00:00Z"],
  ]);
  expect((await loadCheckpoint(stateDir))?.stage).toBe("extracting");

  // Nothing new: the pass sees only PRs at or below the watermark and adds none.
  const run3 = fakeGitHub([mkPr(2, "2026-06-05T00:00:00Z"), mkPr(3, "2026-06-03T00:00:00Z")]);
  const s3 = await fetchCorpus(config, { transport: run3.transport, throttle: throttle(), stateDir });
  expect(s3).toMatchObject({ kept: 0, refreshedFrom: "2026-06-05T00:00:00Z" });
  expect((await readCorpus(join(stateDir, "corpus.jsonl"))).prs).toHaveLength(3);
});

test("windowCorpus drops rows older than since and keeps only the newest maxPrs", () => {
  const pr = (number: number, updatedAt: string) => ({ number, updatedAt }) as NormalizedPr;
  const prs = [pr(1, "2025-12-01T00:00:00Z"), pr(2, "2026-02-01T00:00:00Z"), pr(3, "2026-03-01T00:00:00Z"), pr(4, "2026-01-15T00:00:00Z")];
  const windowed = (since: string, maxPrs: number) =>
    windowCorpus(prs, MineConfigSchema.parse({ repo: "o/r", intent: "t", timeRange: { since, maxPrs } })).map((p) => p.number);
  expect(windowed("2026-01-01T00:00:00Z", 10)).toEqual([2, 3, 4]);
  expect(windowed("2026-01-01T00:00:00Z", 2)).toEqual([2, 3]);
});

function recordingProvider() {
  const calls: string[] = [];
  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt, schema }: CompleteOptions<T>): Promise<T> {
      if (prompt.startsWith("## User intent")) {
        calls.push("analyze");
        return schema.parse({ areaDescriptions: [], patterns: [], migrationCandidates: [] });
      }
      if (prompt.startsWith("## PR #")) {
        calls.push(`extract #${/^## PR #(\d+)/.exec(prompt)![1]}`);
        return schema.parse({ learnings: [] });
      }
      if (prompt.startsWith("meta:")) return schema.parse({ proposals: [] });
      if (prompt.startsWith("dedupe:")) return schema.parse({ mergeSets: [] });
      if (prompt.startsWith("intent:")) {
        calls.push("plan");
        return schema.parse({ title: "Conventions", overview: "auto", sections: [], perArea: false });
      }
      throw new Error(`unrouted prompt: ${prompt.slice(0, 40)}`);
    },
  };
  return { provider, calls };
}

test("JobManager: a second run extracts only the new PR, re-synthesizes, and reports corpus freshness", async () => {
  const repoPath = await buildFixtureRepo();
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-incr-job-"));
  const runOnce = async (nodes: RawPrNode[]) => {
    const { provider, calls } = recordingProvider();
    const manager = new JobManager();
    const { jobId } = manager.start(config, { transport: fakeGitHub(nodes).transport, provider, stateDir, repoPath });
    await manager.settled();
    return { status: manager.status(jobId), result: manager.result(jobId), calls };
  };

  const first = await runOnce([mkPr(2, "2026-06-02T00:00:00Z"), mkPr(1, "2026-06-01T00:00:00Z")]);
  expect(first.status.state).toBe("ready-for-preview");
  expect(first.calls.filter((c) => c.startsWith("extract")).sort()).toEqual(["extract #1", "extract #2"]);
  expect(first.status.corpus).toEqual({ prs: 2, newestUpdatedAt: "2026-06-02T00:00:00Z", addedThisRun: 2 });

  const second = await runOnce([mkPr(3, "2026-06-03T00:00:00Z"), mkPr(2, "2026-06-02T00:00:00Z")]);
  expect(second.status.state).toBe("ready-for-preview");
  expect(second.calls.filter((c) => c.startsWith("extract"))).toEqual(["extract #3"]);
  expect(second.calls).toContain("plan");
  const freshness = { prs: 3, newestUpdatedAt: "2026-06-03T00:00:00Z", addedThisRun: 1 };
  expect(second.status.corpus).toEqual(freshness);
  expect(second.result?.provenance.corpus).toEqual(freshness);
  expect(second.status.warnings).toEqual([]);

  const third = await runOnce([mkPr(3, "2026-06-03T00:00:00Z")]);
  expect(third.calls.filter((c) => c.startsWith("extract"))).toEqual([]);
  expect(third.status.corpus).toEqual({ ...freshness, addedThisRun: 0 });
  expect(third.status.warnings).toEqual([
    "corpus unchanged: no PRs updated since 2026-06-03T00:00:00Z; re-synthesized over the existing 3 PR(s)",
  ]);
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { JobManager, type JobDeps } from "../src/jobs/manager.js";
import { BudgetExceededError, type CompleteOptions, type ModelProvider } from "../src/model/provider.js";
import { MineConfigSchema, type MineConfig } from "../src/schemas/mine-config.js";
import { ProvenanceSchema } from "../src/schemas/provenance.js";
import type { GqlTransport } from "../src/github/client.js";
import type { RawActor, RawPrNode } from "../src/github/normalize.js";
import { buildFixtureRepo } from "./helpers/fixture-repo.js";

// ---- shared fixtures: fake GitHub transport (mirrors test/fetcher.test.ts) --------

const human: RawActor = { login: "alice", __typename: "User" };
const owner: RawActor = { login: "bob", __typename: "User" };
const page = (hasNextPage = false) => ({ hasNextPage });

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
    files: { nodes: [{ path: "src/x.ts" }], pageInfo: page() },
    reviews: {
      nodes: [{ author: owner, authorAssociation: "OWNER", state: "APPROVED", body: "looks solid" }],
      pageInfo: page(),
    },
    comments: { nodes: [], pageInfo: page() },
    reviewThreads: { nodes: [], pageInfo: page() },
  };
}

function rateLimit() {
  return { cost: 1, remaining: 5000, resetAt: "2026-12-31T00:00:00Z" };
}

function fakeTransport(pages: object[]): GqlTransport {
  let i = 0;
  return (async (query: string) => {
    if (query.includes("preflight")) {
      return { viewer: { login: "me" }, repository: { nameWithOwner: "o/r" } };
    }
    return pages[i++];
  }) as GqlTransport;
}

function onePagePages(prNumbers: number[]) {
  return [
    {
      rateLimit: rateLimit(),
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: "C1" },
          nodes: prNumbers.map((n) => mkPr(n, "2026-06-01T00:00:00Z")),
        },
      },
    },
  ];
}

const emptyPage = [
  {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    },
  },
];

function mkConfig(overrides: Record<string, unknown> = {}): MineConfig {
  return MineConfigSchema.parse({
    repo: "o/r",
    intent: "help new contributors",
    timeRange: { since: "2026-01-01T00:00:00Z" },
    ...overrides,
  });
}

const ANALYZE_MARKER = "## User intent";
const EXTRACT_MARKER = "## PR #";
const RECONCILE_MARKER = "meta:";
const PLAN_MARKER = "intent:";

const analyzeResponse = { areaDescriptions: [], patterns: [], migrationCandidates: [] };
const emptyLearnings = { learnings: [] };
const emptyReconcile = { proposals: [] };
const emptyPlan = { title: "Conventions", overview: "auto-generated", sections: [], perArea: false };

/** Records the ordered kind of every provider.complete() call so tests can pin the
 * analyze-before-extraction ordering contract; each handler is independently
 * overridable per test. */
function recordingProvider(overrides: {
  onExtract?: (prompt: string) => unknown;
  onReconcile?: () => unknown;
  onPlan?: () => unknown;
} = {}) {
  const calls: string[] = [];
  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt, schema }: CompleteOptions<T>): Promise<T> {
      if (prompt.startsWith(ANALYZE_MARKER)) {
        calls.push("analyze");
        return schema.parse(analyzeResponse);
      }
      if (prompt.startsWith(EXTRACT_MARKER)) {
        calls.push("extract");
        const res = overrides.onExtract ? overrides.onExtract(prompt) : emptyLearnings;
        if (res instanceof Error) throw res;
        return schema.parse(res);
      }
      if (prompt.startsWith(RECONCILE_MARKER)) {
        calls.push("reconcile");
        const res = overrides.onReconcile ? overrides.onReconcile() : emptyReconcile;
        if (res instanceof Error) throw res;
        return schema.parse(res);
      }
      if (prompt.startsWith(PLAN_MARKER)) {
        calls.push("plan");
        const res = overrides.onPlan ? overrides.onPlan() : emptyPlan;
        if (res instanceof Error) throw res;
        return schema.parse(res);
      }
      throw new Error(`unrouted provider prompt: ${prompt.slice(0, 40)}`);
    },
  };
  return { provider, calls };
}

async function freshDeps(repoPath: string, transport: GqlTransport): Promise<Omit<JobDeps, "provider">> {
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-job-"));
  return { transport, stateDir, repoPath };
}

// ---- Test 1: happy path -----------------------------------------------------------

test("full run reaches ready-for-preview with a non-null result; analyze's provider call precedes every extraction call", async () => {
  const repo = await buildFixtureRepo();
  const transport = fakeTransport(onePagePages([1, 2]));
  const { provider, calls } = recordingProvider();
  const manager = new JobManager();
  const base = await freshDeps(repo, transport);

  const { jobId, resumed } = manager.start(mkConfig(), { ...base, provider });
  expect(resumed).toBe(false);
  await manager.settled();

  const status = manager.status(jobId);
  expect(status.state).toBe("ready-for-preview");
  expect(status.warnings).toEqual([]);

  const result = manager.result(jobId);
  expect(result).not.toBeNull();
  expect(typeof result!.draft).toBe("string");
  expect(ProvenanceSchema.parse(result!.provenance)).toEqual(result!.provenance);
  expect(result!.contested).toEqual([]);

  const analyzeIdx = calls.indexOf("analyze");
  expect(analyzeIdx).toBe(0);
  const extractIdxs = calls.map((c, i) => (c === "extract" ? i : -1)).filter((i) => i >= 0);
  expect(extractIdxs.length).toBeGreaterThan(0);
  for (const i of extractIdxs) expect(i).toBeGreaterThan(analyzeIdx);
});

// ---- Test 2: double-start rejection ------------------------------------------------

test("a second start() while a job is running throws synchronously", async () => {
  const repo = await buildFixtureRepo();
  const transport = fakeTransport(onePagePages([1]));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { provider } = recordingProvider();
  const gatedProvider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>(opts: CompleteOptions<T>): Promise<T> {
      if (opts.prompt.startsWith(ANALYZE_MARKER)) await gate;
      return provider.complete(opts);
    },
  };
  const manager = new JobManager();
  const base = await freshDeps(repo, transport);

  const { jobId } = manager.start(mkConfig(), { ...base, provider: gatedProvider });
  expect(manager.status(jobId).state).toBe("running");
  expect(() => manager.start(mkConfig(), { ...base, provider: gatedProvider })).toThrow();

  release();
  await manager.settled();
  expect(manager.status(jobId).state).toBe("ready-for-preview");
});

// ---- Test 3: cancel between stages --------------------------------------------------

test("cancel requested during analyze takes effect at the next stage boundary: cancelled + checkpointed", async () => {
  const repo = await buildFixtureRepo();
  const transport = (async () => {
    throw new Error("fetch stage must never start once cancelled before it");
  }) as GqlTransport;
  const manager = new JobManager();
  const base = await freshDeps(repo, transport);
  let jobId = "";
  let cancelResultPromise: Promise<{ checkpointed: boolean }> | undefined;

  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt, schema }: CompleteOptions<T>): Promise<T> {
      if (prompt.startsWith(ANALYZE_MARKER)) {
        cancelResultPromise = manager.cancel(jobId);
        return schema.parse(analyzeResponse);
      }
      throw new Error(`unexpected call after cancel: ${prompt.slice(0, 40)}`);
    },
  };

  const started = manager.start(mkConfig(), { ...base, provider });
  jobId = started.jobId;
  await manager.settled();

  expect(cancelResultPromise).toBeDefined();
  const { checkpointed } = await cancelResultPromise!;
  expect(checkpointed).toBe(true);
  expect(manager.status(jobId).state).toBe("cancelled");
  expect(manager.result(jobId)).toBeNull();
});

// ---- Test 4: synthesize budget failure ----------------------------------------------

test("a BudgetExceededError from synthesize's reconcile call fails the job with a budget message", async () => {
  const repo = await buildFixtureRepo();
  const transport = fakeTransport(onePagePages([1]));
  const { provider } = recordingProvider({
    onReconcile: () => new BudgetExceededError(5, 5),
  });
  const manager = new JobManager();
  const base = await freshDeps(repo, transport);

  const { jobId } = manager.start(mkConfig(), { ...base, provider });
  await manager.settled();

  const status = manager.status(jobId);
  expect(status.state).toBe("failed");
  expect(status.error).toMatch(/budget/i);
  expect(manager.result(jobId)).toBeNull();
});

// ---- Test 5: extraction budget-partial => warning, still ready-for-preview ---------

test("extraction running out of budget mid-run warns but still reaches ready-for-preview", async () => {
  const repo = await buildFixtureRepo();
  const transport = fakeTransport(onePagePages([1, 2]));
  const { provider } = recordingProvider({
    onExtract: () => new BudgetExceededError(1, 1),
  });
  const manager = new JobManager();
  const base = await freshDeps(repo, transport);

  const { jobId } = manager.start(mkConfig(), { ...base, provider });
  await manager.settled();

  const status = manager.status(jobId);
  expect(status.state).toBe("ready-for-preview");
  expect(status.warnings?.some((w) => w.startsWith("extraction budget-partial"))).toBe(true);
  expect(manager.result(jobId)).not.toBeNull();
});

// ---- Test 6: prsSeen === 0 warning ---------------------------------------------------

test("an empty corpus (prsSeen === 0) warns that nothing ran, but still reaches ready-for-preview", async () => {
  const repo = await buildFixtureRepo();
  const transport = fakeTransport(emptyPage);
  const { provider } = recordingProvider();
  const manager = new JobManager();
  const base = await freshDeps(repo, transport);

  const { jobId } = manager.start(mkConfig(), { ...base, provider });
  await manager.settled();

  const status = manager.status(jobId);
  expect(status.state).toBe("ready-for-preview");
  expect(status.warnings).toContain("no PRs processed — corpus empty or config too narrow");
});

// ---- Test 7: resumed flag -------------------------------------------------------------

test("resumed is false on a fresh stateDir and true on a second start against the same config+stateDir", async () => {
  const repo = await buildFixtureRepo();
  const config = mkConfig();
  const manager = new JobManager();
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-job-resume-"));

  const transport1 = fakeTransport(onePagePages([1]));
  const { provider: provider1 } = recordingProvider();
  const first = manager.start(config, { transport: transport1, provider: provider1, stateDir, repoPath: repo });
  expect(first.resumed).toBe(false);
  await manager.settled();
  expect(manager.status(first.jobId).state).toBe("ready-for-preview");

  const transport2 = fakeTransport(onePagePages([1]));
  const { provider: provider2 } = recordingProvider();
  const second = manager.start(config, { transport: transport2, provider: provider2, stateDir, repoPath: repo });
  expect(second.resumed).toBe(true);
  await manager.settled();
});

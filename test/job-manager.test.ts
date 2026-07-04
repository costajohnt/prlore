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
// v0.3 Task 3: the cross-bucket dedup pass's one provider call, threaded between
// reconcile and plan (see synthesize.ts). Checked before PLAN_MARKER below since
// dedupe's prompt never starts with "intent:", but for symmetry with the other
// markers this is its own constant.
const DEDUPE_MARKER = "dedupe:";
const PLAN_MARKER = "intent:";

const analyzeResponse = { areaDescriptions: [], patterns: [], migrationCandidates: [] };
const emptyLearnings = { learnings: [] };
const emptyReconcile = { proposals: [] };
const emptyDedupe = { mergeSets: [] };
const emptyPlan = { title: "Conventions", overview: "auto-generated", sections: [], perArea: false };

function routePrompt<T>(prompt: string, schema: CompleteOptions<T>["schema"], calls?: string[]): T {
  if (prompt.startsWith(ANALYZE_MARKER)) {
    calls?.push("analyze");
    return schema.parse(analyzeResponse);
  }
  if (prompt.startsWith(EXTRACT_MARKER)) {
    calls?.push("extract");
    return schema.parse(emptyLearnings);
  }
  if (prompt.startsWith(RECONCILE_MARKER)) {
    calls?.push("reconcile");
    return schema.parse(emptyReconcile);
  }
  if (prompt.startsWith(DEDUPE_MARKER)) {
    calls?.push("dedupe");
    return schema.parse(emptyDedupe);
  }
  if (prompt.startsWith(PLAN_MARKER)) {
    calls?.push("plan");
    return schema.parse(emptyPlan);
  }
  throw new Error(`unrouted provider prompt: ${prompt.slice(0, 40)}`);
}

/** Records the ordered kind of every provider.complete() call so tests can pin the
 * analyze-before-extraction ordering contract. Never spends budget. */
function recordingProvider() {
  const calls: string[] = [];
  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt, schema }: CompleteOptions<T>): Promise<T> {
      return routePrompt(prompt, schema, calls);
    },
  };
  return { provider, calls };
}

/** Faithful to AnthropicProvider's budget semantics: ONE monotonic spent counter shared
 * across every call kind (analyze/extract/reconcile/plan alike), a pre-call gate that
 * throws BudgetExceededError once spent >= cap (anthropic.ts line "if (this.spent >=
 * this.opts.maxBudgetUsd) throw"), and a fixed cost booked per completed call. Gate and
 * increment run with no await between them, so concurrent extraction workers can't
 * interleave past the cap — same atomicity as the real provider's single-threaded
 * check-then-track. */
function sharedBudgetProvider(capUsd: number, costPerCall = 1): ModelProvider {
  let spent = 0;
  return {
    spentUsd: () => spent,
    async complete<T>({ prompt, schema }: CompleteOptions<T>): Promise<T> {
      if (spent >= capUsd) throw new BudgetExceededError(spent, capUsd);
      spent += costPerCall;
      return routePrompt(prompt, schema);
    },
  };
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

  // status() hands out copies: mutating a returned snapshot must not leak into the
  // manager's live state.
  status.counters!["kept"] = 999;
  status.warnings!.push("mutated");
  const reread = manager.status(jobId);
  expect(reread.counters?.kept).not.toBe(999);
  expect(reread.warnings).toEqual([]);
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

// ---- Test 4: extraction budget-partial under a SHARED budget => warning + ready ----
// The provider mirrors AnthropicProvider: one monotonic counter across all call kinds.
// Cap 15, cost 1/call, 14 PRs: analyze spends 1; extraction runs against the RESERVED
// cap of 15 * 0.8 = 12, so exactly 11 PR extractions succeed (spent 1 -> 12) and 3 get
// budget-skipped; synthesis then still has 12 < 15 headroom for its reconcile (-> 13),
// dedup (-> 14, v0.3 Task 3), and plan (-> 15) calls. Without the reservation,
// extraction would burn to the full cap and synthesis's first call's pre-call gate
// would throw -> failed. This test pins the reservation.

test("shared monotonic budget: extraction trips its reduced cap, synthesis completes within the reserve -> ready-for-preview with the budget-partial warning", async () => {
  const repo = await buildFixtureRepo();
  const prNumbers = Array.from({ length: 14 }, (_, i) => i + 1);
  const transport = fakeTransport(onePagePages(prNumbers));
  const provider = sharedBudgetProvider(15);
  const manager = new JobManager();
  const base = await freshDeps(repo, transport);

  const { jobId } = manager.start(mkConfig({ model: { maxBudgetUsd: 15 } }), { ...base, provider });
  await manager.settled();

  const status = manager.status(jobId);
  expect(status.state).toBe("ready-for-preview");
  expect(status.warnings?.some((w) => w.startsWith("extraction budget-partial"))).toBe(true);
  expect(status.counters?.skippedBudget).toBe(3);
  expect(status.counters?.extracted).toBe(11);
  expect(status.tokensSpentUsd).toBe(15); // analyze 1 + extract 11 + reconcile 1 + dedup 1 + plan 1
  expect(manager.result(jobId)).not.toBeNull();
});

// ---- Test 5: shared budget so small synthesis exhausts the FULL cap too => failed ---
// Cap 2, cost 1/call, 3 PRs: analyze spends 1; extraction (reduced cap 1.6) fits one PR
// (spent -> 2) then trips; synthesize's reconcile call hits the full cap's pre-call
// gate (2 >= 2) -> BudgetExceededError -> failed is now legitimate and stays.

test("shared monotonic budget: synthesis exhausting the full cap fails the job with a budget message", async () => {
  const repo = await buildFixtureRepo();
  const transport = fakeTransport(onePagePages([1, 2, 3]));
  const provider = sharedBudgetProvider(2);
  const manager = new JobManager();
  const base = await freshDeps(repo, transport);

  const { jobId } = manager.start(mkConfig({ model: { maxBudgetUsd: 2 } }), { ...base, provider });
  await manager.settled();

  const status = manager.status(jobId);
  expect(status.state).toBe("failed");
  expect(status.error).toMatch(/budget/i);
  expect(manager.result(jobId)).toBeNull();
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

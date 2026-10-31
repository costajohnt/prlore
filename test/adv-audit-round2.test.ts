// Regression tests for the config-hash reset: no stray superseded dirs on a fresh
// stateDir, exact --since identity, offset normalization, and stable --days resume.
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { JobManager } from "../src/jobs/manager.js";
import { fetchCorpus } from "../src/github/fetcher.js";
import { configHash } from "../src/github/config-hash.js";
import { Throttle } from "../src/github/throttle.js";
import { readCorpus } from "../src/state/corpus.js";
import { resetState } from "../src/state/checkpoint.js";
import { MineConfigSchema, type MineConfig } from "../src/schemas/mine-config.js";
import type { GqlTransport } from "../src/github/client.js";
import type { RawActor, RawPrNode } from "../src/github/normalize.js";
import type { CompleteOptions, ModelProvider } from "../src/model/provider.js";
import { buildFixtureRepo } from "./helpers/fixture-repo.js";

const human: RawActor = { login: "alice", __typename: "User" };
const owner: RawActor = { login: "bob", __typename: "User" };
const page = (hasNextPage = false) => ({ hasNextPage });
function mkPr(number: number, updatedAt: string): RawPrNode {
  return {
    number, title: `PR ${number}`, body: `body for ${number}`, updatedAt, mergedAt: updatedAt, state: "MERGED",
    author: human, authorAssociation: "CONTRIBUTOR", labels: { nodes: [] },
    files: { nodes: [{ path: "src/x.ts" }], pageInfo: page() },
    reviews: { nodes: [{ author: owner, authorAssociation: "OWNER", state: "APPROVED", body: "looks solid" }], pageInfo: page() },
    comments: { nodes: [], pageInfo: page() }, reviewThreads: { nodes: [], pageInfo: page() },
  };
}
const rateLimit = () => ({ cost: 1, remaining: 5000, resetAt: "2026-12-31T00:00:00Z" });
const onePage = (nums: number[]) => ({
  rateLimit: rateLimit(),
  repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: "C1" }, nodes: nums.map((n) => mkPr(n, "2026-06-01T00:00:00Z")) } },
});
function fakeTransport(pages: object[]): GqlTransport {
  let i = 0;
  return (async (query: string) => {
    if (query.includes("preflight")) return { viewer: { login: "me" }, repository: { nameWithOwner: "o/r" } };
    return pages[i++];
  }) as GqlTransport;
}
const mkConfig = (o: Record<string, unknown> = {}): MineConfig =>
  MineConfigSchema.parse({ repo: "o/r", intent: "test", timeRange: { since: "2026-01-01T00:00:00Z" }, ...o });
const quietThrottle = () => new Throttle({ now: () => 0, sleep: async () => {} });
const stubProvider: ModelProvider = {
  spentUsd: () => 0,
  async complete<T>({ prompt, schema }: CompleteOptions<T>): Promise<T> {
    if (prompt.startsWith("## User intent")) return schema.parse({ areaDescriptions: [], patterns: [], migrationCandidates: [] });
    if (prompt.startsWith("## PR #")) return schema.parse({ learnings: [] });
    if (prompt.startsWith("meta:")) return schema.parse({ proposals: [] });
    if (prompt.startsWith("dedupe:")) return schema.parse({ mergeSets: [] });
    if (prompt.startsWith("intent:")) return schema.parse({ title: "Conventions", overview: "x", sections: [], perArea: false });
    throw new Error(`unrouted: ${prompt.slice(0, 30)}`);
  },
};

// A first run on a fresh stateDir (no checkpoint, no corpus) must not leave an empty
// superseded dir in the checked-in .prlore/ (ADR 005).
test("resetState on a fresh stateDir must not create an empty superseded/ dir", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-adv2-"));
  await resetState(stateDir, "h");
  expect((await readdir(stateDir)).filter((n) => n.startsWith("superseded"))).toEqual([]);
});

test("first JobManager run on a fresh stateDir leaves no superseded/ dir", async () => {
  const repo = await buildFixtureRepo();
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-adv2-"));
  const m = new JobManager();
  m.start(mkConfig(), { transport: fakeTransport([onePage([1])]), provider: stubProvider, stateDir, repoPath: repo });
  await m.settled();
  expect((await readdir(stateDir)).filter((n) => n.startsWith("superseded"))).toEqual([]);
});

// Two explicit --since values 23h apart must not share a checkpoint: the second run
// would otherwise resume without refetching and keep PRs outside its window.
test("explicit --since values on the same UTC day but different times must not share a checkpoint", async () => {
  const repo = await buildFixtureRepo();
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-adv2-"));
  const m1 = new JobManager();
  m1.start(mkConfig({ timeRange: { since: "2026-05-01T00:00:00Z" } }), {
    transport: fakeTransport([onePage([1, 2])]), provider: stubProvider, stateDir, repoPath: repo,
  });
  await m1.settled();

  const m2 = new JobManager();
  const { resumed } = m2.start(mkConfig({ timeRange: { since: "2026-05-01T23:00:00Z" } }), {
    transport: fakeTransport([onePage([3])]), provider: stubProvider, stateDir, repoPath: repo,
  });
  await m2.settled();
  expect(resumed).toBe(false);
  expect((await readCorpus(join(stateDir, "corpus.jsonl"))).prs.map((p) => p.number)).toEqual([3]);
});

// The hash is over the normalized instant, so an offset form equals its Z form.
test("the same instant expressed with an offset and with Z must hash identically", () => {
  const a = mkConfig({ timeRange: { since: "2026-01-01T20:00:00-05:00" } }); // = 2026-01-02T01:00:00Z
  const b = mkConfig({ timeRange: { since: "2026-01-02T01:00:00Z" } });
  expect(configHash(a)).toBe(configHash(b));
});

// `--days N` hashes N, not the clock-derived `since`, so a job started at 23:50Z and
// resumed at 00:10Z next day keeps its checkpoint instead of superseding the corpus.
test("--days: a resume across UTC midnight must keep the same checkpoint identity", () => {
  const days = 30;
  const sinceFor = (t: number) => new Date(t - days * 86_400_000).toISOString(); // src/cli.ts verbatim
  const before = Date.parse("2026-07-10T23:50:00Z");
  const after = Date.parse("2026-07-11T00:10:00Z");
  expect(configHash(mkConfig({ timeRange: { since: sinceFor(before), days } }))).toBe(
    configHash(mkConfig({ timeRange: { since: sinceFor(after), days } })),
  );
  // ...while a different N is a different identity.
  expect(configHash(mkConfig({ timeRange: { since: sinceFor(before), days: 31 } }))).not.toBe(
    configHash(mkConfig({ timeRange: { since: sinceFor(before), days } })),
  );
});

// standalone fetchCorpus on a fresh dir: same litter.
test("standalone fetchCorpus on a fresh stateDir leaves no superseded/ dir", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-adv2-"));
  await fetchCorpus(mkConfig(), { transport: fakeTransport([onePage([1])]), throttle: quietThrottle(), stateDir });
  expect((await readdir(stateDir)).filter((n) => n.startsWith("superseded"))).toEqual([]);
});

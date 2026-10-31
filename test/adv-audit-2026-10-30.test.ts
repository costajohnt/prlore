// Regression tests for audit H1 through the production path (JobManager), the
// reset crash window, and --days checkpoint identity.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { JobManager } from "../src/jobs/manager.js";
import { fetchCorpus } from "../src/github/fetcher.js";
import { configHash } from "../src/github/config-hash.js";
import { Throttle } from "../src/github/throttle.js";
import { readCorpus } from "../src/state/corpus.js";
import { saveCheckpoint } from "../src/state/checkpoint.js";
import { appendJsonl } from "../src/state/jsonl.js";
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
    reviews: { nodes: [{ author: owner, authorAssociation: "OWNER", state: "APPROVED", body: "looks solid" }], pageInfo: page() },
    comments: { nodes: [], pageInfo: page() },
    reviewThreads: { nodes: [], pageInfo: page() },
  };
}
const rateLimit = () => ({ cost: 1, remaining: 5000, resetAt: "2026-12-31T00:00:00Z" });
function onePage(prNumbers: number[]) {
  return {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: { pageInfo: { hasNextPage: false, endCursor: "C1" }, nodes: prNumbers.map((n) => mkPr(n, "2026-06-01T00:00:00Z")) },
    },
  };
}
function fakeTransport(pages: object[], opts: { failPages?: boolean } = {}): GqlTransport {
  let i = 0;
  return (async (query: string) => {
    if (query.includes("preflight")) return { viewer: { login: "me" }, repository: { nameWithOwner: "o/r" } };
    if (opts.failPages) throw new Error("ECONNRESET");
    return pages[i++];
  }) as GqlTransport;
}
function mkConfig(overrides: Record<string, unknown> = {}): MineConfig {
  return MineConfigSchema.parse({ repo: "o/r", intent: "test", timeRange: { since: "2026-01-01T00:00:00Z" }, ...overrides });
}
const quietThrottle = () => new Throttle({ now: () => 0, sleep: async () => {} } as never);

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

// H1 through the real pipeline. JobManager.run() rewrites checkpoint.json with the
// NEW hash before calling fetchCorpus, so fetchCorpus's "hash mismatch -> rm corpus"
// branch never fires in production. The README's two-run sequence still merges corpora.
test("H1 (JobManager path): a config change must not carry the old corpus into the new run", async () => {
  const repo = await buildFixtureRepo();
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-adv-"));

  const m1 = new JobManager();
  m1.start(mkConfig({ timeRange: { since: "2026-01-01T00:00:00Z" } }), {
    transport: fakeTransport([onePage([1, 2])]),
    provider: stubProvider,
    stateDir,
    repoPath: repo,
  });
  await m1.settled();
  expect((await readCorpus(join(stateDir, "corpus.jsonl"))).prs.map((p) => p.number)).toEqual([1, 2]);

  const m2 = new JobManager();
  const { resumed } = m2.start(mkConfig({ timeRange: { since: "2026-05-01T00:00:00Z" } }), {
    transport: fakeTransport([onePage([3])]),
    provider: stubProvider,
    stateDir,
    repoPath: repo,
  });
  expect(resumed).toBe(false);
  await m2.settled();

  const { prs } = await readCorpus(join(stateDir, "corpus.jsonl"));
  expect(prs.map((p) => p.number)).toEqual([3]);
});

// H1 ordering: corpus.jsonl is removed before the new checkpoint is persisted and before
// the first page is fetched. A network failure in that window leaves the OLD checkpoint
// (old hash, stage "extracting") on disk next to NO corpus. Re-running with the original
// config then matches the old hash, skips fetching, and proceeds on an empty corpus.
test("H1 (crash window): network failure right after the corpus wipe must not silently empty a later matching-config run", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-adv-"));
  const configA = mkConfig({ timeRange: { since: "2026-01-01T00:00:00Z" } });
  const configB = mkConfig({ timeRange: { since: "2026-05-01T00:00:00Z" } });

  await appendJsonl(join(stateDir, "corpus.jsonl"), {
    number: 1, title: "PR 1", body: "b", author: "alice", authorAssociation: "CONTRIBUTOR", state: "MERGED",
    mergedAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z", labels: [], files: ["src/x.ts"], threads: [],
    reviews: [{ author: "bob", association: "OWNER", state: "APPROVED", body: "looks solid" }], comments: [],
  });
  await saveCheckpoint(stateDir, {
    configHash: configHash(configA), stage: "extracting", cursor: null, overflowQueue: [], maxUpdatedAt: "2026-06-01T00:00:00Z", counters: { kept: 1 },
  });

  await expect(
    fetchCorpus(configB, { transport: fakeTransport([], { failPages: true }), throttle: quietThrottle(), stateDir }),
  ).rejects.toThrow("ECONNRESET");

  // User reverts to config A and retries: hash matches, stage "extracting", no refetch.
  const summary = await fetchCorpus(configA, { transport: fakeTransport([onePage([1])]), throttle: quietThrottle(), stateDir });
  const { prs } = await readCorpus(join(stateDir, "corpus.jsonl"));
  // Either the corpus survived, or the checkpoint was invalidated so it was refetched.
  expect(prs.map((p) => p.number)).toEqual([1]);
  expect(summary.kept).toBe(1);
});

// `--days` resolves to `since = now - days` with millisecond precision, so the CLI also
// records `days` and the hash uses that instead of the clock-derived instant; otherwise
// two consecutive runs of the identical command would never share a checkpoint and the
// H1 reset would supersede the corpus on every invocation.
test("H1 (--days): the same --days N command on two consecutive runs must hash to the same checkpoint identity", () => {
  const days = 30;
  const t0 = Date.parse("2026-07-10T00:00:00.000Z");
  const sinceA = new Date(t0 - days * 86_400_000).toISOString(); // src/cli.ts verbatim
  const sinceB = new Date(t0 + 1 - days * 86_400_000).toISOString(); // one ms later
  expect(configHash(mkConfig({ timeRange: { since: sinceA, days } }))).toBe(configHash(mkConfig({ timeRange: { since: sinceB, days } })));
});

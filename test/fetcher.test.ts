import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fetchCorpus } from "../src/github/fetcher.js";
import { readCorpus } from "../src/state/corpus.js";
import { loadCheckpoint, saveCheckpoint } from "../src/state/checkpoint.js";
import { appendJsonl } from "../src/state/jsonl.js";
import { configHash } from "../src/github/config-hash.js";
import { Throttle } from "../src/github/throttle.js";
import { PreflightError, type GqlTransport } from "../src/github/client.js";
import { MineConfigSchema, type MineConfig } from "../src/schemas/mine-config.js";
import type { Checkpoint } from "../src/schemas/checkpoint.js";
import type { RawActor, RawPrNode } from "../src/github/normalize.js";

const human: RawActor = { login: "alice", __typename: "User" };
const owner: RawActor = { login: "bob", __typename: "User" };
const page = (hasNextPage = false) => ({ hasNextPage });

interface MkPrOpts {
  lgtm?: boolean;
  overflow?: boolean;
  author?: RawActor | null;
}

function mkPr(number: number, updatedAt: string, opts: MkPrOpts = {}): RawPrNode {
  const reviewBody = opts.lgtm ? "" : "looks solid";
  return {
    number,
    title: `PR ${number}`,
    body: `body for ${number}`,
    updatedAt,
    mergedAt: updatedAt,
    state: "MERGED",
    author: opts.author !== undefined ? opts.author : human,
    authorAssociation: "CONTRIBUTOR",
    labels: { nodes: [] },
    files: { nodes: [{ path: "src/x.ts" }], pageInfo: page() },
    reviews: {
      nodes: [{ author: owner, authorAssociation: "OWNER", state: "APPROVED", body: reviewBody }],
      pageInfo: page(),
    },
    comments: { nodes: [], pageInfo: page() },
    reviewThreads: {
      nodes: [],
      pageInfo: page(opts.overflow ?? false),
    },
  };
}

function rateLimit(overrides: Partial<{ cost: number; remaining: number; resetAt: string }> = {}) {
  return { cost: 1, remaining: 5000, resetAt: "2026-12-31T00:00:00Z", ...overrides };
}

function fakeTransport(pages: object[], perPrResponses: Record<number, object> = {}) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  let page = 0;
  const transport = (async (query: string, variables: Record<string, unknown>) => {
    calls.push({ query, variables });
    if (query.includes("preflight")) {
      return { viewer: { login: "me" }, repository: { nameWithOwner: "o/r" } };
    }
    if (query.includes("pullRequest(")) {
      return perPrResponses[variables.number as number];
    }
    return pages[page++];
  }) as GqlTransport;
  return { transport, calls };
}

const quietThrottle = () => new Throttle({ now: () => 0, sleep: async () => {} });
const freshDeps = async () => ({ stateDir: await mkdtemp(join(tmpdir(), "prlore-fetch-")) });

function mkConfig(overrides: Record<string, unknown> = {}): MineConfig {
  return MineConfigSchema.parse({
    repo: "o/r",
    intent: "test",
    timeRange: { since: "2026-01-01T00:00:00Z" },
    ...overrides,
  });
}

test("walks two pages, writes corpus, checkpoints cursor per page", async () => {
  const config = mkConfig();
  const page1 = {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: true, endCursor: "CURSOR_1" },
        nodes: [mkPr(1, "2026-06-01T00:00:00Z"), mkPr(2, "2026-06-02T00:00:00Z")],
      },
    },
  };
  const page2 = {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: "CURSOR_2" },
        nodes: [mkPr(3, "2026-06-03T00:00:00Z"), mkPr(4, "2026-06-04T00:00:00Z")],
      },
    },
  };
  const { transport, calls } = fakeTransport([page1, page2]);
  const { stateDir } = await freshDeps();

  await fetchCorpus(config, { transport, throttle: quietThrottle(), stateDir });

  const { prs } = await readCorpus(join(stateDir, "corpus.jsonl"));
  expect(prs).toHaveLength(4);

  const finalCp = await loadCheckpoint(stateDir);
  expect(finalCp?.stage).toBe("extracting");
  expect(finalCp?.counters.kept).toBe(4);

  const pageCalls = calls.filter((c) => !c.query.includes("preflight"));
  expect(pageCalls).toHaveLength(2);
  expect(pageCalls[1]!.variables.cursor).toBe("CURSOR_1");
});

test("filters feed counters", async () => {
  const config = mkConfig();
  const page1 = {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: "CURSOR_1" },
        nodes: [mkPr(1, "2026-06-01T00:00:00Z"), mkPr(2, "2026-06-02T00:00:00Z", { lgtm: true })],
      },
    },
  };
  const { transport } = fakeTransport([page1]);
  const { stateDir } = await freshDeps();

  const summary = await fetchCorpus(config, { transport, throttle: quietThrottle(), stateDir });

  expect(summary.kept).toBe(1);
  expect(summary.dropped).toBe(1);

  const { prs } = await readCorpus(join(stateDir, "corpus.jsonl"));
  expect(prs).toHaveLength(1);
  expect(prs[0]!.number).toBe(1);
});

test("authors filter: case-insensitively keeps matching authors and drops the rest, counting drops", async () => {
  const config = mkConfig({ authors: ["CostaJohnT"] });
  const page1 = {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: "CURSOR_1" },
        nodes: [
          mkPr(1, "2026-06-01T00:00:00Z", { author: { login: "costajohnt", __typename: "User" } }),
          mkPr(2, "2026-06-02T00:00:00Z", { author: { login: "someone-else", __typename: "User" } }),
        ],
      },
    },
  };
  const { transport } = fakeTransport([page1]);
  const { stateDir } = await freshDeps();

  const summary = await fetchCorpus(config, { transport, throttle: quietThrottle(), stateDir });

  expect(summary.kept).toBe(1);
  expect(summary.dropped).toBe(1);

  const { prs } = await readCorpus(join(stateDir, "corpus.jsonl"));
  expect(prs).toHaveLength(1);
  expect(prs[0]!.number).toBe(1);
  expect(prs[0]!.author).toBe("costajohnt");

  const finalCp = await loadCheckpoint(stateDir);
  expect(finalCp?.counters.dropped).toBe(1);
});

test("empty authors filter keeps everything, as before", async () => {
  const config = mkConfig({ authors: [] });
  const page1 = {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: "CURSOR_1" },
        nodes: [
          mkPr(1, "2026-06-01T00:00:00Z", { author: { login: "costajohnt", __typename: "User" } }),
          mkPr(2, "2026-06-02T00:00:00Z", { author: { login: "someone-else", __typename: "User" } }),
        ],
      },
    },
  };
  const { transport } = fakeTransport([page1]);
  const { stateDir } = await freshDeps();

  const summary = await fetchCorpus(config, { transport, throttle: quietThrottle(), stateDir });

  expect(summary.kept).toBe(2);
  expect(summary.dropped).toBe(0);
});

test("ghost/null author is dropped under an authors filter", async () => {
  const config = mkConfig({ authors: ["alice"] });
  const page1 = {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: "CURSOR_1" },
        nodes: [
          mkPr(1, "2026-06-01T00:00:00Z", { author: null }),
          mkPr(2, "2026-06-02T00:00:00Z", { author: human }),
        ],
      },
    },
  };
  const { transport } = fakeTransport([page1]);
  const { stateDir } = await freshDeps();

  const summary = await fetchCorpus(config, { transport, throttle: quietThrottle(), stateDir });

  expect(summary.kept).toBe(1);
  expect(summary.dropped).toBe(1);

  const { prs } = await readCorpus(join(stateDir, "corpus.jsonl"));
  expect(prs).toHaveLength(1);
  expect(prs[0]!.number).toBe(2);
});

test("overflow queue round-trip", async () => {
  const config = mkConfig();
  const page1 = {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: "CURSOR_1" },
        nodes: [mkPr(7, "2026-06-01T00:00:00Z", { overflow: true })],
      },
    },
  };
  const fullerNode = mkPr(7, "2026-06-01T00:00:00Z");
  fullerNode.reviewThreads = {
    nodes: [
      {
        path: "src/x.ts",
        line: 1,
        isResolved: false,
        comments: {
          nodes: [
            { author: owner, authorAssociation: "OWNER", body: "comment 1", createdAt: "2026-06-01T00:00:01Z" },
            { author: owner, authorAssociation: "OWNER", body: "comment 2", createdAt: "2026-06-01T00:00:02Z" },
            { author: owner, authorAssociation: "OWNER", body: "comment 3", createdAt: "2026-06-01T00:00:03Z" },
          ],
          pageInfo: page(),
        },
      },
    ],
    pageInfo: page(),
  };
  const perPrResponses = {
    7: { rateLimit: rateLimit(), repository: { pullRequest: fullerNode } },
  };
  const { transport } = fakeTransport([page1], perPrResponses);
  const { stateDir } = await freshDeps();

  const delivered: { number: number; comments: number }[] = [];
  const onPr = (pr: { number: number; threads: { comments: unknown[] }[] }) =>
    delivered.push({ number: pr.number, comments: pr.threads[0]?.comments.length ?? 0 });

  const summary = await fetchCorpus(config, {
    transport,
    throttle: quietThrottle(),
    stateDir,
    onPr: onPr as never,
  });

  const { prs } = await readCorpus(join(stateDir, "corpus.jsonl"));
  const pr7 = prs.find((p) => p.number === 7);
  expect(pr7?.threads[0]!.comments).toHaveLength(3);
  expect(summary.overflowRefetched).toBe(1);

  const finalCp = await loadCheckpoint(stateDir);
  expect(finalCp?.overflowQueue).toEqual([]);

  const pr7Deliveries = delivered.filter((d) => d.number === 7);
  expect(pr7Deliveries).toHaveLength(1);
  expect(pr7Deliveries[0]!.comments).toBe(3);
});

test("overflow refetch pass drops PRs from authors not in the filter", async () => {
  // Defense-in-depth: even if an overflowQueue entry reaches the refetch pass
  // for an author the current config no longer wants (e.g. a queue seeded by
  // some future path that skips the main loop's author check), the refetch
  // pass must apply the same filter rather than blindly appending it.
  const config = mkConfig({ authors: ["alice"] });
  const { stateDir } = await freshDeps();

  const nonMatchingNode = mkPr(9, "2026-06-01T00:00:00Z", {
    author: { login: "mallory", __typename: "User" },
  });
  const perPrResponses = {
    9: { rateLimit: rateLimit(), repository: { pullRequest: nonMatchingNode } },
  };
  const { transport } = fakeTransport([], perPrResponses);

  const cp: Checkpoint = {
    configHash: configHash(config),
    stage: "extracting",
    cursor: null,
    overflowQueue: [9],
    maxUpdatedAt: null,
    counters: { kept: 0 },
  };
  await saveCheckpoint(stateDir, cp);

  const delivered: number[] = [];
  const summary = await fetchCorpus(config, {
    transport,
    throttle: quietThrottle(),
    stateDir,
    onPr: (pr) => delivered.push(pr.number),
  });

  expect(summary.overflowRefetched).toBe(1);
  expect(delivered).toEqual([]);

  const { prs } = await readCorpus(join(stateDir, "corpus.jsonl"));
  expect(prs.find((p) => p.number === 9)).toBeUndefined();

  const finalCp = await loadCheckpoint(stateDir);
  expect(finalCp?.overflowQueue).toEqual([]);
});

test("resume from checkpoint", async () => {
  const config = mkConfig();
  const { stateDir } = await freshDeps();

  await appendJsonl(join(stateDir, "corpus.jsonl"), {
    number: 1,
    title: "PR 1",
    body: "body for 1",
    author: "alice",
    authorAssociation: "CONTRIBUTOR",
    state: "MERGED",
    mergedAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    labels: [],
    files: ["src/x.ts"],
    threads: [],
    reviews: [{ author: "bob", association: "OWNER", state: "APPROVED", body: "looks solid" }],
    comments: [],
  });

  const cp: Checkpoint = {
    configHash: configHash(config),
    stage: "fetching",
    cursor: "CURSOR_A",
    overflowQueue: [],
    maxUpdatedAt: "2026-06-01T00:00:00Z",
    counters: { kept: 1 },
  };
  await saveCheckpoint(stateDir, cp);

  const page1 = {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: "CURSOR_B" },
        nodes: [mkPr(2, "2026-06-02T00:00:00Z")],
      },
    },
  };
  const { transport, calls } = fakeTransport([page1]);

  await fetchCorpus(config, { transport, throttle: quietThrottle(), stateDir });

  const pageCalls = calls.filter((c) => !c.query.includes("preflight"));
  expect(pageCalls[0]!.variables.cursor).toBe("CURSOR_A");

  const { prs } = await readCorpus(join(stateDir, "corpus.jsonl"));
  expect(prs).toHaveLength(2);
});

test("config change resets cursor but keeps corpus", async () => {
  const config = mkConfig();
  const { stateDir } = await freshDeps();

  await appendJsonl(join(stateDir, "corpus.jsonl"), {
    number: 1,
    title: "PR 1",
    body: "body for 1",
    author: "alice",
    authorAssociation: "CONTRIBUTOR",
    state: "MERGED",
    mergedAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    labels: [],
    files: ["src/x.ts"],
    threads: [],
    reviews: [{ author: "bob", association: "OWNER", state: "APPROVED", body: "looks solid" }],
    comments: [],
  });

  const cp: Checkpoint = {
    configHash: "stale",
    stage: "fetching",
    cursor: "CURSOR_A",
    overflowQueue: [],
    maxUpdatedAt: "2026-06-01T00:00:00Z",
    counters: { kept: 1 },
  };
  await saveCheckpoint(stateDir, cp);

  const page1 = {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: "CURSOR_B" },
        nodes: [mkPr(2, "2026-06-02T00:00:00Z")],
      },
    },
  };
  const { transport, calls } = fakeTransport([page1]);

  await fetchCorpus(config, { transport, throttle: quietThrottle(), stateDir });

  const pageCalls = calls.filter((c) => !c.query.includes("preflight"));
  expect(pageCalls[0]!.variables.cursor).toBeNull();

  const { prs } = await readCorpus(join(stateDir, "corpus.jsonl"));
  expect(prs).toHaveLength(2);
});

test("maxPrs stop", async () => {
  const config = mkConfig({ timeRange: { since: "2026-01-01T00:00:00Z", maxPrs: 2 } });
  const page1 = {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: true, endCursor: "CURSOR_1" },
        nodes: [mkPr(1, "2026-06-01T00:00:00Z"), mkPr(2, "2026-06-02T00:00:00Z")],
      },
    },
  };
  const page2 = {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: true, endCursor: "CURSOR_2" },
        nodes: [mkPr(3, "2026-06-03T00:00:00Z"), mkPr(4, "2026-06-04T00:00:00Z")],
      },
    },
  };
  const page3 = {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: "CURSOR_3" },
        nodes: [mkPr(5, "2026-06-05T00:00:00Z")],
      },
    },
  };
  const { transport, calls } = fakeTransport([page1, page2, page3]);
  const { stateDir } = await freshDeps();

  const summary = await fetchCorpus(config, { transport, throttle: quietThrottle(), stateDir });

  expect(summary.kept).toBe(2);
  const pageCalls = calls.filter((c) => !c.query.includes("preflight"));
  expect(pageCalls).toHaveLength(1);
});

test("since stop", async () => {
  const config = mkConfig({ timeRange: { since: "2026-01-01T00:00:00Z" } });
  const page1 = {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: true, endCursor: "CURSOR_1" },
        nodes: [mkPr(1, "2026-06-01T00:00:00Z"), mkPr(2, "2024-01-01T00:00:00Z")],
      },
    },
  };
  const page2 = {
    rateLimit: rateLimit(),
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: "CURSOR_2" },
        nodes: [mkPr(3, "2023-01-01T00:00:00Z")],
      },
    },
  };
  const { transport, calls } = fakeTransport([page1, page2]);
  const { stateDir } = await freshDeps();

  await fetchCorpus(config, { transport, throttle: quietThrottle(), stateDir });

  const pageCalls = calls.filter((c) => !c.query.includes("preflight"));
  expect(pageCalls).toHaveLength(1);

  const { prs } = await readCorpus(join(stateDir, "corpus.jsonl"));
  expect(prs).toHaveLength(1);
  expect(prs[0]!.number).toBe(1);
});

test("does not regress a later-stage checkpoint when re-invoked", async () => {
  const config = mkConfig();
  const { stateDir } = await freshDeps();

  const cp: Checkpoint = {
    configHash: configHash(config),
    stage: "synthesizing",
    cursor: null,
    overflowQueue: [],
    maxUpdatedAt: "2026-06-01T00:00:00Z",
    counters: { fetched: 4, kept: 4, dropped: 0 },
  };
  await saveCheckpoint(stateDir, cp);

  const transport = (async (query: string) => {
    if (query.includes("preflight")) {
      return { viewer: { login: "me" }, repository: { nameWithOwner: "o/r" } };
    }
    throw new Error("should not be called");
  }) as GqlTransport;
  const calls: string[] = [];
  const countingTransport = (async (query: string, variables: Record<string, unknown>) => {
    calls.push(query);
    return transport(query, variables);
  }) as GqlTransport;

  await fetchCorpus(config, { transport: countingTransport, throttle: quietThrottle(), stateDir });

  expect(calls).toHaveLength(1);

  const finalCp = await loadCheckpoint(stateDir);
  expect(finalCp?.stage).toBe("synthesizing");
});

test("preflight failure aborts before any state write", async () => {
  const config = mkConfig();
  const transport = (async (query: string) => {
    if (query.includes("preflight")) {
      return { viewer: { login: "me" }, repository: null };
    }
    throw new Error("should not be called");
  }) as GqlTransport;
  const { stateDir } = await freshDeps();

  await expect(
    fetchCorpus(config, { transport, throttle: quietThrottle(), stateDir }),
  ).rejects.toThrow(PreflightError);

  expect(existsSync(join(stateDir, "checkpoint.json"))).toBe(false);
});

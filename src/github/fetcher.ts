import { join } from "node:path";
import type { MineConfig } from "../schemas/mine-config.js";
import type { NormalizedPr } from "../schemas/normalized-pr.js";
import type { Checkpoint } from "../schemas/checkpoint.js";
import { loadCheckpoint, saveCheckpoint } from "../state/checkpoint.js";
import { appendJsonl } from "../state/jsonl.js";
import { readCorpus } from "../state/corpus.js";
import { configHash } from "./config-hash.js";
import { preflight, type GqlTransport } from "./client.js";
import { normalizePr, type IngestCounters, type RawPrNode } from "./normalize.js";
import type { RateInfo, Throttle } from "./throttle.js";

export interface FetchDeps {
  transport: GqlTransport;
  throttle: Throttle;
  stateDir: string;
  onPr?: (pr: NormalizedPr) => void;
}

export interface FetchSummary {
  fetched: number;
  kept: number;
  dropped: number;
  drifted: number;
  overflowRefetched: number;
  maxUpdatedAt: string | null;
}

const PR_FIELDS = `
  number title body updatedAt mergedAt state
  author { login __typename }
  authorAssociation
  labels(first: 20) { nodes { name } }
  files(first: $files) { nodes { path } pageInfo { hasNextPage } }
  reviews(first: $reviews) { nodes { author { login __typename } authorAssociation state body } pageInfo { hasNextPage } }
  comments(first: $comments) { nodes { author { login __typename } authorAssociation body createdAt } pageInfo { hasNextPage } }
  reviewThreads(first: $threads) {
    pageInfo { hasNextPage }
    nodes { path line isResolved comments(first: $threadComments) { nodes { author { login __typename } authorAssociation body createdAt } pageInfo { hasNextPage } } }
  }`;

const PAGE_QUERY = `query fetchPage($owner: String!, $name: String!, $cursor: String, $files: Int!, $reviews: Int!, $comments: Int!, $threads: Int!, $threadComments: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequests(first: 25, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PR_FIELDS} }
    }
  }
}`;

const OVERFLOW_QUERY = `query fetchOne($owner: String!, $name: String!, $number: Int!, $files: Int!, $reviews: Int!, $comments: Int!, $threads: Int!, $threadComments: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${PR_FIELDS} }
  }
}`;

const PAGE_FIRSTS = { files: 100, reviews: 25, comments: 30, threads: 50, threadComments: 10 };
const OVERFLOW_FIRSTS = { files: 100, reviews: 100, comments: 100, threads: 100, threadComments: 50 };

interface PageResponse {
  rateLimit: RateInfo;
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: RawPrNode[];
    };
  };
}
interface OneResponse {
  rateLimit: RateInfo;
  repository: { pullRequest: RawPrNode | null };
}

function counter(cp: Checkpoint, key: string): number {
  return cp.counters[key] ?? 0;
}
function bump(cp: Checkpoint, key: string, by = 1): void {
  cp.counters[key] = counter(cp, key) + by;
}

export async function fetchCorpus(config: MineConfig, deps: FetchDeps): Promise<FetchSummary> {
  const [owner, name] = config.repo.split("/") as [string, string];
  await preflight(deps.transport, owner, name);

  const hash = configHash(config);
  const corpusPath = join(deps.stateDir, "corpus.jsonl");
  let cp = await loadCheckpoint(deps.stateDir);
  if (!cp || cp.configHash !== hash) {
    cp = {
      configHash: hash,
      stage: "fetching",
      cursor: null,
      overflowQueue: [],
      maxUpdatedAt: null,
      counters: {},
    };
  }

  const ingest: IngestCounters = { botCommentsStripped: counter(cp, "botCommentsStripped") };
  const since = config.timeRange.since ?? null;
  const maxPrs = config.timeRange.maxPrs;

  if (cp.stage === "fetching") {
    let hasNext = true;
    while (hasNext && counter(cp, "kept") < maxPrs) {
      await deps.throttle.beforeRequest();
      const res = await deps.transport<PageResponse>(PAGE_QUERY, {
        owner,
        name,
        cursor: cp.cursor,
        ...PAGE_FIRSTS,
      });
      await deps.throttle.afterResponse(res.rateLimit);

      let sawTooOld = false;
      for (const node of res.repository.pullRequests.nodes) {
        if (counter(cp, "kept") >= maxPrs) break;
        if (since && node.updatedAt < since) {
          sawTooOld = true;
          break;
        }
        bump(cp, "fetched");
        const result = normalizePr(node, ingest);
        if (result.kept) {
          await appendJsonl(corpusPath, result.pr);
          deps.onPr?.(result.pr);
          bump(cp, "kept");
          if (result.needsOverflow && !cp.overflowQueue.includes(result.pr.number)) {
            cp.overflowQueue.push(result.pr.number);
          }
          if (!cp.maxUpdatedAt || result.pr.updatedAt > cp.maxUpdatedAt) {
            cp.maxUpdatedAt = result.pr.updatedAt;
          }
        } else {
          bump(cp, "dropped");
        }
      }
      cp.counters["botCommentsStripped"] = ingest.botCommentsStripped;
      cp.cursor = res.repository.pullRequests.pageInfo.endCursor;
      hasNext = res.repository.pullRequests.pageInfo.hasNextPage && !sawTooOld;
      await saveCheckpoint(deps.stateDir, cp);
    }
  }

  // Overflow pass: refetch PRs whose nested connections were truncated.
  while (cp.overflowQueue.length > 0) {
    const number = cp.overflowQueue[0]!;
    try {
      await deps.throttle.beforeRequest();
      const res = await deps.transport<OneResponse>(OVERFLOW_QUERY, {
        owner,
        name,
        number,
        ...OVERFLOW_FIRSTS,
      });
      await deps.throttle.afterResponse(res.rateLimit);
      const node = res.repository.pullRequest;
      if (node) {
        const result = normalizePr(node, ingest);
        if (result.kept) {
          await appendJsonl(corpusPath, result.pr);
          deps.onPr?.(result.pr);
        }
      }
      bump(cp, "overflowRefetched");
    } catch {
      bump(cp, "overflowFailed"); // withRetry already retried; skip, never fatal
    }
    cp.overflowQueue.shift();
    cp.counters["botCommentsStripped"] = ingest.botCommentsStripped;
    await saveCheckpoint(deps.stateDir, cp);
  }

  cp.stage = "extracting";
  await saveCheckpoint(deps.stateDir, cp);

  const { drifted } = await readCorpus(corpusPath);
  return {
    fetched: counter(cp, "fetched"),
    kept: counter(cp, "kept"),
    dropped: counter(cp, "dropped"),
    drifted,
    overflowRefetched: counter(cp, "overflowRefetched"),
    maxUpdatedAt: cp.maxUpdatedAt,
  };
}

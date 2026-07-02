import { expect, test } from "vitest";
import { normalizePr, type IngestCounters, type RawPrNode } from "../src/github/normalize.js";

const human = { login: "alice", __typename: "User" };
const owner = { login: "bob", __typename: "User" };
const bot = { login: "dependabot[bot]", __typename: "Bot" };
const page = (hasNextPage = false) => ({ hasNextPage });

function basePr(overrides: Partial<RawPrNode> = {}): RawPrNode {
  return {
    number: 7,
    title: "Add widget",
    body: "adds the widget",
    updatedAt: "2026-01-02T00:00:00Z",
    mergedAt: "2026-01-01T12:00:00Z",
    state: "MERGED",
    author: human,
    authorAssociation: "CONTRIBUTOR",
    labels: { nodes: [{ name: "feature" }] },
    files: { nodes: [{ path: "src/widget.ts" }], pageInfo: page() },
    reviews: {
      nodes: [{ author: owner, authorAssociation: "OWNER", state: "APPROVED", body: "use the factory" }],
      pageInfo: page(),
    },
    comments: { nodes: [], pageInfo: page() },
    reviewThreads: {
      nodes: [
        {
          path: "src/widget.ts",
          line: 10,
          isResolved: true,
          comments: {
            nodes: [
              { author: owner, authorAssociation: "OWNER", body: "prefer the factory here", createdAt: "2026-01-01T01:00:00Z" },
              { author: bot, authorAssociation: "NONE", body: "CI passed", createdAt: "2026-01-01T02:00:00Z" },
            ],
            pageInfo: page(),
          },
        },
      ],
      pageInfo: page(),
    },
    ...overrides,
  };
}

const counters = (): IngestCounters => ({ botCommentsStripped: 0 });

test("normalizes a PR, stripping bot comments and counting them", () => {
  const c = counters();
  const result = normalizePr(basePr(), c);
  if (!result.kept) throw new Error("expected kept");
  expect(result.pr.number).toBe(7);
  expect(result.pr.state).toBe("MERGED");
  expect(result.pr.labels).toEqual(["feature"]);
  expect(result.pr.files).toEqual(["src/widget.ts"]);
  expect(result.pr.threads[0]!.comments).toHaveLength(1); // bot comment stripped
  expect(result.pr.threads[0]!.comments[0]!.author).toBe("bob");
  expect(c.botCommentsStripped).toBe(1);
  expect(result.needsOverflow).toBe(false);
});

test("drops a PR with no human discussion text (LGTM-only)", () => {
  const result = normalizePr(
    basePr({
      reviews: {
        nodes: [{ author: owner, authorAssociation: "OWNER", state: "APPROVED", body: "" }],
        pageInfo: page(),
      },
      reviewThreads: { nodes: [], pageInfo: page() },
      comments: { nodes: [], pageInfo: page() },
    }),
    counters(),
  );
  expect(result).toEqual({ kept: false, reason: "no_human_discussion" });
});

test("keeps a bot-authored PR that has human discussion", () => {
  const result = normalizePr(basePr({ author: bot }), counters());
  if (!result.kept) throw new Error("expected kept");
  expect(result.pr.author).toBe("dependabot[bot]");
});

test("flags overflow when any nested connection has another page", () => {
  const overflowing = basePr();
  overflowing.reviewThreads.pageInfo = page(true);
  const result = normalizePr(overflowing, counters());
  if (!result.kept) throw new Error("expected kept");
  expect(result.needsOverflow).toBe(true);

  const threadOverflow = basePr();
  threadOverflow.reviewThreads.nodes[0]!.comments.pageInfo = page(true);
  const r2 = normalizePr(threadOverflow, counters());
  if (!r2.kept) throw new Error("expected kept");
  expect(r2.needsOverflow).toBe(true);
});

test("deleted author becomes ghost; null body becomes empty string", () => {
  const result = normalizePr(basePr({ author: null, body: null }), counters());
  if (!result.kept) throw new Error("expected kept");
  expect(result.pr.author).toBe("ghost");
  expect(result.pr.body).toBe("");
});

import { expect, test } from "vitest";
import type { CompleteOptions, ModelProvider } from "../src/model/provider.js";
import type { NormalizedPr } from "../src/schemas/normalized-pr.js";
import { CandidateLearningSchema } from "../src/schemas/candidate-learning.js";
import { extractOne, renderPrDiscussion } from "../src/extractor/extract-one.js";

function pr(overrides: Partial<NormalizedPr> = {}): NormalizedPr {
  return {
    number: 42,
    title: "Add retry logic",
    body: "Adds retries to the client",
    author: "alice",
    authorAssociation: "CONTRIBUTOR",
    state: "MERGED",
    mergedAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-03T00:00:00Z",
    labels: [],
    files: ["src/net/client.ts", "src/net/backoff.ts", "docs/retries.md"],
    threads: [
      {
        path: "src/net/client.ts",
        line: 10,
        resolved: true,
        comments: [
          {
            author: "bob",
            association: "OWNER",
            body: "We always use exponential backoff with jitter for retries.",
            createdAt: "2026-01-01T10:00:00Z",
          },
        ],
      },
    ],
    reviews: [],
    comments: [],
    ...overrides,
  };
}

function fakeProvider(draft: unknown) {
  const calls: { system?: string; prompt: string }[] = [];
  const provider: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ system, prompt, schema }: CompleteOptions<T>): Promise<T> {
      calls.push({ system, prompt });
      return schema.parse(draft);
    },
  };
  return { provider, calls };
}

const draft = {
  learnings: [
    {
      statement: "Use exponential backoff with jitter for retries",
      rationale: "Avoids thundering-herd on recovery",
      category: "architecture",
      polarity: "prescriptive",
      quotes: [
        {
          author: "bob",
          association: "OWNER",
          quote: "We always use exponential backoff with jitter for retries.",
          createdAt: "2026-01-01T10:00:00Z",
        },
      ],
    },
  ],
};

test("extractOne maps the draft to CandidateLearning, injecting pr and default scope", async () => {
  const { provider } = fakeProvider(draft);
  const out = await extractOne(pr(), provider);
  expect(out).toHaveLength(1);
  const c = out[0]!;
  expect(CandidateLearningSchema.parse(c)).toEqual(c);
  expect(c.evidence[0]!.pr).toBe(42); // injected by code, not the LLM
  expect(c.scope.sort()).toEqual(["docs/**", "src/net/**"]); // unique dirs of pr.files
});

test("extractOne keeps an explicit LLM-provided scope", async () => {
  const { provider } = fakeProvider({
    learnings: [{ ...draft.learnings[0], scope: ["src/net/**"] }],
  });
  const out = await extractOne(pr(), provider);
  expect(out[0]!.scope).toEqual(["src/net/**"]);
});

test("extractOne returns [] when the model finds nothing", async () => {
  const { provider } = fakeProvider({ learnings: [] });
  expect(await extractOne(pr(), provider)).toEqual([]);
});

test("the prompt is intent-neutral and carries the discussion; body/discussion caps hold", async () => {
  const { provider, calls } = fakeProvider(draft);
  const big = pr({
    body: "B".repeat(5000),
    comments: Array.from({ length: 200 }, (_, i) => ({
      author: "carol",
      association: "MEMBER" as const,
      body: `comment ${i} ${"x".repeat(200)}`,
      createdAt: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
    })),
  });
  await extractOne(big, provider);
  const { system, prompt } = calls[0]!;
  expect(prompt).toContain("exponential backoff"); // thread comment present
  expect(prompt).not.toMatch(/intent/i); // structurally intent-free
  expect(system).not.toMatch(/intent/i);
  const bodyRun = prompt.match(/B+/)?.[0] ?? "";
  expect(bodyRun.length).toBeLessThanOrEqual(2000); // body cap
  expect(prompt).toContain("[...truncated]"); // discussion cap hit
  expect(renderPrDiscussion(big).length).toBeLessThanOrEqual(12_200); // 12k + marker slack
});

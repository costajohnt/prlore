import { expect, test } from "vitest";
import { MineConfigSchema } from "../src/schemas/mine-config.js";
import { NormalizedPrSchema } from "../src/schemas/normalized-pr.js";
import { CandidateLearningSchema } from "../src/schemas/candidate-learning.js";
import { CheckpointSchema } from "../src/schemas/checkpoint.js";

test("MineConfig applies spec defaults from minimal input", () => {
  const c = MineConfigSchema.parse({ repo: "owner/name", intent: "onboard an AI agent" });
  expect(c.baseUrl).toBe("https://api.github.com");
  expect(c.timeRange.maxPrs).toBe(1500);
  expect(c.output).toEqual({ target: "AGENTS.md", layout: "auto", citations: "inline-light", maxRules: 60 });
  expect(c.model.provider).toBe("auto");
  expect(c.model.maxBudgetUsd).toBe(10);
});

test("MineConfig fills defaults inside partially-provided nested objects", () => {
  const c = MineConfigSchema.parse({
    repo: "owner/name",
    intent: "x",
    timeRange: { maxPrs: 200 },
    model: { provider: "sampling" },
  });
  expect(c.timeRange.maxPrs).toBe(200);
  expect(c.timeRange.since).toBeUndefined();
  expect(c.model.provider).toBe("sampling");
  expect(c.model.maxBudgetUsd).toBe(10);
  expect(c.output.layout).toBe("auto"); // fully-omitted parent still defaults
});

test("MineConfig rejects bad repo and missing intent", () => {
  expect(() => MineConfigSchema.parse({ repo: "not-a-repo", intent: "x" })).toThrow();
  expect(() => MineConfigSchema.parse({ repo: "owner/name" })).toThrow();
});

test("NormalizedPr round-trips a full PR", () => {
  const pr = {
    number: 42, title: "Add widget", body: "", author: "alice",
    authorAssociation: "MEMBER", state: "MERGED",
    mergedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
    labels: ["feature"], files: ["src/widget.ts"],
    threads: [{ path: "src/widget.ts", line: 10, resolved: true,
      comments: [{ author: "bob", association: "OWNER", body: "use the factory here", createdAt: "2026-01-01T01:00:00Z" }] }],
    reviews: [{ author: "bob", association: "OWNER", state: "APPROVED", body: "" }],
    comments: [],
  };
  expect(NormalizedPrSchema.parse(pr)).toEqual(pr);
});

test("CandidateLearning requires at least one evidence entry", () => {
  expect(() =>
    CandidateLearningSchema.parse({
      statement: "Use the factory", category: "architecture",
      polarity: "prescriptive", evidence: [],
    }),
  ).toThrow();
});

test("Checkpoint parses and defaults counters", () => {
  const cp = CheckpointSchema.parse({
    configHash: "abc", stage: "fetching", cursor: null,
    overflowQueue: [], maxUpdatedAt: null,
  });
  expect(cp.counters).toEqual({});
});

test("MineConfig defaults authors to an empty array", () => {
  const c = MineConfigSchema.parse({ repo: "owner/name", intent: "x" });
  expect(c.authors).toEqual([]);
});

test("MineConfig accepts author logins", () => {
  const c = MineConfigSchema.parse({ repo: "owner/name", intent: "x", authors: ["CostaJohnT", "octocat"] });
  expect(c.authors).toEqual(["CostaJohnT", "octocat"]);
});

test("MineConfig rejects an empty-string author entry", () => {
  expect(() => MineConfigSchema.parse({ repo: "owner/name", intent: "x", authors: [""] })).toThrow();
});

// ---- v0.3 Task 4: output.maxRules -------------------------------------------

test("MineConfig accepts a custom output.maxRules", () => {
  const c = MineConfigSchema.parse({ repo: "owner/name", intent: "x", output: { maxRules: 5 } });
  expect(c.output.maxRules).toBe(5);
});

test("MineConfig rejects a zero or negative output.maxRules", () => {
  expect(() => MineConfigSchema.parse({ repo: "owner/name", intent: "x", output: { maxRules: 0 } })).toThrow();
  expect(() => MineConfigSchema.parse({ repo: "owner/name", intent: "x", output: { maxRules: -1 } })).toThrow();
});

test("MineConfig rejects a non-integer output.maxRules", () => {
  expect(() => MineConfigSchema.parse({ repo: "owner/name", intent: "x", output: { maxRules: 1.5 } })).toThrow();
});

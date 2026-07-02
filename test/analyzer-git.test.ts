import { expect, test } from "vitest";
import { realGit } from "../src/analyzer/git.js";
import { buildFixtureRepo } from "./helpers/fixture-repo.js";
import { PatternsModelSchema } from "../src/schemas/patterns-model.js";

test("realGit runs a git command and returns stdout", async () => {
  const repo = await buildFixtureRepo();
  const out = await realGit(["ls-files"], repo);
  const files = out.trim().split("\n").sort();
  expect(files).toContain("legacy/jquery-widget.js");
  expect(files).toContain("src/components/button.ts");
  expect(files).toContain("package.json");
});

test("realGit tolerates exit code 1 (git grep with no matches) by returning empty stdout", async () => {
  const repo = await buildFixtureRepo();
  const out = await realGit(["grep", "-F", "-c", "definitelyNotInRepo_xyz"], repo);
  expect(out).toBe("");
});

test("realGit still throws on real failures (exit code 128)", async () => {
  const repo = await buildFixtureRepo();
  await expect(realGit(["log", "--not-a-real-flag"], repo)).rejects.toThrow();
});

test("fixture repo has the staged migration history", async () => {
  const repo = await buildFixtureRepo();
  const log = await realGit(["log", "--format=%ct %s", "--reverse"], repo);
  const lines = log.trim().split("\n");
  expect(lines).toHaveLength(4);
  const timestamps = lines.map((l) => Number(l.split(" ")[0]));
  expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  expect(timestamps[0]).toBeLessThan(new Date("2024-01-01T00:00:00Z").getTime() / 1000);
  expect(timestamps[3]).toBeGreaterThan(new Date("2026-01-01T00:00:00Z").getTime() / 1000);
});

test("PatternsModelSchema accepts a full model and rejects bad trend values", () => {
  const model = {
    areas: [{ path: "src", stack: [".ts"], recencyScore: 0.9, description: "app code" }],
    patterns: [{ statement: "Use newApi", scope: ["src/**"], exemplars: ["src/app.ts"], confidence: 0.8 }],
    migrations: [{ from: "oldApi", to: "newApi", status: "in-progress",
                   evidence: { oldCount: 3, newCount: 4, trend: "falling" } }],
    meta: { languages: ["typescript"], frameworks: ["react"], tooling: ["eslint"] },
  };
  expect(PatternsModelSchema.parse(model)).toEqual(model);
  expect(() =>
    PatternsModelSchema.parse({ ...model, migrations: [{ ...model.migrations[0], evidence: { oldCount: 1, newCount: 1, trend: "sideways" } }] }),
  ).toThrow();
});

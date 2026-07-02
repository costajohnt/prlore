import { expect, test } from "vitest";
import { realGit } from "../src/analyzer/git.js";
import { grepCount, pickaxeCount, verifyMigrations } from "../src/analyzer/probes.js";
import { buildFixtureRepo } from "./helpers/fixture-repo.js";

const NOW = new Date("2026-07-01T00:00:00Z").getTime();

test("grepCount counts matching lines across files, 0 when absent", async () => {
  const repo = await buildFixtureRepo();
  expect(await grepCount(realGit, repo, "oldApi")).toBe(5); // 1 import line + 1 legacy + 1 app.ts call... see fixture
  expect(await grepCount(realGit, repo, "newApi")).toBe(7);
  expect(await grepCount(realGit, repo, "definitelyNotInRepo_xyz")).toBe(0);
});

test("pickaxeCount buckets commits by date", async () => {
  const repo = await buildFixtureRepo();
  const all = await pickaxeCount(realGit, repo, "oldApi");
  expect(all).toBeGreaterThanOrEqual(3); // 2023 intro, 2024 app, 2026 partial removal
  const recent = await pickaxeCount(realGit, repo, "oldApi", new Date(NOW - 365 * 86400_000).toISOString());
  expect(recent).toBe(1); // only the 2026-05 commit
});

test("verifyMigrations: staged migration comes back in-progress and falling", async () => {
  const repo = await buildFixtureRepo();
  const migrations = await verifyMigrations(
    realGit, repo,
    [
      { from: "oldApi", to: "newApi" },
      { from: "oldApi", to: "nonexistentApi" }, // discarded: new token absent
    ],
    () => NOW,
  );
  expect(migrations).toHaveLength(1);
  const m = migrations[0]!;
  expect(m.status).toBe("in-progress"); // oldApi still present at HEAD
  expect(m.evidence.oldCount).toBeGreaterThan(0);
  expect(m.evidence.newCount).toBeGreaterThan(0);
  expect(m.evidence.trend).toBe("falling"); // 1 recent commit vs 2 prior
});

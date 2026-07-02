import { expect, test } from "vitest";
import { realGit } from "../src/analyzer/git.js";
import { collectHistory, parseCodeowners } from "../src/analyzer/collect.js";
import { buildFixtureRepo } from "./helpers/fixture-repo.js";

test("collectHistory computes lastTouched, commitCount, and recency percentiles", async () => {
  const repo = await buildFixtureRepo();
  const h = await collectHistory(realGit, repo);

  expect(h.files).toContain("src/app.ts");
  expect(h.commitCount.get("src/app.ts")).toBe(2); // 2024 + 2026-05 commits
  expect(h.commitCount.get("legacy/util.js")).toBe(1);

  const appTouched = h.lastTouched.get("src/app.ts")!;
  expect(new Date(appTouched * 1000).getUTCFullYear()).toBe(2026);

  // legacy files (2023) must rank below src files (2024+)
  expect(h.recencyPercentile.get("legacy/util.js")!).toBeLessThan(
    h.recencyPercentile.get("src/app.ts")!,
  );
  // newest files share the top percentile band
  expect(h.recencyPercentile.get("src/components/input.ts")!).toBeGreaterThan(0.5);
  for (const p of h.recencyPercentile.values()) {
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1.0001);
  }
});

test("collectHistory ignores files deleted before HEAD", async () => {
  const repo = await buildFixtureRepo();
  const h = await collectHistory(realGit, repo);
  for (const f of h.commitCount.keys()) {
    expect(h.files).toContain(f);
  }
});

test("parseCodeowners extracts patterns and owners, skipping comments/blanks", () => {
  const entries = parseCodeowners(`# comment\n\nsrc/ @alice @bob\nlegacy/ @carol\n*.md @docs-team\n`);
  expect(entries).toEqual([
    { pattern: "src/", owners: ["@alice", "@bob"] },
    { pattern: "legacy/", owners: ["@carol"] },
    { pattern: "*.md", owners: ["@docs-team"] },
  ]);
});

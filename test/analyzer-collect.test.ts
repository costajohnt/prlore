import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { realGit } from "../src/analyzer/git.js";
import { collectHistory, ownersForPath, parseCodeowners } from "../src/analyzer/collect.js";
import { buildFixtureRepo } from "./helpers/fixture-repo.js";

const run = promisify(execFile);

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
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
    GIT_AUTHOR_DATE: "2026-06-15T12:00:00Z",
    GIT_COMMITTER_DATE: "2026-06-15T12:00:00Z",
  };
  await run("git", ["rm", "-q", "legacy/util.js"], { cwd: repo, env });
  await run("git", ["commit", "-q", "-m", "drop legacy util"], { cwd: repo, env });

  const h = await collectHistory(realGit, repo);

  expect(h.files).not.toContain("legacy/util.js");
  expect(h.commitCount.has("legacy/util.js")).toBe(false);
  expect(h.lastTouched.has("legacy/util.js")).toBe(false);
  expect(h.commitCount.get("src/app.ts")).toBe(2);
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

test("ownersForPath: * catch-all matches any path", () => {
  const entries = [{ pattern: "*", owners: ["@everyone"] }];
  expect(ownersForPath(entries, "src/components")).toEqual(["@everyone"]);
  expect(ownersForPath(entries, "legacy")).toEqual(["@everyone"]);
});

test("ownersForPath: leading-slash pattern anchors and still matches by area-prefix", () => {
  const entries = [{ pattern: "/src/", owners: ["@root-src"] }];
  expect(ownersForPath(entries, "src/components")).toEqual(["@root-src"]);
});

test("ownersForPath: nested override, last-match-wins", () => {
  const entries = [
    { pattern: "src/", owners: ["@alice"] },
    { pattern: "src/components/", owners: ["@bob"] },
  ];
  expect(ownersForPath(entries, "src/components")).toEqual(["@bob"]);
  expect(ownersForPath(entries, "src/util")).toEqual(["@alice"]);
});

test("ownersForPath: no match returns undefined", () => {
  const entries = [{ pattern: "src/", owners: ["@alice"] }];
  expect(ownersForPath(entries, "docs")).toBeUndefined();
});

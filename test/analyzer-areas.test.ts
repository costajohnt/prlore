import { expect, test } from "vitest";
import { realGit } from "../src/analyzer/git.js";
import { collectHistory } from "../src/analyzer/collect.js";
import { detectAreas, pickExemplars } from "../src/analyzer/areas.js";
import { collectTooling } from "../src/analyzer/tooling.js";
import { buildFixtureRepo } from "./helpers/fixture-repo.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function fixtureHistory() {
  const repo = await buildFixtureRepo();
  return { repo, history: await collectHistory(realGit, repo) };
}

test("detectAreas splits legacy/ and src/components/, scoring recency", async () => {
  const { history } = await fixtureHistory();
  const areas = detectAreas(history);
  const byPath = new Map(areas.map((a) => [a.path, a]));

  expect(byPath.has("legacy")).toBe(true);
  expect(byPath.has("src/components")).toBe(true);
  expect(byPath.get("legacy")!.stack).toContain(".js");
  expect(byPath.get("src/components")!.stack).toContain(".ts");
  expect(byPath.get("src/components")!.recencyScore).toBeGreaterThan(
    byPath.get("legacy")!.recencyScore,
  );
});

test("root-level files do not form an area", async () => {
  const { history } = await fixtureHistory();
  const areas = detectAreas(history);
  expect(areas.every((a) => a.path !== ".")).toBe(true);
});

test("pickExemplars ranks by recency x churn and honors focusAreas with a bigger K", async () => {
  const { history } = await fixtureHistory();
  const areas = detectAreas(history, { minFiles: 1 });
  const plain = pickExemplars(areas, history);
  expect(plain.length).toBeLessThanOrEqual(25);
  const componentsPicks = plain.filter((e) => e.area === "src/components").map((e) => e.path);
  expect(componentsPicks.length).toBeGreaterThan(0);

  const focused = pickExemplars(areas, history, ["legacy/**"]);
  const legacyPlain = plain.filter((e) => e.area === "legacy").length;
  const legacyFocused = focused.filter((e) => e.area === "legacy").length;
  expect(legacyFocused).toBeGreaterThanOrEqual(legacyPlain);
});

test("focusAreas bumps K from 5 to 8 when the area has enough files", () => {
  const files = Array.from({ length: 10 }, (_, i) => `pkg/mod/file${i}.ts`);
  const history = {
    files,
    lastTouched: new Map(files.map((f, i) => [f, 1000 + i])),
    commitCount: new Map(files.map((f) => [f, 1])),
    recencyPercentile: new Map(files.map((f, i) => [f, i / 9])),
  };
  const areas = detectAreas(history);
  expect(areas.map((a) => a.path)).toEqual(["pkg"]);
  expect(pickExemplars(areas, history)).toHaveLength(5);
  const focused = pickExemplars(areas, history, ["pkg/**"]);
  expect(focused).toHaveLength(8);
  // ranked by recency x churn: highest percentiles first
  expect(focused[0]!.path).toBe("pkg/mod/file9.ts");
});

test("collectTooling reports languages, frameworks, tooling from the fixture", async () => {
  const { repo, history } = await fixtureHistory();
  const t = await collectTooling(history.files, (p) => readFile(join(repo, p), "utf8"));
  expect(t.languages).toContain("typescript");
  expect(t.languages).toContain("javascript");
  expect(t.frameworks).toContain("react");
  expect(t.tooling).toContain("eslint");
});

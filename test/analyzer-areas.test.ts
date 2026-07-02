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

test("collectTooling reports languages, frameworks, tooling from the fixture", async () => {
  const { repo, history } = await fixtureHistory();
  const t = await collectTooling(history.files, (p) => readFile(join(repo, p), "utf8"));
  expect(t.languages).toContain("typescript");
  expect(t.languages).toContain("javascript");
  expect(t.frameworks).toContain("react");
  expect(t.tooling).toContain("eslint");
});

import { chmod, readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { CompleteOptions, ModelProvider } from "../src/model/provider.js";
import { MineConfigSchema } from "../src/schemas/mine-config.js";
import { PatternsModelSchema } from "../src/schemas/patterns-model.js";
import { analyze } from "../src/analyzer/analyze.js";
import { buildFixtureRepo } from "./helpers/fixture-repo.js";

const NOW = new Date("2026-07-01T00:00:00Z").getTime();

function fakeProvider(draft: unknown): { provider: ModelProvider; prompts: string[] } {
  const prompts: string[] = [];
  const provider: ModelProvider = {
    spentUsd: () => 0.01,
    async complete<T>({ prompt, schema }: CompleteOptions<T>): Promise<T> {
      prompts.push(prompt);
      return schema.parse(draft);
    },
  };
  return { provider, prompts };
}

const draft = {
  areaDescriptions: [
    { path: "src/components", description: "React-style components on newApi" },
    { path: "legacy", description: "jQuery-era code, do not copy" },
  ],
  patterns: [
    { statement: "Use newApi for all new modules", scope: ["src/**"], exemplars: ["src/components/button.ts"], confidence: 0.9 },
  ],
  migrationCandidates: [
    { from: "oldApi", to: "newApi" },
    { from: "oldApi", to: "nonexistentApi" },
  ],
};

test("analyze composes collectors, LLM draft, and probe verification into a valid PatternsModel", async () => {
  const repo = await buildFixtureRepo();
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-analyze-"));
  const { provider, prompts } = fakeProvider(draft);
  const config = MineConfigSchema.parse({ repo: "o/r", intent: "onboard an AI agent to this repo" });

  const model = await analyze(repo, config, { provider, now: () => NOW, stateDir });

  expect(PatternsModelSchema.parse(model)).toEqual(model);
  expect(model.meta.frameworks).toContain("react");
  expect(model.patterns[0]!.statement).toMatch(/newApi/);

  // probes decided migrations: candidate 2 discarded, candidate 1 verified
  expect(model.migrations).toHaveLength(1);
  expect(model.migrations[0]).toMatchObject({
    from: "oldApi", to: "newApi", status: "in-progress",
    evidence: { trend: "falling" },
  });

  // areas carry LLM descriptions and CODEOWNERS owners
  const components = model.areas.find((a) => a.path === "src/components");
  expect(components?.description).toMatch(/components/i);
  expect(components?.owners).toEqual(["@alice", "@bob"]);

  // the single prompt contains intent, area table, and exemplar excerpts
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("onboard an AI agent");
  expect(prompts[0]).toContain("src/components");
  expect(prompts[0]).toContain("newApi(\"button\")");

  // patterns.json persisted and identical
  const onDisk = JSON.parse(await readFile(join(stateDir, "patterns.json"), "utf8"));
  expect(onDisk).toEqual(model);
});

test("analyze works without stateDir and skips unreadable exemplars", async () => {
  const repo = await buildFixtureRepo();
  await chmod(join(repo, "legacy/util.js"), 0o000);
  const { provider, prompts } = fakeProvider(draft);
  const config = MineConfigSchema.parse({ repo: "o/r", intent: "x" });
  const model = await analyze(repo, config, { provider, now: () => NOW });
  expect(model.areas.length).toBeGreaterThan(0);
  // the readable exemplar text made it into the prompt...
  expect(prompts[0]).toContain('newApi("button")');
  // ...but the unreadable file's unique content did not
  expect(prompts[0]).not.toContain("helper()");
});

import { mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { appendJsonl } from "../src/state/jsonl.js";
import { readCorpus } from "../src/state/corpus.js";
import { configHash } from "../src/github/config-hash.js";
import { MineConfigSchema } from "../src/schemas/mine-config.js";

const validPr = (number: number) => ({
  number,
  title: "t",
  body: "",
  author: "alice",
  authorAssociation: "MEMBER",
  state: "MERGED",
  mergedAt: null,
  updatedAt: "2026-01-01T00:00:00Z",
  labels: [],
  files: [],
  threads: [],
  reviews: [],
  comments: [],
});

test("readCorpus returns valid PRs and counts drifted lines instead of throwing", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "prlore-corpus-")), "corpus.jsonl");
  await appendJsonl(file, validPr(1));
  await appendJsonl(file, { number: 2, totally: "wrong shape" });
  await appendJsonl(file, validPr(3));
  const { prs, drifted } = await readCorpus(file);
  expect(prs.map((p) => p.number)).toEqual([1, 3]);
  expect(drifted).toBe(1);
});

test("readCorpus counts every drifted line lacking a numeric number", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "prlore-corpus-")), "corpus.jsonl");
  await appendJsonl(file, validPr(1));
  await appendJsonl(file, { oops: true });
  await appendJsonl(file, "just a string");
  const { prs, drifted } = await readCorpus(file);
  expect(prs.map((p) => p.number)).toEqual([1]);
  expect(drifted).toBe(2);
});

test("readCorpus dedups by PR number, last write wins", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "prlore-corpus-")), "corpus.jsonl");
  await appendJsonl(file, validPr(1));
  await appendJsonl(file, { ...validPr(1), title: "updated" });
  const { prs } = await readCorpus(file);
  expect(prs).toHaveLength(1);
  expect(prs[0]!.title).toBe("updated");
});

test("configHash is stable and ignores intent/output changes", () => {
  const base = MineConfigSchema.parse({ repo: "o/r", intent: "onboarding" });
  const differentIntent = MineConfigSchema.parse({ repo: "o/r", intent: "enforcement" });
  const differentRepo = MineConfigSchema.parse({ repo: "o/other", intent: "onboarding" });
  expect(configHash(base)).toBe(configHash(differentIntent));
  expect(configHash(base)).not.toBe(configHash(differentRepo));
  expect(configHash(base)).toMatch(/^[0-9a-f]{64}$/);
});

test("configHash changes when authors filter changes, normalized case/order-insensitive", () => {
  const base = MineConfigSchema.parse({ repo: "o/r", intent: "onboarding" });
  const withAlice = MineConfigSchema.parse({ repo: "o/r", intent: "onboarding", authors: ["alice"] });
  const withBob = MineConfigSchema.parse({ repo: "o/r", intent: "onboarding", authors: ["bob"] });
  expect(configHash(withAlice)).not.toBe(configHash(base));
  expect(configHash(withAlice)).not.toBe(configHash(withBob));

  const mixedCase = MineConfigSchema.parse({
    repo: "o/r",
    intent: "onboarding",
    authors: ["Alice", "BOB"],
  });
  const reorderedLower = MineConfigSchema.parse({
    repo: "o/r",
    intent: "onboarding",
    authors: ["bob", "alice"],
  });
  expect(configHash(mixedCase)).toBe(configHash(reorderedLower));
});

test("configHash for an empty/absent authors filter matches the pre-authors-feature hash", () => {
  const base = MineConfigSchema.parse({ repo: "o/r", intent: "onboarding" });
  const explicitEmpty = MineConfigSchema.parse({ repo: "o/r", intent: "onboarding", authors: [] });
  expect(configHash(base)).toBe(configHash(explicitEmpty));

  // Pinned against the identity shape as it existed before `authors` was added,
  // so old .prlore stateDirs (checkpoints hashed pre-feature) keep resuming
  // instead of silently refetching everything on upgrade.
  const preFeatureHash = createHash("sha256")
    .update(
      JSON.stringify({
        repo: "o/r",
        baseUrl: "https://api.github.com",
        since: null,
        maxPrs: 1500,
      }),
    )
    .digest("hex");
  expect(configHash(base)).toBe(preFeatureHash);
});

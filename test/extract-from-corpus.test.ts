import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { CompleteOptions, ModelProvider } from "../src/model/provider.js";
import { appendJsonl } from "../src/state/jsonl.js";
import { loadCheckpoint, saveCheckpoint } from "../src/state/checkpoint.js";
import { extractFromCorpus } from "../src/extractor/from-corpus.js";

const validPr = (number: number) => ({
  number, title: "t", body: "", author: "a", authorAssociation: "MEMBER",
  state: "MERGED", mergedAt: null, updatedAt: "2026-01-01T00:00:00Z",
  labels: [], files: ["src/x.ts"],
  threads: [{ path: "src/x.ts", line: 1, resolved: true,
    comments: [{ author: "o", association: "OWNER", body: "always do X", createdAt: "2026-01-01T00:00:00Z" }] }],
  reviews: [], comments: [],
});

const draft = {
  learnings: [{
    statement: "Do X", category: "style", polarity: "prescriptive",
    quotes: [{ author: "o", association: "OWNER", quote: "always do X", createdAt: "2026-01-01T00:00:00Z" }],
  }],
};

const okProvider = (): ModelProvider => ({
  spentUsd: () => 0,
  async complete<T>({ schema }: CompleteOptions<T>): Promise<T> {
    return schema.parse(draft);
  },
});

test("extracts every valid corpus line, counts drift, flips the stage from extracting", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-fromcorpus-"));
  const corpus = join(stateDir, "corpus.jsonl");
  await appendJsonl(corpus, validPr(1));
  await appendJsonl(corpus, { number: 2, garbage: true });
  await appendJsonl(corpus, validPr(3));
  await saveCheckpoint(stateDir, {
    configHash: "h", stage: "extracting", cursor: null,
    overflowQueue: [], maxUpdatedAt: null, counters: {},
  });

  const s = await extractFromCorpus(stateDir, { provider: okProvider() });
  expect(s).toMatchObject({ prsSeen: 2, extracted: 2, drifted: 1, candidates: 2 });
  const onDisk = JSON.parse(await readFile(join(stateDir, "candidates.json"), "utf8"));
  expect(onDisk).toHaveLength(2);
  expect((await loadCheckpoint(stateDir))?.stage).toBe("analyzing");
});

test("does not regress a later-stage checkpoint, and tolerates a missing one", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "prlore-fromcorpus-"));
  await appendJsonl(join(stateDir, "corpus.jsonl"), validPr(1));
  await saveCheckpoint(stateDir, {
    configHash: "h", stage: "synthesizing", cursor: null,
    overflowQueue: [], maxUpdatedAt: null, counters: {},
  });
  await extractFromCorpus(stateDir, { provider: okProvider() });
  expect((await loadCheckpoint(stateDir))?.stage).toBe("synthesizing");

  const bare = await mkdtemp(join(tmpdir(), "prlore-fromcorpus-"));
  await appendJsonl(join(bare, "corpus.jsonl"), validPr(1));
  const s = await extractFromCorpus(bare, { provider: okProvider() }); // no checkpoint: fine
  expect(s.extracted).toBe(1);
});

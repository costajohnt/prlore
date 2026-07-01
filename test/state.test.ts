import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { appendJsonl, readJsonl, CorruptStateError } from "../src/state/jsonl.js";
import { loadCheckpoint, saveCheckpoint } from "../src/state/checkpoint.js";
import type { Checkpoint } from "../src/schemas/checkpoint.js";

const parseRec = (raw: unknown) => raw as { id: number; v: string };
const tmp = () => mkdtemp(join(tmpdir(), "prlore-test-"));

test("readJsonl returns [] for a missing file", async () => {
  expect(await readJsonl(join(await tmp(), "nope.jsonl"), parseRec, (r) => r.id)).toEqual([]);
});

test("append + read round-trips and dedups by key, last write wins", async () => {
  const file = join(await tmp(), "corpus.jsonl");
  await appendJsonl(file, { id: 1, v: "a" });
  await appendJsonl(file, { id: 2, v: "b" });
  await appendJsonl(file, { id: 1, v: "c" });
  expect(await readJsonl(file, parseRec, (r) => r.id)).toEqual([
    { id: 1, v: "c" }, { id: 2, v: "b" },
  ]);
});

test("a torn final line (crash mid-append) is skipped, not fatal", async () => {
  const file = join(await tmp(), "corpus.jsonl");
  await appendJsonl(file, { id: 1, v: "a" });
  await writeFile(file, (await readFile(file, "utf8")) + '{"id":2,"v":"tr', "utf8");
  expect(await readJsonl(file, parseRec, (r) => r.id)).toEqual([{ id: 1, v: "a" }]);
});

test("corruption in the middle throws CorruptStateError with location", async () => {
  const file = join(await tmp(), "corpus.jsonl");
  await writeFile(file, '{"id":1,"v":"a"}\nnot json\n{"id":2,"v":"b"}\n{"id":3,"v":"c"}\n', "utf8");
  await expect(readJsonl(file, parseRec, (r) => r.id)).rejects.toThrow(CorruptStateError);
});

const cp: Checkpoint = {
  configHash: "abc", stage: "fetching", cursor: "Y3Vyc29y",
  overflowQueue: [7], maxUpdatedAt: "2026-01-02T00:00:00Z", counters: { kept: 5 },
};

test("checkpoint save/load round-trips; load of missing dir is null", async () => {
  const dir = join(await tmp(), ".prlore");
  expect(await loadCheckpoint(dir)).toBeNull();
  await saveCheckpoint(dir, cp);
  expect(await loadCheckpoint(dir)).toEqual(cp);
});

test("corrupt checkpoint is quarantined and load returns null", async () => {
  const dir = join(await tmp(), ".prlore");
  await saveCheckpoint(dir, cp);
  await writeFile(join(dir, "checkpoint.json"), "{ broken", "utf8");
  expect(await loadCheckpoint(dir, () => 1234)).toBeNull();
  expect(await readdir(join(dir, "corrupt-1234"))).toEqual(["checkpoint.json"]);
  expect(await loadCheckpoint(dir)).toBeNull(); // original is gone, not re-read
});

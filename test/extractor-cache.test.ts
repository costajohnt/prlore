import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { NormalizedPr } from "../src/schemas/normalized-pr.js";
import { cacheKey, readCache, writeCache } from "../src/extractor/cache.js";

const basePr = { number: 7, updatedAt: "2026-01-01T00:00:00Z" } as NormalizedPr;
const candidates = [
  {
    statement: "s",
    category: "style" as const,
    scope: [],
    polarity: "prescriptive" as const,
    evidence: [{ pr: 7, author: "a", association: "OWNER" as const, quote: "q", createdAt: "2026-01-01T00:00:00Z" }],
  },
];

test("cacheKey varies with number, updatedAt, and model", () => {
  const k = cacheKey(basePr, "m1");
  expect(k).toMatch(/^[0-9a-f]{64}$/);
  expect(cacheKey({ ...basePr, number: 8 } as NormalizedPr, "m1")).not.toBe(k);
  expect(cacheKey({ ...basePr, updatedAt: "2026-02-01T00:00:00Z" } as NormalizedPr, "m1")).not.toBe(k);
  expect(cacheKey(basePr, "m2")).not.toBe(k);
  expect(cacheKey(basePr, "m1")).toBe(k); // stable
});

test("write/read round-trip; stale key (changed updatedAt) misses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prlore-xcache-"));
  expect(await readCache(dir, basePr, "m1")).toBeNull(); // cold
  await writeCache(dir, basePr, "m1", candidates);
  expect(await readCache(dir, basePr, "m1")).toEqual(candidates); // hit
  const updated = { ...basePr, updatedAt: "2026-03-01T00:00:00Z" } as NormalizedPr;
  expect(await readCache(dir, updated, "m1")).toBeNull(); // same file, stale key
});

test("corrupt cache file reads as miss, never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prlore-xcache-"));
  await writeCache(dir, basePr, "m1", candidates);
  await writeFile(join(dir, "extraction-cache", "7.json"), "{ broken", "utf8");
  expect(await readCache(dir, basePr, "m1")).toBeNull();
});

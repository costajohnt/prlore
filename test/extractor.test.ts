import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { CompleteOptions, ModelProvider } from "../src/model/provider.js";
import { BudgetExceededError } from "../src/model/provider.js";
import type { NormalizedPr } from "../src/schemas/normalized-pr.js";
import { createLimiter } from "../src/extractor/pool.js";
import { Extractor } from "../src/extractor/extractor.js";

function pr(number: number): NormalizedPr {
  return {
    number, title: `t${number}`, body: "", author: "a", authorAssociation: "MEMBER",
    state: "MERGED", mergedAt: null, updatedAt: "2026-01-01T00:00:00Z",
    labels: [], files: ["src/x.ts"],
    threads: [{ path: "src/x.ts", line: 1, resolved: true,
      comments: [{ author: "o", association: "OWNER", body: "always do X", createdAt: "2026-01-01T00:00:00Z" }] }],
    reviews: [], comments: [],
  };
}

const draft = {
  learnings: [{
    statement: "Do X", category: "style", polarity: "prescriptive",
    quotes: [{ author: "o", association: "OWNER", quote: "always do X", createdAt: "2026-01-01T00:00:00Z" }],
  }],
};

function provider(behavior: (n: number) => "ok" | "fail" | "budget") {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const p: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ schema }: CompleteOptions<T>): Promise<T> {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const mode = behavior(calls);
      if (mode === "fail") throw new Error("api down");
      if (mode === "budget") throw new BudgetExceededError(10, 10);
      return schema.parse(draft);
    },
  };
  return { p, stats: () => ({ calls, maxInFlight }) };
}

const dir = () => mkdtemp(join(tmpdir(), "prlore-extractor-"));

test("createLimiter caps concurrency", async () => {
  const limit = createLimiter(2);
  let inFlight = 0;
  let maxSeen = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      limit(async () => {
        inFlight++;
        maxSeen = Math.max(maxSeen, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      }),
    ),
  );
  expect(maxSeen).toBe(2);
});

test("createLimiter hands slots off without a barge-in window under streaming interleave", async () => {
  // For each microtask-tick offset, fill the cap, enqueue one more caller than
  // capacity (a genuine waiter — mirrors streaming, where more work is enqueued
  // than the concurrency cap), release one active task, then — at that tick
  // offset — issue a brand-new call. The old release path (`active--` then wake)
  // left a window between the decrement and the woken waiter's own `active++`
  // where a fresh caller could slip in and push concurrency past the cap.
  const cap = 2;
  for (let ticks = 0; ticks <= 6; ticks++) {
    const limit = createLimiter(cap);
    let inFlight = 0;
    let maxInFlight = 0;
    const release: (() => void)[] = [];
    const start = () =>
      limit(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight--;
      });

    const p1 = start();
    const p2 = start(); // fills the cap
    const p3 = start(); // more work than capacity: a genuine waiter
    for (let i = 0; i < 5; i++) await Promise.resolve();

    release.shift()!(); // release one slot, waking the waiter
    for (let i = 0; i < ticks; i++) await Promise.resolve();
    const p4 = start(); // a fresh call landing during the handoff window

    const all = [p1, p2, p3, p4];
    let done = false;
    void Promise.all(all).then(() => (done = true));
    for (let guard = 0; !done && guard < 10_000; guard++) {
      if (release.length) release.shift()!();
      await Promise.resolve();
    }
    await Promise.all(all);

    expect(maxInFlight).toBeLessThanOrEqual(cap);
  }
});

test("extracts, caches, and a re-enqueued identical PR after drain is a cache hit on a NEW extractor", async () => {
  const stateDir = await dir();
  const { p, stats } = provider(() => "ok");
  const x1 = new Extractor({ provider: p, stateDir });
  x1.enqueue(pr(1));
  const s1 = await x1.drain();
  expect(s1).toMatchObject({ prsSeen: 1, extracted: 1, cacheHits: 0, candidates: 1 });
  const x2 = new Extractor({ provider: p, stateDir });
  x2.enqueue(pr(1));
  const s2 = await x2.drain();
  expect(s2).toMatchObject({ prsSeen: 1, extracted: 0, cacheHits: 1, candidates: 1 });
  expect(stats().calls).toBe(1); // one LLM call total across both runs
  const onDisk = JSON.parse(await readFile(join(stateDir, "candidates.json"), "utf8"));
  expect(onDisk).toHaveLength(1);
});

test("duplicate enqueue in the same run is dropped, not double-extracted", async () => {
  const stateDir = await dir();
  const { p, stats } = provider(() => "ok");
  const x = new Extractor({ provider: p, stateDir });
  x.enqueue(pr(2));
  x.enqueue(pr(2)); // at-least-once delivery from the fetcher
  const s = await x.drain();
  expect(s).toMatchObject({ prsSeen: 1, duplicates: 1, extracted: 1 });
  expect(stats().calls).toBe(1);
});

test("persistent failure retries 3x then skips; run still succeeds", async () => {
  const stateDir = await dir();
  const { p, stats } = provider(() => "fail");
  const x = new Extractor({ provider: p, stateDir });
  x.enqueue(pr(3));
  x.enqueue(pr(4));
  const s = await x.drain();
  expect(s).toMatchObject({ failed: 2, extracted: 0, candidates: 0 });
  expect(stats().calls).toBe(6); // 3 attempts each
});

test("writeCache failure is non-fatal: extraction still counts, candidate still collected, no retry", async () => {
  const stateDir = await dir();
  // Make the cache dir uncreatable: a plain file sits where writeCache wants a directory.
  await writeFile(join(stateDir, "extraction-cache"), "not a directory", "utf8");
  const { p, stats } = provider(() => "ok");
  const x = new Extractor({ provider: p, stateDir });
  x.enqueue(pr(40));
  const s = await x.drain();
  expect(s).toMatchObject({ extracted: 1, failed: 0, candidates: 1 });
  expect(stats().calls).toBe(1); // no retry paid for the cache-write failure
});

test("budget exhaustion does not skip a free cache hit", async () => {
  const stateDir = await dir();
  // Warm the cache for PR A with a successful run.
  const warm = provider(() => "ok");
  const warmup = new Extractor({ provider: warm.p, stateDir });
  warmup.enqueue(pr(50));
  await warmup.drain();

  const tripper = provider(() => "budget");
  const x = new Extractor({ provider: tripper.p, stateDir, concurrency: 1 });
  x.enqueue(pr(51)); // B: needs a provider call, trips the budget
  x.enqueue(pr(50)); // A: cached, must still be collected for free post-trip
  const s = await x.drain();
  expect(s).toMatchObject({ cacheHits: 1, skippedBudget: 1, failed: 0, candidates: 1 });
});

test("budget exhaustion stops later work without provider calls", async () => {
  const stateDir = await dir();
  const { p, stats } = provider(() => "budget");
  const x = new Extractor({ provider: p, stateDir, concurrency: 1 });
  x.enqueue(pr(5));
  x.enqueue(pr(6));
  x.enqueue(pr(7));
  const s = await x.drain();
  expect(stats().calls).toBe(1); // first call trips the budget; no retries, no further calls
  expect(s.skippedBudget).toBe(3); // the tripped item + the two never-started
  expect(s.failed).toBe(0);
});

test("drain() returns a snapshot, not live state", async () => {
  const stateDir = await dir();
  const { p } = provider(() => "ok");
  const x = new Extractor({ provider: p, stateDir });
  x.enqueue(pr(20));
  const s1 = await x.drain();
  expect(s1).toEqual({
    prsSeen: 1, extracted: 1, cacheHits: 0, failed: 0,
    skippedBudget: 0, duplicates: 0, candidates: 1,
  });
  s1.extracted = 999;
  const s2 = await x.drain();
  expect(s2.extracted).toBe(1);
});

test("enqueue after drain throws", async () => {
  const stateDir = await dir();
  const { p } = provider(() => "ok");
  const x = new Extractor({ provider: p, stateDir });
  x.enqueue(pr(30));
  await x.drain();
  expect(() => x.enqueue(pr(99))).toThrow(/after drain/);
});

test("extractor respects the concurrency cap", async () => {
  const stateDir = await dir();
  const { p, stats } = provider(() => "ok");
  const x = new Extractor({ provider: p, stateDir, concurrency: 2 });
  for (let i = 10; i < 18; i++) x.enqueue(pr(i));
  await x.drain();
  expect(stats().maxInFlight).toBeLessThanOrEqual(2);
});

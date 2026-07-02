import { expect, test } from "vitest";
import type { EvidenceRecord } from "../src/schemas/provenance.js";
import {
  INCLUDE_THRESHOLD, SCORING, authorityOf, corroborationOf, recencyOf, recurrenceOf, scoreRule,
} from "../src/reconciler/score.js";

const NOW = new Date("2026-07-01T00:00:00Z").getTime();
const ev = (o: Partial<EvidenceRecord>): EvidenceRecord => ({
  pr: 1, author: "a", association: "OWNER", quote: "q",
  createdAt: "2026-06-01T00:00:00Z", verified: true, ...o,
});

test("authority: max over verified entries; unverified capped at drive-by weight", () => {
  expect(authorityOf([ev({ association: "OWNER" })])).toBe(1);
  expect(authorityOf([ev({ association: "CONTRIBUTOR" })])).toBe(0.5);
  expect(authorityOf([ev({ association: "NONE" })])).toBe(0.25);
  expect(authorityOf([ev({ association: "OWNER", verified: false })])).toBe(0.25); // spoof-proof
  expect(authorityOf([ev({ association: "OWNER", verified: false }), ev({ association: "CONTRIBUTOR" })])).toBe(0.5);
  expect(authorityOf([])).toBe(0.25);
});

test("recurrence: saturating on distinct verified PRs", () => {
  expect(recurrenceOf([ev({ pr: 1 })])).toBe(0.5);
  expect(recurrenceOf([ev({ pr: 1 }), ev({ pr: 2 })])).toBe(0.75);
  expect(recurrenceOf([ev({ pr: 1 }), ev({ pr: 2 }), ev({ pr: 3 }), ev({ pr: 4 })])).toBe(1);
  expect(recurrenceOf([ev({ pr: 1 }), ev({ pr: 1 })])).toBe(0.5); // same PR twice
  expect(recurrenceOf([ev({ pr: 1, verified: false }), ev({ pr: 2 })])).toBe(0.5); // unverified doesn't count
});

test("recency: half-life 12 months on the newest evidence", () => {
  expect(recencyOf([ev({ createdAt: "2026-07-01T00:00:00Z" })], NOW)).toBeCloseTo(1, 2);
  expect(recencyOf([ev({ createdAt: "2025-07-06T00:00:00Z" })], NOW)).toBeCloseTo(0.5, 1); // ~12mo (30d months)
  expect(
    recencyOf([ev({ createdAt: "2020-01-01T00:00:00Z" }), ev({ createdAt: "2026-07-01T00:00:00Z" })], NOW),
  ).toBeCloseTo(1, 2); // newest wins
});

test("corroboration map and the full product", () => {
  expect(corroborationOf("corroborated")).toBe(1);
  expect(corroborationOf("contested")).toBe(0);
  const evidence = [ev({ association: "OWNER", createdAt: "2026-07-01T00:00:00Z" })];
  expect(scoreRule(evidence, "corroborated", NOW)).toBeCloseTo(1 * 0.5 * 1 * 1, 3);
  expect(scoreRule(evidence, "contradicted-stable", NOW)).toBeCloseTo(0.05, 3);
  expect(INCLUDE_THRESHOLD).toBe(0.15);
  expect(SCORING.halfLifeMonths).toBe(12);
});

// ---- Fix 1: unparseable createdAt must not poison Math.max into NaN -------

test("recency: an unparseable createdAt is filtered out, not treated as the newest", () => {
  // "not-a-date" reliably produces Date#getTime() === NaN (verified: new Date("June
  // 2023") actually parses fine in V8, so a genuinely garbage string is used here).
  expect(recencyOf([ev({ createdAt: "not-a-date" })], NOW)).toBe(1); // no valid dates -> treated as undated
  expect(Number.isFinite(recencyOf([ev({ createdAt: "not-a-date" })], NOW))).toBe(true);

  // mixed: the garbage entry is dropped, the valid one still drives the calculation.
  const mixed = recencyOf(
    [ev({ createdAt: "not-a-date" }), ev({ createdAt: "2026-07-01T00:00:00Z" })],
    NOW,
  );
  expect(mixed).toBeCloseTo(1, 2);
  expect(Number.isFinite(mixed)).toBe(true);
});

test("scoreRule stays finite when evidence carries an unparseable createdAt", () => {
  const evidence = [ev({ association: "OWNER", createdAt: "not-a-date" })];
  const score = scoreRule(evidence, "corroborated", NOW);
  expect(Number.isFinite(score)).toBe(true);
  expect(score).toBeCloseTo(1 * 0.5 * 1 * 1, 3); // undated -> no decay, same as recency=1
});

// ---- Fix 5: unobservable scoring omits recency decay (spec §6.3) ----------

test("unobservable: no recency decay — a 2-year-old single-PR OWNER process norm still clears threshold", () => {
  const twoYearsOld = new Date(NOW - 2 * 365 * 86_400_000).toISOString();
  const evidence = [ev({ association: "OWNER", createdAt: twoYearsOld })];
  // authority(OWNER)=1 x recurrence(1 PR)=0.5 x corroboration(unobservable)=0.6 = 0.3
  expect(scoreRule(evidence, "unobservable", NOW)).toBeCloseTo(0.3, 3);
  expect(scoreRule(evidence, "unobservable", NOW)).toBeGreaterThanOrEqual(INCLUDE_THRESHOLD);
});

test("unobservable: score is independent of NOW (no recency term at all)", () => {
  const evidence = [ev({ association: "OWNER", createdAt: "2020-01-01T00:00:00Z" })];
  const farFuture = NOW + 10 * 365 * 86_400_000;
  expect(scoreRule(evidence, "unobservable", NOW)).toBeCloseTo(scoreRule(evidence, "unobservable", farFuture), 6);
});

test("other verdicts still apply recency decay (unchanged behavior)", () => {
  const stale = [ev({ association: "OWNER", createdAt: "2020-01-01T00:00:00Z" })];
  const fresh = [ev({ association: "OWNER", createdAt: "2026-07-01T00:00:00Z" })];
  expect(scoreRule(stale, "corroborated", NOW)).toBeLessThan(scoreRule(fresh, "corroborated", NOW));
});

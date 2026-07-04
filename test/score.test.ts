import { expect, test } from "vitest";
import type { EvidenceRecord } from "../src/schemas/provenance.js";
import {
  INCLUDE_THRESHOLD, RECURRENCE_FLOOR_MIN_PRS, SCORING, authorityOf, corroborationOf,
  failsRecurrenceFloor, recencyOf, recurrenceOf, scoreRule,
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

// ---- Re-review: recency is computed from VERIFIED evidence only -----------

test("recency: a fabricated unverified entry dated now cannot reset the decay clock — verified date wins", () => {
  const staleVerified = ev({ association: "OWNER", createdAt: "2024-07-01T00:00:00Z", verified: true }); // ~2 years old
  const fabricatedFresh = ev({ createdAt: "2026-07-01T00:00:00Z", verified: false }); // model-claimed, never corroborated

  const r = recencyOf([staleVerified, fabricatedFresh], NOW);
  // Computed from the VERIFIED 2024 date: ~24.3 thirty-day months at half-life 12 -> ~0.245.
  // Pre-fix failure mode: the unverified "now" entry wins the max and yields ~1.
  expect(r).toBeLessThan(0.3);
  expect(r).toBeCloseTo(recencyOf([staleVerified], NOW), 6); // identical to verified-only input
});

test("recency: unverified-only evidence gets recency 1 (harmless — score caps below threshold anyway)", () => {
  const unverified = [ev({ association: "OWNER", createdAt: "2026-07-01T00:00:00Z", verified: false })];
  expect(recencyOf(unverified, NOW)).toBe(1);
  // drive-by authority (0.25) x recurrence (0.5, unverified PRs don't count) x 1 x 1 = 0.125
  expect(scoreRule(unverified, "corroborated", NOW)).toBeCloseTo(0.125, 3);
  expect(scoreRule(unverified, "corroborated", NOW)).toBeLessThan(INCLUDE_THRESHOLD);
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

// ---- v0.3 Task 1: recurrence floor -----------------------------------------

test("failsRecurrenceFloor: constant is 2 distinct PRs (documents the binding threshold)", () => {
  expect(RECURRENCE_FLOOR_MIN_PRS).toBe(2);
});

test("failsRecurrenceFloor: a single-PR CONTRIBUTOR-only rule fails the floor", () => {
  expect(failsRecurrenceFloor([ev({ pr: 1, association: "CONTRIBUTOR" })])).toBe(true);
});

test("failsRecurrenceFloor: a single-PR OWNER rule is exempt (maintainer-tier evidence)", () => {
  expect(failsRecurrenceFloor([ev({ pr: 1, association: "OWNER" })])).toBe(false);
});

test("failsRecurrenceFloor: a two-distinct-PR CONTRIBUTOR rule is exempt (recurrence clears it)", () => {
  expect(
    failsRecurrenceFloor([ev({ pr: 1, association: "CONTRIBUTOR" }), ev({ pr: 2, association: "CONTRIBUTOR" })]),
  ).toBe(false);
});

test("failsRecurrenceFloor: the same PR quoted twice is still one distinct PR — fails the floor", () => {
  expect(
    failsRecurrenceFloor([ev({ pr: 1, association: "CONTRIBUTOR" }), ev({ pr: 1, association: "CONTRIBUTOR" })]),
  ).toBe(true);
});

test("failsRecurrenceFloor: an UNVERIFIED OWNER claim cannot buy exemption — spoof-proof like authorityOf", () => {
  expect(failsRecurrenceFloor([ev({ pr: 1, association: "OWNER", verified: false })])).toBe(true);
});

test("failsRecurrenceFloor: an unverified second PR cannot buy exemption via recurrence either", () => {
  expect(
    failsRecurrenceFloor([ev({ pr: 1, association: "CONTRIBUTOR" }), ev({ pr: 2, association: "CONTRIBUTOR", verified: false })]),
  ).toBe(true);
});

test("failsRecurrenceFloor: no evidence at all fails the floor (callers must exempt synthetic rules separately)", () => {
  expect(failsRecurrenceFloor([])).toBe(true);
});

import type { EvidenceRecord, Verdict } from "../schemas/provenance.js";
import { MONTH_MS } from "../util/time.js";
import { HIGH_AUTHORITY } from "./authority.js";

export const SCORING = {
  authority: { high: 1, contributor: 0.5, driveBy: 0.25 },
  recurrenceBase: 0.5,
  recurrencePerPr: 0.25,
  halfLifeMonths: 12,
  corroboration: {
    corroborated: 1,
    "trending-toward": 0.9,
    unobservable: 0.6,
    "trending-away": 0.25,
    "contradicted-stable": 0.1,
    contested: 0,
  } as Record<Verdict, number>,
} as const;

export const INCLUDE_THRESHOLD = 0.15;

export function authorityOf(evidence: EvidenceRecord[]): number {
  let max: number = SCORING.authority.driveBy;
  for (const e of evidence) {
    const w = !e.verified
      ? SCORING.authority.driveBy
      : HIGH_AUTHORITY.has(e.association)
        ? SCORING.authority.high
        : e.association === "CONTRIBUTOR"
          ? SCORING.authority.contributor
          : SCORING.authority.driveBy;
    if (w > max) max = w;
  }
  return max;
}

export function recurrenceOf(evidence: EvidenceRecord[]): number {
  const prs = new Set(evidence.filter((e) => e.verified).map((e) => e.pr));
  return Math.min(1, SCORING.recurrenceBase + SCORING.recurrencePerPr * Math.max(0, prs.size - 1));
}

export function recencyOf(evidence: EvidenceRecord[], now: number): number {
  // Only VERIFIED evidence may drive recency: unverified entries keep the model's
  // claimed createdAt (verification never corrected it), so counting them would let
  // a fabricated "dated today" entry reset the decay clock — the one spoofable
  // scoring factor authority/recurrence already guard against. Unverified-only
  // rules get recency 1, which is harmless: their score is already capped at
  // drive-by authority (0.25) x recurrence (0.5) = 0.125 < INCLUDE_THRESHOLD.
  // Unparseable createdAt values (garbage/corrupted dates) must never poison the
  // max: Math.max(0, NaN, ...) === NaN, which would propagate into scoreRule and
  // crash every downstream sort/threshold check. Filter them out too, then treat
  // "nothing left" the same as "no dated evidence" (synthetic rules) — no decay.
  const times = evidence
    .filter((e) => e.verified)
    .map((e) => new Date(e.createdAt).getTime())
    .filter((t) => !Number.isNaN(t));
  const newest = Math.max(0, ...times);
  if (newest === 0) return 1; // no dated evidence (synthetic rules) — no decay
  const ageMonths = Math.max(0, (now - newest) / MONTH_MS);
  return 2 ** (-ageMonths / SCORING.halfLifeMonths);
}

export function corroborationOf(verdict: Verdict): number {
  return SCORING.corroboration[verdict];
}

export function scoreRule(evidence: EvidenceRecord[], verdict: Verdict, now: number): number {
  if (verdict === "unobservable") {
    // Spec §6.3: keep iff authority × recurrence clears threshold. Recency is
    // deliberately omitted here — process norms (e.g. "PRs need two approvals")
    // aren't re-corroborated by code activity, so time-decay would wrongly kill
    // an otherwise-stable norm just because nobody re-typed it recently.
    return authorityOf(evidence) * recurrenceOf(evidence) * corroborationOf(verdict);
  }
  return authorityOf(evidence) * recurrenceOf(evidence) * recencyOf(evidence, now) * corroborationOf(verdict);
}

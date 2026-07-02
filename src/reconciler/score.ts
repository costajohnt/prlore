import type { EvidenceRecord, Verdict } from "../schemas/provenance.js";

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

const HIGH_AUTHORITY = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const MONTH_MS = 30 * 86_400_000;

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
  const newest = Math.max(0, ...evidence.map((e) => new Date(e.createdAt).getTime()));
  if (newest === 0) return 1; // no dated evidence (synthetic rules) — no decay
  const ageMonths = Math.max(0, (now - newest) / MONTH_MS);
  return 2 ** (-ageMonths / SCORING.halfLifeMonths);
}

export function corroborationOf(verdict: Verdict): number {
  return SCORING.corroboration[verdict];
}

export function scoreRule(evidence: EvidenceRecord[], verdict: Verdict, now: number): number {
  return authorityOf(evidence) * recurrenceOf(evidence) * recencyOf(evidence, now) * corroborationOf(verdict);
}

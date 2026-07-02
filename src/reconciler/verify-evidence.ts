import type { CandidateLearning } from "../schemas/candidate-learning.js";
import type { NormalizedPr } from "../schemas/normalized-pr.js";
import type { EvidenceRecord } from "../schemas/provenance.js";

export type VerifiedCandidate = Omit<CandidateLearning, "evidence"> & {
  evidence: EvidenceRecord[];
};

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

function quotableSurface(pr: NormalizedPr): string {
  const parts = [
    pr.body,
    ...pr.threads.flatMap((t) => t.comments.map((c) => c.body)),
    ...pr.reviews.map((r) => r.body),
    ...pr.comments.map((c) => c.body),
  ];
  return normalize(parts.join(" \n "));
}

export function verifyEvidence(
  candidates: CandidateLearning[],
  prs: NormalizedPr[],
): VerifiedCandidate[] {
  const surfaces = new Map<number, string>(prs.map((p) => [p.number, quotableSurface(p)]));
  return candidates.map((c) => ({
    ...c,
    evidence: c.evidence.map((e) => ({
      ...e,
      verified: surfaces.get(e.pr)?.includes(normalize(e.quote)) ?? false,
    })),
  }));
}

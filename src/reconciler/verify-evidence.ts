import type { CandidateLearning } from "../schemas/candidate-learning.js";
import type { NormalizedPr } from "../schemas/normalized-pr.js";
import type { EvidenceRecord } from "../schemas/provenance.js";

export type VerifiedCandidate = Omit<CandidateLearning, "evidence"> & {
  evidence: EvidenceRecord[];
};

export const MIN_QUOTE_LENGTH = 10; // normalized chars; shorter quotes are too weakly binding to verify

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

function quotableParts(pr: NormalizedPr): string[] {
  return [
    pr.body,
    ...pr.threads.flatMap((t) => t.comments.map((c) => c.body)),
    ...pr.reviews.map((r) => r.body),
    ...pr.comments.map((c) => c.body),
  ].map(normalize);
}

export function verifyEvidence(
  candidates: CandidateLearning[],
  prs: NormalizedPr[],
): VerifiedCandidate[] {
  const surfaces = new Map<number, string[]>(prs.map((p) => [p.number, quotableParts(p)]));
  return candidates.map((c) => ({
    ...c,
    evidence: c.evidence.map((e) => {
      const nq = normalize(e.quote);
      const parts = surfaces.get(e.pr);
      return {
        ...e,
        verified: nq.length >= MIN_QUOTE_LENGTH && (parts?.some((p) => p.includes(nq)) ?? false),
      };
    }),
  }));
}

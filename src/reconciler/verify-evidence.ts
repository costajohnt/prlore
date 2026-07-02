import type { CandidateLearning } from "../schemas/candidate-learning.js";
import type { Association, NormalizedPr } from "../schemas/normalized-pr.js";
import type { EvidenceRecord } from "../schemas/provenance.js";

export type VerifiedCandidate = Omit<CandidateLearning, "evidence"> & {
  evidence: EvidenceRecord[];
};

export const MIN_QUOTE_LENGTH = 10; // normalized chars; shorter quotes are too weakly binding to verify

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

// A quotable part of a PR surface, carrying the CORPUS ground truth for who said it,
// with what association, and when — independent of whatever the model claimed.
interface Part {
  text: string;
  author: string;
  association: Association;
  createdAt: string;
}

function quotableParts(pr: NormalizedPr): Part[] {
  const parts: Part[] = [
    { text: normalize(pr.body), author: pr.author, association: pr.authorAssociation, createdAt: pr.mergedAt ?? pr.updatedAt },
  ];
  for (const thread of pr.threads) {
    for (const c of thread.comments) {
      parts.push({ text: normalize(c.body), author: c.author, association: c.association, createdAt: c.createdAt });
    }
  }
  for (const r of pr.reviews) {
    // Reviews carry no createdAt in the corpus schema; fall back to the PR's updatedAt.
    parts.push({ text: normalize(r.body), author: r.author, association: r.association, createdAt: pr.updatedAt });
  }
  for (const c of pr.comments) {
    parts.push({ text: normalize(c.body), author: c.author, association: c.association, createdAt: c.createdAt });
  }
  return parts;
}

export function verifyEvidence(
  candidates: CandidateLearning[],
  prs: NormalizedPr[],
): VerifiedCandidate[] {
  const surfaces = new Map<number, Part[]>(prs.map((p) => [p.number, quotableParts(p)]));
  return candidates.map((c) => ({
    ...c,
    evidence: c.evidence.map((e) => {
      const nq = normalize(e.quote);
      const parts = surfaces.get(e.pr);
      if (nq.length < MIN_QUOTE_LENGTH || !parts) {
        return { ...e, verified: false };
      }
      // First matching part wins; on a match the model's claimed author/association/
      // createdAt are REPLACED by corpus ground truth — the model's claims are
      // untrusted (that's the whole point of verification), so a match must not
      // let a spoofed claim (e.g. claiming OWNER for a NONE-association comment)
      // survive into the scored record.
      const match = parts.find((p) => p.text.includes(nq));
      if (!match) return { ...e, verified: false };
      return {
        ...e,
        verified: true,
        author: match.author,
        association: match.association,
        createdAt: match.createdAt,
      };
    }),
  }));
}

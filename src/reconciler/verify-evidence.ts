import type { CandidateLearning } from "../schemas/candidate-learning.js";
import type { Association, NormalizedPr } from "../schemas/normalized-pr.js";
import type { EvidenceRecord } from "../schemas/provenance.js";
import { HIGH_AUTHORITY } from "./authority.js";

export type VerifiedCandidate = Omit<CandidateLearning, "evidence"> & {
  evidence: EvidenceRecord[];
};

// Unvalidated heuristic: 10 normalized chars is a guess at "long enough to bind a
// quote to a specific claim rather than matching incidental substrings". Sub-10-char
// legit quotes aren't discarded — verifyEvidence leaves them unverified, which caps
// them at drive-by authority weight in scoring (score.ts) rather than making them
// vanish entirely.
export const MIN_QUOTE_LENGTH = 10; // normalized chars; shorter quotes are too weakly binding to verify

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

// Blockquoted lines are someone ELSE's words, not the part's own author's — strip
// them before matching so an echo (someone quoting a statement back) or a rebuttal
// (an OWNER quoting a claim only to disagree with it) can't be mistaken for that
// part's author having said it themselves.
const stripBlockquotes = (s: string): string =>
  s
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");

function authorityRank(association: Association): number {
  if (HIGH_AUTHORITY.has(association)) return 2;
  if (association === "CONTRIBUTOR") return 1;
  return 0;
}

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
    { text: normalize(stripBlockquotes(pr.body)), author: pr.author, association: pr.authorAssociation, createdAt: pr.mergedAt ?? pr.updatedAt },
  ];
  for (const thread of pr.threads) {
    for (const c of thread.comments) {
      parts.push({ text: normalize(stripBlockquotes(c.body)), author: c.author, association: c.association, createdAt: c.createdAt });
    }
  }
  for (const r of pr.reviews) {
    // Reviews carry no createdAt in the corpus schema; fall back to the PR's updatedAt.
    parts.push({ text: normalize(stripBlockquotes(r.body)), author: r.author, association: r.association, createdAt: pr.updatedAt });
  }
  for (const c of pr.comments) {
    parts.push({ text: normalize(stripBlockquotes(c.body)), author: c.author, association: c.association, createdAt: c.createdAt });
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
      // ALL matching parts are collected (not just the first) and the highest-
      // authority one wins, ties broken by earliest part — a claim quoted verbatim
      // by an OWNER carries more weight than the same words from a drive-by, but
      // ONLY when the OWNER actually said them (blockquoted text was already
      // stripped above, so quoting-to-disagree or quoting-to-echo never counts).
      // On a match the model's claimed author/association/createdAt are REPLACED
      // by corpus ground truth — the model's claims are untrusted (that's the whole
      // point of verification), so a match must not let a spoofed claim (e.g.
      // claiming OWNER for a NONE-association comment) survive into the scored record.
      const matches = parts.filter((p) => p.text.includes(nq));
      if (matches.length === 0) return { ...e, verified: false };
      let match = matches[0]!;
      for (const candidate of matches.slice(1)) {
        if (authorityRank(candidate.association) > authorityRank(match.association)) match = candidate;
      }
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

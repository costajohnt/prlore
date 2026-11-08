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

// Evidence binding (audit 2026-11-07 H2). Verification above proves a quote
// exists in the PR and who wrote it, but the rule's `statement` is model-written
// and was never tied to that quote: a PR body can steer extraction into pairing
// an arbitrary statement with an unrelated maintainer line ("Thanks, closing.")
// and inherit that maintainer's authority. This is a cheap lexical check, no
// extra model call: the share of the statement's content words that also appear
// in the quote.
//
// LOW_CONFIDENCE_OVERLAP = 0.2 means "fewer than one in five of the statement's
// content words appear in the quote". Kept deliberately low because a flagged
// rule is held out of the written file until a human keeps it: a faithful
// paraphrase of a reviewer keeps the key nouns (API, tool, file type) and
// clears it easily, while a statement attached to an unrelated quote scores ~0.
// Raise it only with evidence from real mines that it misses bad bindings.
export const LOW_CONFIDENCE_OVERLAP = 0.2;

// Words that carry no topic: articles, modal/rule verbs, connectives. Dropping
// them stops "we should always use X" from overlapping "always use Y".
const STOPWORDS = new Set(
  ("the and for are but not you all any can our out use uses used using with this that these those " +
    "from into onto than then when what which while where who why how its it's was were has have had " +
    "should must always never prefer avoid instead rather over please don't dont also just like make " +
    "sure here there them they their your we're let's lets via per each every more less some one").split(" "),
);

// ponytail: 4-char prefix is a crude stemmer (tests/testing, export/exports);
// non-space-separated scripts (CJK) tokenize as one long word. Swap in a real
// stemmer/segmenter if real mines show false flags.
function contentStems(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    out.add(word.slice(0, 4));
  }
  return out;
}

/** Share (0..1) of the statement's content words that also appear in the quote. */
export function lexicalOverlap(statement: string, quote: string): number {
  const stems = contentStems(statement);
  if (stems.size === 0) return 0;
  const quoteStems = contentStems(quote);
  let shared = 0;
  for (const s of stems) if (quoteStems.has(s)) shared++;
  return shared / stems.size;
}

// Low confidence = none of the verified quotes at the rule's top authority tier
// (the ones that set its score and can exempt it from the recurrence floor)
// lexically supports the statement. Checking only the top tier matters: an
// outsider's own matching quote must not vouch for a statement whose authority
// comes from an unrelated maintainer quote. Rules with no verified evidence are
// left alone; scoring already caps them below the include threshold.
export function isLowConfidence(statement: string, evidence: EvidenceRecord[]): boolean {
  const verified = evidence.filter((e) => e.verified);
  if (verified.length === 0) return false;
  const top = Math.max(...verified.map((e) => authorityRank(e.association)));
  return !verified.some(
    (e) => authorityRank(e.association) === top && lexicalOverlap(statement, e.quote) >= LOW_CONFIDENCE_OVERLAP,
  );
}

import { expect, test } from "vitest";
import type { NormalizedPr } from "../src/schemas/normalized-pr.js";
import type { CandidateLearning } from "../src/schemas/candidate-learning.js";
import { ProvenanceSchema, RuleRecordSchema } from "../src/schemas/provenance.js";
import { verifyEvidence } from "../src/reconciler/verify-evidence.js";

function pr(number: number, commentBody: string): NormalizedPr {
  return {
    number, title: "t", body: "the pr body text", author: "a", authorAssociation: "MEMBER",
    state: "MERGED", mergedAt: null, updatedAt: "2026-01-01T00:00:00Z", labels: [], files: [],
    threads: [{ path: null, line: null, resolved: true,
      comments: [{ author: "o", association: "OWNER", body: commentBody, createdAt: "2026-01-01T00:00:00Z" }] }],
    reviews: [], comments: [],
  };
}

function cand(prNum: number, quote: string): CandidateLearning {
  return {
    statement: "Use X", category: "style", scope: [], polarity: "prescriptive",
    evidence: [{ pr: prNum, author: "o", association: "OWNER", quote, createdAt: "2026-01-01T00:00:00Z" }],
  };
}

test("verifies a quote that appears in the referenced PR discussion (whitespace-normalized)", () => {
  const prs = [pr(1, "We always   use X for\nthis case.")];
  const out = verifyEvidence([cand(1, "We always use X for this case.")], prs);
  expect(out[0]!.evidence[0]!.verified).toBe(true);
});

test("marks unverified: quote not in the PR, wrong PR number, or unknown PR", () => {
  const prs = [pr(1, "unrelated discussion")];
  expect(verifyEvidence([cand(1, "We always use X")], prs)[0]!.evidence[0]!.verified).toBe(false);
  expect(verifyEvidence([cand(99, "unrelated discussion")], prs)[0]!.evidence[0]!.verified).toBe(false);
});

test("PR body text also counts as quotable surface", () => {
  const prs = [pr(1, "nothing here")];
  expect(verifyEvidence([cand(1, "the pr body text")], prs)[0]!.evidence[0]!.verified).toBe(true);
});

test("empty and whitespace-only quotes never verify", () => {
  const prs = [pr(1, "We always use X for this case.")];
  expect(verifyEvidence([cand(1, "")], prs)[0]!.evidence[0]!.verified).toBe(false);
  expect(verifyEvidence([cand(1, "   \n\t  ")], prs)[0]!.evidence[0]!.verified).toBe(false);
});

test("quotes below the minimum length floor never verify, even when present", () => {
  const prs = [pr(1, "shortquot appears in this discussion")];
  expect(verifyEvidence([cand(1, "shortquot")], prs)[0]!.evidence[0]!.verified).toBe(false);
});

test("a quote stitched across two separate parts does not verify", () => {
  const base = pr(1, "X consistently in this repo");
  const prs = [{ ...base, body: "we always use" }];
  expect(
    verifyEvidence([cand(1, "we always use X consistently")], prs)[0]!.evidence[0]!.verified,
  ).toBe(false);
});

// ---- Fix 2: verification overwrites author/association/createdAt from corpus truth ----

test("a spoofed OWNER claim is overwritten to the true NONE association of the matching comment (spoof closed)", () => {
  const prs: NormalizedPr[] = [{
    number: 1, title: "t", body: "unrelated body", author: "maintainer", authorAssociation: "OWNER",
    state: "MERGED", mergedAt: null, updatedAt: "2026-01-01T00:00:00Z", labels: [], files: [],
    threads: [{
      path: null, line: null, resolved: true,
      comments: [{ author: "randomdrifter", association: "NONE", body: "please always use X for every widget we ship", createdAt: "2025-03-01T00:00:00Z" }],
    }],
    reviews: [], comments: [],
  }];
  // Model claims this quote came from an OWNER named "maintainer" posted recently.
  const candidate: CandidateLearning = {
    statement: "Use X", category: "style", scope: [], polarity: "prescriptive",
    evidence: [{ pr: 1, author: "maintainer", association: "OWNER", quote: "please always use X for every widget we ship", createdAt: "2026-06-01T00:00:00Z" }],
  };

  const [out] = verifyEvidence([candidate], prs);
  const e = out!.evidence[0]!;

  expect(e.verified).toBe(true);
  expect(e.association).toBe("NONE"); // corpus truth, not the model's claimed OWNER
  expect(e.author).toBe("randomdrifter");
  expect(e.createdAt).toBe("2025-03-01T00:00:00Z");
});

test("a matching PR-body quote is overwritten from the PR's own author/association/mergedAt", () => {
  const prs: NormalizedPr[] = [{
    number: 1, title: "t", body: "the pr body text", author: "bodyauthor", authorAssociation: "MEMBER",
    state: "MERGED", mergedAt: "2026-02-15T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z", labels: [], files: [],
    threads: [], reviews: [], comments: [],
  }];
  const candidate: CandidateLearning = {
    statement: "Use X", category: "style", scope: [], polarity: "prescriptive",
    evidence: [{ pr: 1, author: "wrongclaim", association: "OWNER", quote: "the pr body text", createdAt: "2020-01-01T00:00:00Z" }],
  };

  const [out] = verifyEvidence([candidate], prs);
  const e = out!.evidence[0]!;

  expect(e.verified).toBe(true);
  expect(e.author).toBe("bodyauthor");
  expect(e.association).toBe("MEMBER");
  expect(e.createdAt).toBe("2026-02-15T00:00:00Z"); // mergedAt preferred over updatedAt
});

test("a matching PR-body quote falls back to updatedAt when mergedAt is null", () => {
  const prs: NormalizedPr[] = [{
    number: 1, title: "t", body: "the pr body text", author: "bodyauthor", authorAssociation: "MEMBER",
    state: "OPEN", mergedAt: null, updatedAt: "2026-03-01T00:00:00Z", labels: [], files: [],
    threads: [], reviews: [], comments: [],
  }];
  const candidate: CandidateLearning = {
    statement: "Use X", category: "style", scope: [], polarity: "prescriptive",
    evidence: [{ pr: 1, author: "wrongclaim", association: "OWNER", quote: "the pr body text", createdAt: "2020-01-01T00:00:00Z" }],
  };

  const [out] = verifyEvidence([candidate], prs);
  expect(out!.evidence[0]!.createdAt).toBe("2026-03-01T00:00:00Z");
});

test("a matching review quote uses the review's own author/association and the PR's updatedAt (reviews carry no createdAt)", () => {
  const prs: NormalizedPr[] = [{
    number: 1, title: "t", body: "unrelated", author: "a", authorAssociation: "MEMBER",
    state: "MERGED", mergedAt: null, updatedAt: "2026-04-01T00:00:00Z", labels: [], files: [],
    threads: [], comments: [],
    reviews: [{ author: "reviewer1", association: "COLLABORATOR", state: "APPROVED", body: "looks great, please always use Y for consistency" }],
  }];
  const candidate: CandidateLearning = {
    statement: "Use Y", category: "style", scope: [], polarity: "prescriptive",
    evidence: [{ pr: 1, author: "wrongclaim", association: "OWNER", quote: "please always use Y for consistency", createdAt: "2020-01-01T00:00:00Z" }],
  };

  const [out] = verifyEvidence([candidate], prs);
  const e = out!.evidence[0]!;
  expect(e.verified).toBe(true);
  expect(e.author).toBe("reviewer1");
  expect(e.association).toBe("COLLABORATOR");
  expect(e.createdAt).toBe("2026-04-01T00:00:00Z"); // review has no createdAt -> PR's updatedAt
});

test("an unverified (non-matching) quote keeps the model's untrusted claimed values as-is", () => {
  const prs: NormalizedPr[] = [pr(1, "totally unrelated content")];
  const candidate: CandidateLearning = {
    statement: "Use X", category: "style", scope: [], polarity: "prescriptive",
    evidence: [{ pr: 1, author: "claimedauthor", association: "OWNER", quote: "a quote that never appears anywhere in this pr", createdAt: "2020-01-01T00:00:00Z" }],
  };

  const [out] = verifyEvidence([candidate], prs);
  const e = out!.evidence[0]!;
  expect(e.verified).toBe(false);
  expect(e.author).toBe("claimedauthor"); // untouched: no ground truth to overwrite with
  expect(e.association).toBe("OWNER");
  expect(e.createdAt).toBe("2020-01-01T00:00:00Z");
});

// ---- Hardening: blockquote stripping + highest-authority attribution -----

test("a blockquoted echo of an OWNER statement by a NONE-association part does not attribute to the echoer; attributes to the OWNER's own part", () => {
  const ownerStatement = "please always use X for every widget we ship";
  const prs: NormalizedPr[] = [{
    number: 1, title: "t", body: "unrelated", author: "a", authorAssociation: "MEMBER",
    state: "MERGED", mergedAt: null, updatedAt: "2026-01-01T00:00:00Z", labels: [], files: [],
    threads: [{
      path: null, line: null, resolved: true,
      // This comment appears EARLIER in corpus iteration order than the owner's own
      // comment below, so a naive first-match would (wrongly) attribute to it.
      comments: [{ author: "echoer", association: "NONE", body: `> ${ownerStatement}\n\nagreed, +1`, createdAt: "2026-01-02T00:00:00Z" }],
    }],
    reviews: [],
    comments: [{ author: "owner1", association: "OWNER", body: ownerStatement, createdAt: "2026-01-01T12:00:00Z" }],
  }];
  const candidate: CandidateLearning = {
    statement: "Use X", category: "style", scope: [], polarity: "prescriptive",
    evidence: [{ pr: 1, author: "owner1", association: "OWNER", quote: ownerStatement, createdAt: "2026-01-01T12:00:00Z" }],
  };

  const [out] = verifyEvidence([candidate], prs);
  const e = out!.evidence[0]!;

  expect(e.verified).toBe(true);
  expect(e.association).toBe("OWNER");
  expect(e.author).toBe("owner1");
});

test("an OWNER blockquoting a drive-by's claim to disagree does not mint OWNER authority for it; attributes to the drive-by's own part", () => {
  const claim = "we should never use X, it always breaks everything";
  const prs: NormalizedPr[] = [{
    number: 1, title: "t", body: "unrelated", author: "a", authorAssociation: "MEMBER",
    state: "MERGED", mergedAt: null, updatedAt: "2026-01-01T00:00:00Z", labels: [], files: [],
    threads: [],
    reviews: [],
    // Owner's disagreement (which blockquotes the claim) appears FIRST in iteration
    // order, so a naive first-match (without stripping) would wrongly mint OWNER
    // authority for the drive-by's claim.
    comments: [
      { author: "owner1", association: "OWNER", body: `> ${claim}\n\nThat's not accurate, we've been using X safely for months.`, createdAt: "2026-01-02T00:00:00Z" },
      { author: "driveby", association: "NONE", body: claim, createdAt: "2026-01-01T00:00:00Z" },
    ],
  }];
  const candidate: CandidateLearning = {
    statement: "Avoid X", category: "style", scope: [], polarity: "proscriptive",
    evidence: [{ pr: 1, author: "driveby", association: "NONE", quote: claim, createdAt: "2026-01-01T00:00:00Z" }],
  };

  const [out] = verifyEvidence([candidate], prs);
  const e = out!.evidence[0]!;

  expect(e.verified).toBe(true);
  expect(e.association).toBe("NONE");
  expect(e.author).toBe("driveby");
});

test("when multiple parts genuinely contain the quote (no blockquotes involved), the highest-authority match wins regardless of order", () => {
  const quote = "we always run the full suite before merging";
  const prs: NormalizedPr[] = [{
    number: 1, title: "t", body: "unrelated", author: "a", authorAssociation: "MEMBER",
    state: "MERGED", mergedAt: null, updatedAt: "2026-01-01T00:00:00Z", labels: [], files: [],
    threads: [],
    reviews: [],
    comments: [
      { author: "contributor1", association: "CONTRIBUTOR", body: quote, createdAt: "2026-01-01T00:00:00Z" },
      { author: "owner1", association: "OWNER", body: quote, createdAt: "2026-01-02T00:00:00Z" },
    ],
  }];
  const candidate: CandidateLearning = {
    statement: "Run full suite", category: "testing", scope: [], polarity: "prescriptive",
    evidence: [{ pr: 1, author: "contributor1", association: "CONTRIBUTOR", quote, createdAt: "2026-01-01T00:00:00Z" }],
  };

  const [out] = verifyEvidence([candidate], prs);
  const e = out!.evidence[0]!;

  expect(e.verified).toBe(true);
  expect(e.association).toBe("OWNER");
  expect(e.author).toBe("owner1");
});

test("ties in authority resolve to the earliest matching part", () => {
  const quote = "we always squash commits before merge";
  const prs: NormalizedPr[] = [{
    number: 1, title: "t", body: "unrelated", author: "a", authorAssociation: "MEMBER",
    state: "MERGED", mergedAt: null, updatedAt: "2026-01-01T00:00:00Z", labels: [], files: [],
    threads: [],
    reviews: [],
    comments: [
      { author: "owner-early", association: "OWNER", body: quote, createdAt: "2026-01-01T00:00:00Z" },
      { author: "owner-late", association: "OWNER", body: quote, createdAt: "2026-01-05T00:00:00Z" },
    ],
  }];
  const candidate: CandidateLearning = {
    statement: "Squash commits", category: "process", scope: [], polarity: "prescriptive",
    evidence: [{ pr: 1, author: "owner-early", association: "OWNER", quote, createdAt: "2026-01-01T00:00:00Z" }],
  };

  const [out] = verifyEvidence([candidate], prs);
  const e = out!.evidence[0]!;

  expect(e.author).toBe("owner-early");
  expect(e.createdAt).toBe("2026-01-01T00:00:00Z");
});

test("provenance schemas round-trip and reject bad verdicts", () => {
  const rule = {
    id: "r1", statement: "Use X", category: "style", polarity: "prescriptive", scope: [],
    score: 0.42, verdict: "corroborated",
    evidence: [{ pr: 1, author: "o", association: "OWNER", quote: "q", createdAt: "2026-01-01T00:00:00Z", verified: true }],
    exemplars: ["src/a.ts"], lastCorroborated: "2026-07-01T00:00:00Z",
  };
  expect(RuleRecordSchema.parse(rule)).toEqual(rule);
  expect(() => RuleRecordSchema.parse({ ...rule, verdict: "vibes" })).toThrow();
  const prov = { generatedAt: "2026-07-02T00:00:00Z", intent: "onboarding", rules: [rule], dropped: [], contested: [] };
  expect(ProvenanceSchema.parse(prov)).toEqual(prov);
});

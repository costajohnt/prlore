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

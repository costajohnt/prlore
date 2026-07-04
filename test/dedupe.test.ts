import { expect, test } from "vitest";
import { BudgetExceededError, type CompleteOptions, type ModelProvider } from "../src/model/provider.js";
import { dedupeAcrossBuckets } from "../src/reconciler/dedupe.js";
import type { ReconciledRule } from "../src/reconciler/reconcile.js";
import type { EvidenceRecord, Verdict } from "../src/schemas/provenance.js";

function ev(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    pr: 1,
    author: "owner1",
    association: "OWNER",
    quote: "a sufficiently long quote for verification purposes",
    createdAt: "2026-06-15T00:00:00Z",
    verified: true,
    ...overrides,
  };
}

function rule(
  id: number | string,
  statement: string,
  opts: Partial<Omit<ReconciledRule, "id" | "statement">> = {},
): ReconciledRule {
  return {
    id,
    statement,
    category: "architecture",
    polarity: "prescriptive",
    scope: [],
    evidence: [],
    verdict: "corroborated",
    exemplars: [],
    ...opts,
  };
}

function fakeProvider(handler: (prompt: string) => unknown | "throw" | "budget") {
  const prompts: string[] = [];
  let calls = 0;
  const p: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      prompts.push(prompt);
      calls++;
      const result = handler(prompt);
      if (result === "throw") throw new Error("model unavailable");
      if (result === "budget") throw new BudgetExceededError(5, 5);
      return result as T;
    },
  };
  return { p, prompts, callCount: () => calls };
}

test("a valid proposed set merges: evidence unioned, absorbed id absent, mergedFrom recorded on the kept record", async () => {
  const a = rule(0, "Gate TTY output behind isatty", { evidence: [ev({ pr: 10, quote: "quote a" })] });
  const b = rule(1, "Don't print ANSI codes off-terminal", { evidence: [ev({ pr: 11, quote: "quote b" })] });
  const { p } = fakeProvider(() => ({ mergeSets: [{ ids: [0, 1] }] }));

  const { rules, merged } = await dedupeAcrossBuckets([a, b], p);

  expect(rules).toHaveLength(1);
  expect(merged).toEqual([{ keptId: 0, absorbedIds: [1] }]);
  const kept = rules[0]!;
  expect(kept.id).toBe(0); // tie-break: equal evidence count -> lowest id
  expect(kept.mergedFrom).toEqual([1]);
  expect(kept.evidence.map((e) => e.pr).sort()).toEqual([10, 11]);
  expect(rules.some((r) => r.id === 1)).toBe(false); // absorbed id gone entirely
});

test("evidence union dedupes by (pr, quote), matching cluster.ts's precedent", async () => {
  const sharedEvidence = ev({ pr: 5, quote: "shared quote text" });
  const a = rule(0, "Statement A", { evidence: [sharedEvidence, ev({ pr: 6, quote: "quote a2" })] });
  const b = rule(1, "Statement B", { evidence: [sharedEvidence, ev({ pr: 7, quote: "quote b2" })] });
  const { p } = fakeProvider(() => ({ mergeSets: [{ ids: [0, 1] }] }));

  const { rules } = await dedupeAcrossBuckets([a, b], p);

  expect(rules).toHaveLength(1);
  expect(rules[0]!.evidence).toHaveLength(3); // shared (pr,quote) counted once
});

test("a proposal naming a contested id is rejected wholesale: both members survive untouched", async () => {
  const contested = rule(0, "Contested statement", { verdict: "contested" as Verdict });
  const clean = rule(1, "Clean statement");
  const { p } = fakeProvider(() => ({ mergeSets: [{ ids: [0, 1] }] }));

  const { rules, merged } = await dedupeAcrossBuckets([contested, clean], p);

  expect(merged).toEqual([]);
  expect(rules).toHaveLength(2);
  expect(rules.find((r) => r.id === 0)!.verdict).toBe("contested");
  expect(rules.find((r) => r.id === 1)!.mergedFrom).toBeUndefined();
});

test("a cross-polarity proposal is rejected: prescriptive and proscriptive members never merge", async () => {
  const prescriptive = rule(0, "Always do X", { polarity: "prescriptive" });
  const proscriptive = rule(1, "Never do X", { polarity: "proscriptive" });
  const { p } = fakeProvider(() => ({ mergeSets: [{ ids: [0, 1] }] }));

  const { rules, merged } = await dedupeAcrossBuckets([prescriptive, proscriptive], p);

  expect(merged).toEqual([]);
  expect(rules).toHaveLength(2);
});

test("overlapping sets: the first accepted set wins, a later set sharing an id is dropped", async () => {
  const a = rule(0, "Statement A");
  const b = rule(1, "Statement B");
  const c = rule(2, "Statement C");
  // Set 2 overlaps set 1 on id 1 -> set 2 dropped in full (c never merges anywhere).
  const { p } = fakeProvider(() => ({
    mergeSets: [{ ids: [0, 1] }, { ids: [1, 2] }],
  }));

  const { rules, merged } = await dedupeAcrossBuckets([a, b, c], p);

  expect(merged).toEqual([{ keptId: 0, absorbedIds: [1] }]);
  expect(rules).toHaveLength(2); // {0 (merged with 1), 2 (untouched)}
  expect(rules.some((r) => r.id === 2)).toBe(true);
  expect(rules.find((r) => r.id === 2)!.mergedFrom).toBeUndefined();
});

test("an id referencing an unknown rule is rejected wholesale", async () => {
  const a = rule(0, "Statement A");
  const b = rule(1, "Statement B");
  const { p } = fakeProvider(() => ({ mergeSets: [{ ids: [0, 99] }] }));

  const { rules, merged } = await dedupeAcrossBuckets([a, b], p);

  expect(merged).toEqual([]);
  expect(rules).toHaveLength(2);
});

test("provider throw: rules pass through unchanged and a warning is returned", async () => {
  const a = rule(0, "Statement A");
  const b = rule(1, "Statement B");
  const { p } = fakeProvider(() => "throw");

  const { rules, merged, warning } = await dedupeAcrossBuckets([a, b], p);

  expect(rules).toEqual([a, b]);
  expect(merged).toEqual([]);
  expect(warning).toBeDefined();
});

test("BudgetExceededError propagates instead of degrading silently (parity with cluster/reconcile/select)", async () => {
  const a = rule(0, "Statement A");
  const b = rule(1, "Statement B");
  const { p } = fakeProvider(() => "budget");

  await expect(dedupeAcrossBuckets([a, b], p)).rejects.toBeInstanceOf(BudgetExceededError);
});

test("vacuous check: an empty mergeSets response is a legitimate no-op, not a failure", async () => {
  const a = rule(0, "Statement A");
  const b = rule(1, "Statement B");
  const { p } = fakeProvider(() => ({ mergeSets: [] }));

  const { rules, merged, warning } = await dedupeAcrossBuckets([a, b], p);

  expect(rules).toEqual([a, b]);
  expect(merged).toEqual([]);
  expect(warning).toBeUndefined();
});

test("a synthetic code-only rule (no PR evidence) is eligible to merge like any other non-contested rule", async () => {
  const synthetic = rule("code-0", "Prefer composition over inheritance", { syntheticScore: 0.5 });
  const prRule = rule(1, "Compose instead of inheriting");
  const { p } = fakeProvider(() => ({ mergeSets: [{ ids: ["code-0", 1] }] }));

  const { rules, merged } = await dedupeAcrossBuckets([synthetic, prRule], p);

  expect(merged).toHaveLength(1);
  expect(rules).toHaveLength(1);
});

test("a synthetic + PR-evidenced merge carries the synthetic's score forward onto the kept record, even though the PR side (more evidence) wins pickKeptMember", async () => {
  const synthetic = rule("code-0", "Prefer composition over inheritance", { syntheticScore: 0.5 });
  const prRule = rule(1, "Compose instead of inheriting", { evidence: [ev({ pr: 40, quote: "quote naming the pr side" })] });
  const { p } = fakeProvider(() => ({ mergeSets: [{ ids: ["code-0", 1] }] }));

  const { rules, merged } = await dedupeAcrossBuckets([synthetic, prRule], p);

  expect(merged).toEqual([{ keptId: 1, absorbedIds: ["code-0"] }]); // PR side (1 evidence) beats synthetic (0)
  const kept = rules.find((r) => r.id === 1)!;
  expect(kept.syntheticScore).toBe(0.5); // carried forward despite the ...kept spread being the PR rule
});

test("a synthetic + PR-evidenced merge takes the MAX syntheticScore across all merged members, regardless of which member is kept", async () => {
  // Force the synthetic side to win pickKeptMember (more evidence than the PR side)
  // so the max-across-members logic is exercised on the "kept is already synthetic,
  // but a HIGHER synthetic score sits on an absorbed member" branch too.
  const keptSynthetic = rule("code-0", "Prefer composition over inheritance", {
    syntheticScore: 0.4,
    evidence: [ev({ pr: 50 }), ev({ pr: 51, quote: "second quote for the kept side" })],
  });
  const absorbedSynthetic = rule("code-1", "Favor composing over inheriting", {
    syntheticScore: 0.6,
    evidence: [ev({ pr: 52, quote: "single quote for the absorbed side" })],
  });
  const { p } = fakeProvider(() => ({ mergeSets: [{ ids: ["code-0", "code-1"] }] }));

  const { rules, merged } = await dedupeAcrossBuckets([keptSynthetic, absorbedSynthetic], p);

  expect(merged).toEqual([{ keptId: "code-0", absorbedIds: ["code-1"] }]);
  const kept = rules.find((r) => r.id === "code-0")!;
  expect(kept.syntheticScore).toBe(0.6); // max(0.4, 0.6), not just the kept member's own 0.4
});

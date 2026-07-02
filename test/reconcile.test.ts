import { expect, test } from "vitest";
import { realGit } from "../src/analyzer/git.js";
import { trendFor } from "../src/analyzer/probes.js";
import type { CompleteOptions, ModelProvider } from "../src/model/provider.js";
import type { Cluster } from "../src/reconciler/cluster.js";
import {
  mergeCodeOnlyPatterns,
  reconcileClusters,
  type ReconciledRule,
} from "../src/reconciler/reconcile.js";
import type { EvidenceRecord } from "../src/schemas/provenance.js";
import type { PatternsModel } from "../src/schemas/patterns-model.js";
import { buildFixtureRepo } from "./helpers/fixture-repo.js";

const NOW = new Date("2026-07-01T00:00:00Z").getTime();
const now = () => NOW;

function mkCluster(
  id: number,
  statement: string,
  opts: Partial<Omit<Cluster, "id" | "statement">> = {},
): Cluster {
  return {
    id,
    statement,
    category: "architecture",
    polarity: "prescriptive",
    scope: [],
    evidence: [],
    ...opts,
  };
}

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

interface Proposal {
  clusterId: number;
  proposedVerdict: "corroborated" | "trending-toward" | "unobservable" | "trending-away" | "contradicted-stable";
  probeToken?: string;
  probeExpectation?: "presence-supports" | "presence-contradicts";
}
interface Draft {
  proposals: Proposal[];
}

function fakeProvider(draft: Draft) {
  const prompts: string[] = [];
  let calls = 0;
  const p: ModelProvider = {
    spentUsd: () => 0,
    async complete<T>({ prompt }: CompleteOptions<T>): Promise<T> {
      prompts.push(prompt);
      calls++;
      return draft as unknown as T;
    },
  };
  return { p, prompts, callCount: () => calls };
}

const emptyPatterns: PatternsModel = {
  areas: [],
  patterns: [],
  migrations: [],
  meta: { languages: [], frameworks: [], tooling: [] },
};

// ---- Behavior 1: MUST-PASS stale demotion (spec §11) --------------------

test("stale convention: probe decides trending-away over an old OWNER claim, no contested override", async () => {
  const repo = await buildFixtureRepo();
  const cluster = mkCluster(0, "use oldApi everywhere", {
    evidence: [ev({ createdAt: "2023-06-01T00:00:00Z" })],
  });
  // proposedVerdict deliberately differs from the probe outcome: a broken
  // implementation that trusts the model would report "corroborated" here.
  const draft: Draft = {
    proposals: [
      { clusterId: 0, proposedVerdict: "corroborated", probeToken: "oldApi", probeExpectation: "presence-supports" },
    ],
  };
  const { p } = fakeProvider(draft);

  const [rule] = await reconcileClusters([cluster], [], emptyPatterns, {
    provider: p,
    git: realGit,
    repoPath: repo,
    now,
  });

  expect(rule!.verdict).toBe("trending-away"); // probe decides, not the model
  expect(rule!.probeResult?.head).toBe(5);
  expect(rule!.contestedReason).toBeUndefined();
});

// ---- Behavior 2: MUST-PASS recent maintainer -> contested (spec §11) ----

test("recent OWNER guidance contradicting the code trend becomes contested, not silently trending-away", async () => {
  const repo = await buildFixtureRepo();
  const cluster = mkCluster(0, "use oldApi everywhere", {
    evidence: [ev({ createdAt: "2026-06-15T00:00:00Z" })], // ~2 weeks before NOW
  });
  const draft: Draft = {
    proposals: [
      { clusterId: 0, proposedVerdict: "corroborated", probeToken: "oldApi", probeExpectation: "presence-supports" },
    ],
  };
  const { p } = fakeProvider(draft);

  const [rule] = await reconcileClusters([cluster], [], emptyPatterns, {
    provider: p,
    git: realGit,
    repoPath: repo,
    now,
  });

  expect(rule!.verdict).toBe("contested");
  expect(rule!.contestedReason).toBeDefined();
  expect(rule!.contestedReason).toContain("maintainer");
  expect(rule!.probeResult?.head).toBe(5); // probe still ran and was recorded
});

// ---- Behavior 3: presence-contradicts ------------------------------------

test("presence-contradicts: proscriptive claim probed against a falling-but-present token yields trending-toward", async () => {
  const repo = await buildFixtureRepo();
  const cluster = mkCluster(0, "never use oldApi", { polarity: "proscriptive" });
  const draft: Draft = {
    proposals: [
      { clusterId: 0, proposedVerdict: "corroborated", probeToken: "oldApi", probeExpectation: "presence-contradicts" },
    ],
  };
  const { p } = fakeProvider(draft);

  const [rule] = await reconcileClusters([cluster], [], emptyPatterns, {
    provider: p,
    git: realGit,
    repoPath: repo,
    now,
  });

  expect(rule!.verdict).toBe("trending-toward"); // probe decides, not the model's "corroborated"
});

// ---- Behavior 4: no-probe demotion ---------------------------------------

test("no-probe proposal outside {corroborated, unobservable} demotes to unobservable; missing proposal defaults to unobservable", async () => {
  const c0 = mkCluster(0, "prefer composition");
  const c1 = mkCluster(1, "no proposal for this one");
  const draft: Draft = {
    proposals: [{ clusterId: 0, proposedVerdict: "contradicted-stable" }],
  };
  const { p } = fakeProvider(draft);

  const rules = await reconcileClusters([c0, c1], [], emptyPatterns, {
    provider: p,
    git: realGit,
    repoPath: await buildFixtureRepo(),
    now,
  });

  expect(rules.find((r) => r.id === 0)!.verdict).toBe("unobservable");
  expect(rules.find((r) => r.id === 1)!.verdict).toBe("unobservable");
});

// ---- Behavior 5: conflict pairs -------------------------------------------

test("conflict pair: both sides with strong recent OWNER evidence both become contested", async () => {
  const c0 = mkCluster(0, "use tabs", { evidence: [ev({ pr: 1 })] });
  const c1 = mkCluster(1, "use spaces", { evidence: [ev({ pr: 2 })] });
  const draft: Draft = {
    proposals: [
      { clusterId: 0, proposedVerdict: "corroborated" },
      { clusterId: 1, proposedVerdict: "corroborated" },
    ],
  };
  const { p } = fakeProvider(draft);

  const rules = await reconcileClusters([c0, c1], [[0, 1]], emptyPatterns, {
    provider: p,
    git: realGit,
    repoPath: await buildFixtureRepo(),
    now,
  });

  const a = rules.find((r) => r.id === 0)!;
  const b = rules.find((r) => r.id === 1)!;
  expect(a.verdict).toBe("contested");
  expect(b.verdict).toBe("contested");
  expect(a.contestedReason).toContain("conflicting");
  expect(b.contestedReason).toContain("conflicting");
});

test("conflict pair: the weakly-evidenced side is demoted to trending-away, the strong side keeps its verdict", async () => {
  const c0 = mkCluster(0, "use tabs", { evidence: [ev({ pr: 1 })] }); // strong: OWNER, verified
  const c1 = mkCluster(1, "use spaces", {
    evidence: [ev({ pr: 2, verified: false })], // weak: unverified -> drive-by authority
  });
  const draft: Draft = {
    proposals: [
      { clusterId: 0, proposedVerdict: "corroborated" },
      { clusterId: 1, proposedVerdict: "corroborated" },
    ],
  };
  const { p } = fakeProvider(draft);

  const rules = await reconcileClusters([c0, c1], [[0, 1]], emptyPatterns, {
    provider: p,
    git: realGit,
    repoPath: await buildFixtureRepo(),
    now,
  });

  const a = rules.find((r) => r.id === 0)!;
  const b = rules.find((r) => r.id === 1)!;
  expect(a.verdict).toBe("corroborated"); // strong side keeps its current verdict
  expect(b.verdict).toBe("trending-away"); // weak side demoted
  expect(a.contestedReason).toBeUndefined();
  expect(b.contestedReason).toBeUndefined();
});

// ---- Behavior 6: mergeCodeOnlyPatterns ------------------------------------

test("mergeCodeOnlyPatterns appends a synthetic rule only for patterns not covered by any cluster statement", () => {
  const rules: ReconciledRule[] = [
    {
      id: 0,
      statement: "Always use newApi across all new modules",
      category: "architecture",
      polarity: "prescriptive",
      scope: [],
      evidence: [],
      exemplars: [],
      verdict: "corroborated",
    },
  ];
  const patterns: PatternsModel = {
    areas: [],
    patterns: [
      { statement: "Use newApi for all new modules", scope: ["src"], exemplars: ["src/a.ts"], confidence: 0.9 },
      { statement: "Prefer composition over inheritance", scope: [], exemplars: ["src/b.ts"], confidence: 0.5 },
    ],
    migrations: [],
    meta: { languages: [], frameworks: [], tooling: [] },
  };

  const merged = mergeCodeOnlyPatterns(rules, patterns);

  expect(merged).toHaveLength(2); // exactly one synthetic rule appended
  const synthetic = merged.find((r) => r.id === "code-0")!;
  expect(synthetic).toBeDefined();
  expect(synthetic.statement).toBe("Prefer composition over inheritance");
  expect(synthetic.verdict).toBe("corroborated");
  expect(synthetic.evidence).toEqual([]);
  expect(synthetic.exemplars).toEqual(["src/b.ts"]);
  expect(synthetic.syntheticScore).toBeCloseTo(0.3 + 0.4 * 0.5, 5);
  expect(merged.some((r) => r.id === "code-1")).toBe(false); // "newApi" pattern was covered
});

// ---- Behavior 7: trendFor direct -------------------------------------------

test("trendFor computes head/recent/prior/trend directly from git (refactor target for verifyMigrations)", async () => {
  const repo = await buildFixtureRepo();
  const result = await trendFor(realGit, repo, "oldApi", now);
  expect(result.head).toBe(5);
  expect(result.trend).toBe("falling");
  expect(result.recent).toBe(1);
  expect(result.prior).toBe(2);
});

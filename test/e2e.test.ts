import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "vitest";
import { buildServer } from "../src/server.js";
import { JobManager } from "../src/jobs/manager.js";
import type { MineDepsFactory } from "../src/server-tools.js";
import type { GqlTransport } from "../src/github/client.js";
import type { RawActor, RawPrNode } from "../src/github/normalize.js";
import type { CompleteOptions, ModelProvider } from "../src/model/provider.js";
import { ProvenanceSchema } from "../src/schemas/provenance.js";
import { loadCheckpoint } from "../src/state/checkpoint.js";
import { buildFixtureRepo } from "./helpers/fixture-repo.js";

// ---------------------------------------------------------------------------
// ONE end-to-end test composing the real pipeline: real JobManager (analyze ->
// fetch+extract -> synthesize), real emitDraft managed-block write, real MCP
// tool surface (mine -> status -> preview -> write) over InMemoryTransport.
// Only network (GitHub GraphQL) and the LLM are faked, via the MineDepsFactory
// seam added to src/server-tools.ts/src/server.ts for this task (see the
// comment on MineDepsFactory there) -- everything downstream of those two
// edges is the genuine production code path.
//
// The fixture repo (test/helpers/fixture-repo.ts) is BOTH the fake "GitHub
// repo" this test's transport serves PR pages for AND the local checkout the
// pipeline mines against. It carries a real, script-built oldApi -> newApi
// migration (see its doc comment for the exact commit/date layout the probes
// below key off of). The 3 canned PR pages' review discussion deliberately
// echoes that migration so the reconciler's grep/pickaxe probes (real git
// commands against the fixture repo, not faked) corroborate what the scripted
// model proposes instead of contradicting it.
// ---------------------------------------------------------------------------

const BEGIN = "<!-- prlore:begin -->";
const END = "<!-- prlore:end -->";

// Matches the `now` synthesize.test.ts and the fixture repo's own doc comment
// assume ("prior bucket sees 2 oldApi commits vs 1 recent"): fixing `now` here
// keeps the reconciler's 12/36-month probe windows deterministic.
const NOW = new Date("2026-07-01T00:00:00Z").getTime();
const now = () => NOW;

function textOf(res: { content?: unknown }): string {
  const [first] = res.content as { type: string; text: string }[];
  return first!.text;
}

// ---- fake GitHub transport: 3 canned PR pages echoing the fixture repo's
// oldApi -> newApi migration --------------------------------------------------

const bob: RawActor = { login: "bob", __typename: "User" };
const carol: RawActor = { login: "carol", __typename: "User" };
const dave: RawActor = { login: "dave", __typename: "User" };
const page = (hasNextPage = false) => ({ hasNextPage });

interface PrFixture {
  number: number;
  title: string;
  author: RawActor;
  authorAssociation: RawPrNode["authorAssociation"];
  updatedAt: string;
  reviewAuthor: RawActor;
  reviewAssociation: RawPrNode["authorAssociation"];
  reviewBody: string;
}

function mkPr(f: PrFixture): RawPrNode {
  return {
    number: f.number,
    title: f.title,
    body: `See discussion on PR #${f.number}.`,
    updatedAt: f.updatedAt,
    mergedAt: f.updatedAt,
    state: "MERGED",
    author: f.author,
    authorAssociation: f.authorAssociation,
    labels: { nodes: [] },
    files: { nodes: [{ path: "src/app.ts" }], pageInfo: page() },
    reviews: {
      nodes: [{ author: f.reviewAuthor, authorAssociation: f.reviewAssociation, state: "APPROVED", body: f.reviewBody }],
      pageInfo: page(),
    },
    comments: { nodes: [], pageInfo: page() },
    reviewThreads: { nodes: [], pageInfo: page() },
  };
}

// PR #201: recent OWNER guidance corroborating newApi (real probe: newApi head 7,
// recent 2 > prior 1 -> "rising" -> presence-supports verdict "corroborated").
const NEWAPI_QUOTE = "We should always use newApi for all new modules going forward.";
const PR_NEWAPI = mkPr({
  number: 201,
  title: "Add button component on newApi",
  author: carol,
  authorAssociation: "CONTRIBUTOR",
  updatedAt: "2026-06-20T00:00:00Z",
  reviewAuthor: bob,
  reviewAssociation: "OWNER",
  reviewBody: NEWAPI_QUOTE,
});

// PR #202: recent OWNER guidance to keep migrating off oldApi (real probe: oldApi
// head 5, recent 1 < prior 2 -> "falling" -> presence-contradicts verdict
// "trending-toward", i.e. the "[migration in progress]" marker).
const MIGRATE_QUOTE = "Let's keep migrating away from oldApi toward newApi across the codebase.";
const PR_MIGRATE = mkPr({
  number: 202,
  title: "Continue the oldApi to newApi migration",
  author: carol,
  authorAssociation: "CONTRIBUTOR",
  updatedAt: "2026-06-25T00:00:00Z",
  reviewAuthor: bob,
  reviewAssociation: "OWNER",
  reviewBody: MIGRATE_QUOTE,
});

// PR #203: a stale (2023), non-owner claim asserting oldApi is still the way to go.
// Same real probe (oldApi falling) but presence-supports this time -> "trending-away",
// and its low authority x heavy recency decay drops it below INCLUDE_THRESHOLD ->
// provenance.dropped, not provenance.rules.
const STALE_QUOTE = "Always use oldApi for widgets in the legacy code.";
const PR_STALE = mkPr({
  number: 203,
  title: "Legacy widget note",
  author: dave,
  authorAssociation: "CONTRIBUTOR",
  updatedAt: "2023-06-01T00:00:00Z",
  reviewAuthor: dave,
  reviewAssociation: "CONTRIBUTOR",
  reviewBody: STALE_QUOTE,
});

function rateLimit() {
  return { cost: 1, remaining: 5000, resetAt: "2026-12-31T00:00:00Z" };
}

function fakeTransport(): GqlTransport {
  const pages = [
    { rateLimit: rateLimit(), repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: [PR_NEWAPI] } } },
    { rateLimit: rateLimit(), repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: "C2" }, nodes: [PR_MIGRATE] } } },
    { rateLimit: rateLimit(), repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: "C3" }, nodes: [PR_STALE] } } },
  ];
  let i = 0;
  return (async (query: string) => {
    if (query.includes("preflight")) {
      return { viewer: { login: "e2e-bot" }, repository: { nameWithOwner: "acme/fixture" } };
    }
    return pages[i++];
  }) as GqlTransport;
}

// ---- scripted provider: routes analyze / extract / cluster / reconcile /
// plan calls by their prompt prefix (same convention as test/job-manager.test.ts
// and test/synthesize.test.ts) -----------------------------------------------

function routeExtract(prompt: string): { learnings: unknown[] } {
  if (prompt.includes("## PR #201")) {
    return {
      learnings: [
        {
          statement: "Use newApi for all new modules",
          category: "architecture",
          polarity: "prescriptive",
          scope: [],
          quotes: [{ author: "bob", association: "OWNER", quote: NEWAPI_QUOTE, createdAt: "2026-06-20T00:00:00Z" }],
        },
      ],
    };
  }
  if (prompt.includes("## PR #202")) {
    return {
      learnings: [
        {
          statement: "Migrate away from oldApi toward newApi",
          category: "architecture",
          polarity: "proscriptive",
          scope: [],
          quotes: [{ author: "bob", association: "OWNER", quote: MIGRATE_QUOTE, createdAt: "2026-06-25T00:00:00Z" }],
        },
      ],
    };
  }
  if (prompt.includes("## PR #203")) {
    return {
      learnings: [
        {
          statement: "Always use oldApi for widgets",
          category: "style",
          polarity: "prescriptive",
          scope: [],
          quotes: [{ author: "dave", association: "CONTRIBUTOR", quote: STALE_QUOTE, createdAt: "2023-06-01T00:00:00Z" }],
        },
      ],
    };
  }
  return { learnings: [] };
}

// Parses reconcile.ts's own `[id] statement (polarity, category)` cluster lines out
// of the prompt (so this doesn't depend on guessing global cluster-id assignment
// order) and assigns each a probe by matching the STATEMENT TEXT this test's own
// extraction candidates produce -- keeping the corroboration decision keyed off
// content, not position.
function routeReconcile(prompt: string): { proposals: unknown[] } {
  const proposals: { clusterId: number; proposedVerdict: string; probeToken?: string; probeExpectation?: string }[] = [];
  const re = /^\[(\d+)] (.+) \((prescriptive|proscriptive), \w+\)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    const clusterId = Number(m[1]);
    const statement = m[2]!;
    if (statement === "Use newApi for all new modules") {
      proposals.push({ clusterId, proposedVerdict: "corroborated", probeToken: "newApi", probeExpectation: "presence-supports" });
    } else if (statement === "Migrate away from oldApi toward newApi") {
      proposals.push({ clusterId, proposedVerdict: "corroborated", probeToken: "oldApi", probeExpectation: "presence-contradicts" });
    } else if (statement === "Always use oldApi for widgets") {
      proposals.push({ clusterId, proposedVerdict: "corroborated", probeToken: "oldApi", probeExpectation: "presence-supports" });
    } else {
      proposals.push({ clusterId, proposedVerdict: "unobservable" });
    }
  }
  return { proposals };
}

// Parses select.ts's own `rules:` block out of the prompt and puts every surviving
// (non-dropped, non-contested) rule id into one section, in the score-desc order
// synthesize.ts already sorted them into -- so the draft's bullet order tracks
// whatever the reconciler actually decided, not a hardcoded guess.
function routePlan(prompt: string): unknown {
  const lines = prompt.split("\n");
  const startIdx = lines.indexOf("rules:");
  const ids: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = /^\[(\S+)]/.exec(lines[i] ?? "");
    if (m) ids.push(m[1]!);
  }
  return {
    title: "Fixture Repo Conventions",
    overview: "Conventions mined from the fixture repo's PR history for the prlore e2e golden test.",
    perArea: false,
    sections: [{ heading: "Conventions", ruleIds: ids }],
  };
}

function scriptedProvider(): ModelProvider {
  return {
    spentUsd: () => 0,
    async complete<T>({ prompt, schema }: CompleteOptions<T>): Promise<T> {
      if (prompt.startsWith("## User intent")) {
        return schema.parse({ areaDescriptions: [], patterns: [], migrationCandidates: [] });
      }
      if (prompt.startsWith("## PR #")) {
        return schema.parse(routeExtract(prompt));
      }
      if (prompt.startsWith("meta:")) {
        return schema.parse(routeReconcile(prompt));
      }
      if (prompt.startsWith("intent:")) {
        return schema.parse(routePlan(prompt));
      }
      // cluster call: one singleton group per "[i] statement (polarity)" candidate
      // line -- same convention test/synthesize.test.ts's scriptedProvider uses.
      const lines = prompt.split("\n").filter((l) => /^\[\d+]/.test(l));
      const groups = lines.map((line, i) => ({
        memberIndexes: [i],
        canonicalStatement: line.replace(/^\[\d+]\s*/, "").replace(/ \((?:prescriptive|proscriptive)\)$/, ""),
      }));
      return schema.parse({ groups });
    },
  };
}

// ---- pre-existing human-authored AGENTS.md ----------------------------------

const HUMAN_PROSE_BEFORE = `# Team AGENTS.md

This document is hand-maintained above the managed block. prlore must never
touch this paragraph.

`;
const HUMAN_PROSE_AFTER = `

## Footer

Hand-written closing notes that must survive every prlore write, byte for byte.
`;

function existingAgentsMd(): string {
  return `${HUMAN_PROSE_BEFORE}${BEGIN}\nplaceholder content from a prior run\n${END}${HUMAN_PROSE_AFTER}`;
}

function extractManagedRegion(content: string): string {
  const beginIdx = content.indexOf(BEGIN);
  const endIdx = content.indexOf(END);
  return content.slice(beginIdx, endIdx + END.length);
}

async function readGolden(name: string): Promise<string> {
  const path = fileURLToPath(new URL(`./helpers/golden/${name}`, import.meta.url));
  return readFile(path, "utf8");
}

function normalizeProvenance(p: Record<string, unknown>): Record<string, unknown> {
  return { ...p, generatedAt: "<normalized>" };
}

// ---- the test -----------------------------------------------------------------

test("end-to-end: mine -> preview -> write produces a byte-identical managed-block write, a schema-valid provenance sidecar with the stale rule retained in dropped, and an unchanged checkpoint -- matching the committed golden", async () => {
  const repoPath = await buildFixtureRepo();
  const stateDir = join(repoPath, ".prlore");
  const agentsPath = join(repoPath, "AGENTS.md");
  const original = existingAgentsMd();
  await writeFile(agentsPath, original, "utf8");

  const manager = new JobManager();
  const depsFactory: MineDepsFactory = (_config, ctx) => ({
    transport: fakeTransport(),
    provider: scriptedProvider(),
    stateDir: ctx.stateDir,
    repoPath: ctx.repoPath,
    now,
  });
  const server = buildServer(manager, depsFactory);
  const client = new Client({ name: "e2e-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const mineRes = await client.callTool({
    name: "mine",
    arguments: {
      repo: "acme/fixture",
      intent: "help a new contributor learn our conventions",
      repoPath,
      stateDir,
    },
  });
  expect(mineRes.isError).toBeFalsy();
  const { jobId, resumed } = JSON.parse(textOf(mineRes));
  expect(resumed).toBe(false);

  // Deterministic wait for the detached pipeline (start() returns synchronously by
  // contract). `manager` is the real JobManager instance backing the MCP tools
  // above, and settled() is its documented test-only hook -- not a second code path.
  await manager.settled();

  const statusRes = await client.callTool({ name: "status", arguments: { jobId } });
  const status = JSON.parse(textOf(statusRes));
  expect(status.state).toBe("ready-for-preview");
  expect(status.warnings).toEqual([]);

  // Checkpoint at ready-for-preview BEFORE write.
  const checkpointBefore = await loadCheckpoint(stateDir);
  expect(checkpointBefore?.stage).toBe("ready-for-preview");

  const previewRes = await client.callTool({ name: "preview", arguments: { jobId } });
  expect(previewRes.isError).toBeFalsy();
  const preview = JSON.parse(textOf(previewRes));
  expect(preview.contested).toEqual([]);
  expect(preview.targetExists).toBe(true);
  expect(preview.wouldRefuse).toBe(false);

  const writeRes = await client.callTool({ name: "write", arguments: { confirmToken: preview.confirmToken } });
  expect(writeRes.isError).toBeFalsy();
  const writeOut = JSON.parse(textOf(writeRes));
  expect(writeOut.pathsWritten).toEqual(
    expect.arrayContaining([agentsPath, join(repoPath, ".prlore", "provenance.json")]),
  );

  // ---- Assertion 1: human prose outside the managed block is byte-identical ----
  const written = await readFile(agentsPath, "utf8");
  const beginIdx = written.indexOf(BEGIN);
  const endIdx = written.indexOf(END);
  expect(beginIdx).toBeGreaterThanOrEqual(0);
  expect(endIdx).toBeGreaterThan(beginIdx);
  expect(written.slice(0, beginIdx)).toBe(HUMAN_PROSE_BEFORE);
  expect(written.slice(endIdx + END.length)).toBe(HUMAN_PROSE_AFTER);

  // ---- Assertion 2: managed region carries the corroborated rule and the
  // migration-in-progress marker; the stale rule is gone from the managed block ----
  const managedRegion = extractManagedRegion(written);
  expect(managedRegion).toContain("**Use newApi for all new modules**");
  expect(managedRegion).toContain("**[migration in progress]** Migrate away from oldApi toward newApi");
  expect(managedRegion).not.toContain("Always use oldApi for widgets");

  // ---- Assertion 3: provenance sidecar is schema-valid, with the dropped stale
  // rule retained in provenance.dropped ----
  const provenanceRaw = JSON.parse(await readFile(join(repoPath, ".prlore", "provenance.json"), "utf8"));
  const provenance = ProvenanceSchema.parse(provenanceRaw);
  expect(provenance).toEqual(provenanceRaw);
  const droppedStale = provenance.dropped.find((r) => r.statement === "Always use oldApi for widgets");
  expect(droppedStale).toBeDefined();
  expect(droppedStale!.verdict).toBe("trending-away");
  expect(droppedStale!.score).toBeLessThan(0.15); // INCLUDE_THRESHOLD (score.ts)
  expect(provenance.contested).toEqual([]);
  expect(provenance.rules.map((r) => r.statement).sort()).toEqual(
    ["Migrate away from oldApi toward newApi", "Use newApi for all new modules"].sort(),
  );

  // ---- Assertion 4: write never touches job stages -- checkpoint unchanged ----
  const checkpointAfter = await loadCheckpoint(stateDir);
  expect(checkpointAfter).toEqual(checkpointBefore);

  // ---- Assertion 5: golden comparison ----
  // Managed region: byte-exact against the committed golden (no timestamps live
  // inside the rendered markdown -- render.ts never interpolates generatedAt).
  const goldenRegion = await readGolden("agents-managed-region.md");
  expect(managedRegion).toBe(goldenRegion);

  // Provenance: byte-exact against the committed golden EXCEPT generatedAt, which
  // is normalized on both sides before comparing (it IS deterministic here because
  // `now` is fixed above, but the plan calls for normalizing it explicitly rather
  // than relying on that).
  const goldenProvenance = JSON.parse(await readGolden("provenance.json"));
  expect(normalizeProvenance(provenance)).toEqual(normalizeProvenance(goldenProvenance));
});

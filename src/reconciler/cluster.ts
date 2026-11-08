import { z } from "zod";
import { BudgetExceededError, OutputTruncatedError, type ModelProvider } from "../model/provider.js";
import { inBatches } from "./batch.js";
import { GeneralitySchema, type EvidenceRecord, type Generality } from "../schemas/provenance.js";
import type { VerifiedCandidate } from "./verify-evidence.js";
import { UNTRUSTED_DATA_RULE, untrustedFence } from "../util/untrusted.js";

export interface Cluster {
  id: number;
  statement: string;
  category: "style" | "architecture" | "testing" | "process" | "tooling" | "domain";
  polarity: "prescriptive" | "proscriptive";
  scope: string[];
  evidence: EvidenceRecord[];
  rationale?: string;
  // v0.3 Task 2: how broadly this rule applies (see schemas/provenance.ts). Optional
  // at this type level even though the draft schema below requires it from the
  // model — a cluster can still end up without one via the deterministic fallback
  // path assigning it explicitly (see fallbackDraft) or an orphaned singleton with
  // no draft group to source a tag from (see the "never lose a candidate" loop).
  // score.ts treats an absent tag as "repo-wide" (no penalty).
  generality?: Generality;
}

const ClusterDraftSchema = z.object({
  groups: z.array(
    z.object({
      memberIndexes: z.array(z.number().int().min(0)),
      canonicalStatement: z.string().min(1),
      conflictsWithGroup: z.number().int().min(0).optional(),
      // Required: schema-hint renders shapes into prompts, so the model always
      // sees this field is expected. A real provider's schema.parse() throws if
      // the model omits it, which clusterCandidates' existing catch already
      // handles the same way as any other draft failure — falling back to
      // fallbackDraft (which assigns "repo-wide" itself; see below).
      generality: GeneralitySchema,
    }),
  ),
});
type ClusterDraft = z.infer<typeof ClusterDraftSchema>;

const SYSTEM = `You group candidate engineering conventions that assert the SAME underlying norm.
Two candidates belong in the same group only if they state the same rule about the same topic,
even if phrased differently. If two groups give OPPOSITE guidance about the same topic (e.g.
"always do X" vs "never do X"), keep them as separate groups and link them by setting
conflictsWithGroup on one group to the other group's index in the groups array. Also tag each
group's generality: "site-specific" if the rule only matters when touching one particular
function/file/internal (e.g. it names a specific helper), "area" if it applies to one subsystem,
or "repo-wide" if any contributor would hit it. Respond with ONLY JSON matching the schema.

${UNTRUSTED_DATA_RULE}`;

// Fixed enumeration order: buckets are processed in this order regardless of input order,
// so global cluster ids are deterministic across runs for the same candidate set.
const CATEGORIES = ["style", "architecture", "testing", "process", "tooling", "domain"] as const;

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

function mergeEvidence(members: VerifiedCandidate[]): EvidenceRecord[] {
  const seen = new Set<string>();
  const out: EvidenceRecord[] = [];
  for (const m of members) {
    for (const e of m.evidence) {
      const key = JSON.stringify([e.pr, e.quote]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

function mergeScope(members: VerifiedCandidate[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of members) {
    for (const s of m.scope) {
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// NOTE for consumers (Tasks 4-6): "member order" in these merge helpers (first non-empty
// rationale, polarity tie-break to first member) is the draft's memberIndexes listing order —
// after validity + first-claim-wins filtering — NOT the original bucket/input order.
function firstRationale(members: VerifiedCandidate[]): string | undefined {
  for (const m of members) {
    if (m.rationale && m.rationale.length > 0) return m.rationale;
  }
  return undefined;
}

function majorityPolarity(members: { polarity: Cluster["polarity"] }[]): Cluster["polarity"] {
  let prescriptive = 0;
  let proscriptive = 0;
  for (const m of members) {
    if (m.polarity === "prescriptive") prescriptive++;
    else proscriptive++;
  }
  if (prescriptive === proscriptive) return members[0]!.polarity;
  return prescriptive > proscriptive ? "prescriptive" : "proscriptive";
}

// Dedup + range-filter memberIndexes while preserving the LLM's original ordering
// (used for "first member" tie-breaks: rationale, polarity tie). First-claim-wins across
// groups: indexes already claimed by an earlier group in this bucket (`alreadyAssigned`)
// are skipped, so clusters stay a disjoint partition of the bucket's candidates.
function validMemberIndexes(
  indexes: number[],
  bucketSize: number,
  alreadyAssigned: Set<number>,
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const i of indexes) {
    if (i < 0 || i >= bucketSize) continue;
    if (alreadyAssigned.has(i)) continue;
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(i);
  }
  return out;
}

function buildCluster(
  id: number,
  statement: string,
  category: Cluster["category"],
  members: VerifiedCandidate[],
  generality?: Generality,
): Cluster {
  const rationale = firstRationale(members);
  return {
    id,
    statement,
    category,
    polarity: majorityPolarity(members),
    scope: mergeScope(members),
    evidence: mergeEvidence(members),
    ...(rationale ? { rationale } : {}),
    ...(generality ? { generality } : {}),
  };
}

// Deterministic fallback: identical (whitespace/case normalized) statements merge into
// one group; canonical statement is the first member's own statement. No conflict pairs.
// generality is explicitly "repo-wide" for every group here: this path carries no model
// signal at all (the provider call itself failed), and back-compat default treats a
// missing tag as no-penalty anyway — setting it explicitly just documents that these
// groups were never model-tagged rather than leaving it ambiguous with a real tag.
function fallbackDraft(units: Unit[]): Draft {
  const groups: Group[] = [];
  const indexByKey = new Map<string, number>();
  units.forEach((c, i) => {
    const key = normalize(c.statement);
    const gi = indexByKey.get(key);
    if (gi === undefined) {
      indexByKey.set(key, groups.length);
      groups.push({ memberIndexes: [i], canonicalStatement: c.statement, generality: "repo-wide" });
    } else {
      groups[gi]!.memberIndexes.push(i);
    }
  });
  return { groups, conflicts: [] };
}

// Audit 2026-11-07 deep H2: one cluster call per bucket overflowed the 4096-token output
// cap at roughly 100 groups. Buckets are now clustered in batches of CLUSTER_BATCH, then
// the batch groups' canonical statements are clustered again (see draftLevels) so the
// same norm split across batches still merges.
export const CLUSTER_BATCH = 60;

// What one cluster call sees: a statement and its polarity.
interface Unit {
  statement: string;
  polarity: Cluster["polarity"];
}
// A group indexes into the units of the call that made it; conflicts are pairs of group
// indexes. Unlike ClusterDraft, generality is optional (singletons carry none).
interface Group {
  memberIndexes: number[];
  canonicalStatement: string;
  generality?: Generality;
}
interface Draft {
  groups: Group[];
  conflicts: [number, number][];
}

// One model draft, with indexes checked against this call's own units and shifted by
// `offset` so drafts from consecutive batches can be concatenated.
function toDraft(model: ClusterDraft, size: number, offset: number): Draft {
  const groups = model.groups.map(({ memberIndexes, canonicalStatement, generality }) => ({
    memberIndexes: memberIndexes.filter((i) => i < size).map((i) => i + offset),
    canonicalStatement,
    generality,
  }));
  const conflicts: [number, number][] = [];
  model.groups.forEach((g, gi) => {
    const other = g.conflictsWithGroup;
    if (other !== undefined && other !== gi && other < model.groups.length) conflicts.push([gi, other]);
  });
  return { groups, conflicts };
}

function concatDrafts(drafts: Draft[]): Draft {
  const out: Draft = { groups: [], conflicts: [] };
  for (const d of drafts) {
    const base = out.groups.length;
    out.groups.push(...d.groups);
    out.conflicts.push(...d.conflicts.map(([a, b]): [number, number] => [a + base, b + base]));
  }
  return out;
}

async function draftUnits(
  units: Unit[],
  provider: ModelProvider,
  batchSize: number,
  onFallback: () => void,
): Promise<{ draft: Draft; calls: number }> {
  const drafts = await inBatches(units, batchSize, async (batch, offset) => {
    try {
      const prompt = untrustedFence()(batch.map((c, i) => `[${i}] ${c.statement} (${c.polarity})`).join("\n"));
      const model = await provider.complete({ system: SYSTEM, prompt, schema: ClusterDraftSchema, maxTokens: 4096 });
      return [toDraft(model, batch.length, offset)];
    } catch (err) {
      // Budget exhaustion means every remaining call fails the same way, and a truncated
      // reply is split and retried by inBatches; neither may be masked by a fallback.
      if (err instanceof BudgetExceededError || err instanceof OutputTruncatedError) throw err;
      onFallback();
      const fb = fallbackDraft(batch);
      return [{ ...fb, groups: fb.groups.map((g) => ({ ...g, memberIndexes: g.memberIndexes.map((i) => i + offset) })) }];
    }
  });
  return { draft: concatDrafts(drafts), calls: drafts.length };
}

// Turns a draft over `size` units into a disjoint partition (first claim wins, empty
// groups dropped, every unclaimed unit its own singleton), remapping its conflicts.
function partition(draft: Draft, size: number, units: Unit[]): Draft {
  const assigned = new Set<number>();
  const groups: Group[] = [];
  const remap: (number | undefined)[] = draft.groups.map((g) => {
    const memberIndexes = validMemberIndexes(g.memberIndexes, size, assigned);
    if (memberIndexes.length === 0) return undefined;
    for (const i of memberIndexes) assigned.add(i);
    groups.push({ ...g, memberIndexes });
    return groups.length - 1;
  });
  for (let i = 0; i < size; i++) {
    if (!assigned.has(i)) groups.push({ memberIndexes: [i], canonicalStatement: units[i]!.statement });
  }
  const conflicts = draft.conflicts
    .map(([a, b]) => [remap[a], remap[b]])
    .filter((p): p is [number, number] => p[0] !== undefined && p[1] !== undefined);
  return { groups, conflicts };
}

// Clusters `units`; when that took more than one call (batches, or halves of a batch
// split after a truncated reply), units in different calls never met, so the resulting
// groups' canonical statements are clustered again, recursively, and the members of
// groups that merge are unioned. Each level has fewer units than the one below it.
async function draftLevels(
  units: Unit[],
  provider: ModelProvider,
  batchSize: number,
  onFallback: () => void,
): Promise<Draft> {
  const { draft, calls } = await draftUnits(units, provider, batchSize, onFallback);
  if (calls <= 1) return draft;
  const lower = partition(draft, units.length, units);
  // ponytail: if no call merged anything, another level would see the same batches, so
  // stop; duplicates split across those batches stay separate (dedupe may still catch them).
  if (lower.groups.length >= units.length) return lower;

  const reps = lower.groups.map((g) => ({
    statement: g.canonicalStatement,
    polarity: majorityPolarity(g.memberIndexes.map((i) => units[i]!)),
  }));
  const upper = partition(await draftLevels(reps, provider, batchSize, onFallback), reps.length, reps);

  const repToGroup: number[] = [];
  const groups: Group[] = upper.groups.map((g, gi) => {
    for (const r of g.memberIndexes) repToGroup[r] = gi;
    // An upper singleton keeps its lower statement and tag (made with the members in view).
    const only = g.memberIndexes.length === 1 ? lower.groups[g.memberIndexes[0]!]! : undefined;
    return {
      memberIndexes: g.memberIndexes.flatMap((r) => lower.groups[r]!.memberIndexes),
      canonicalStatement: only?.canonicalStatement ?? g.canonicalStatement,
      generality: only ? only.generality : g.generality,
    };
  });
  const conflicts: [number, number][] = [
    ...upper.conflicts,
    ...lower.conflicts.map(([a, b]): [number, number] => [repToGroup[a]!, repToGroup[b]!]),
  ];
  return { groups, conflicts };
}

export async function clusterCandidates(
  candidates: VerifiedCandidate[],
  provider: ModelProvider,
  opts?: { counters?: { clusterFallbacks: number }; batchSize?: number },
): Promise<{ clusters: Cluster[]; conflictPairs: [number, number][] }> {
  const buckets = new Map<Cluster["category"], VerifiedCandidate[]>();
  for (const c of candidates) {
    const arr = buckets.get(c.category);
    if (arr) arr.push(c);
    else buckets.set(c.category, [c]);
  }

  const clusters: Cluster[] = [];
  const conflictPairs: [number, number][] = [];
  const seenPairKeys = new Set<string>();
  let nextId = 0;

  for (const category of CATEGORIES) {
    const bucket = buckets.get(category);
    if (!bucket || bucket.length === 0) continue;

    let fellBack = false;
    const units = bucket.map((c) => ({ statement: c.statement, polarity: c.polarity }));
    const draft = await draftLevels(units, provider, opts?.batchSize ?? CLUSTER_BATCH, () => {
      fellBack = true;
    });
    if (fellBack && opts?.counters) opts.counters.clusterFallbacks++;

    const assigned = new Set<number>();
    // undefined = this draft group produced no cluster (all its indexes were invalid).
    const groupGlobalIds: (number | undefined)[] = [];

    for (const group of draft.groups) {
      const memberIndexes = validMemberIndexes(group.memberIndexes, bucket.length, assigned);
      if (memberIndexes.length === 0) {
        // All indexes invalid or already claimed by an earlier group: no cluster.
        groupGlobalIds.push(undefined);
        continue;
      }
      for (const i of memberIndexes) assigned.add(i);
      const members = memberIndexes.map((i) => bucket[i]!);
      const id = nextId++;
      groupGlobalIds.push(id);
      clusters.push(buildCluster(id, group.canonicalStatement, category, members, group.generality));
    }

    // Never lose a candidate: anything not assigned to a surviving group becomes its own
    // singleton with no generality tag — there's no draft group to source one from.
    // score.ts treats the absence as "repo-wide" (no penalty).
    for (let i = 0; i < bucket.length; i++) {
      if (assigned.has(i)) continue;
      const c = bucket[i]!;
      const id = nextId++;
      clusters.push(buildCluster(id, c.statement, category, [c]));
    }

    for (const [gi, otherGi] of draft.conflicts) {
      const idA = groupGlobalIds[gi];
      const idB = groupGlobalIds[otherGi];
      if (idA === undefined || idB === undefined || idA === idB) continue; // no surviving cluster, or merged into one
      const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
      if (seenPairKeys.has(key)) continue;
      seenPairKeys.add(key);
      conflictPairs.push([idA, idB]);
    }
  }

  return { clusters, conflictPairs };
}

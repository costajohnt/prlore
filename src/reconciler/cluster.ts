import { z } from "zod";
import type { ModelProvider } from "../model/provider.js";
import type { EvidenceRecord } from "../schemas/provenance.js";
import type { VerifiedCandidate } from "./verify-evidence.js";

export interface Cluster {
  id: number;
  statement: string;
  category: "style" | "architecture" | "testing" | "process" | "tooling" | "domain";
  polarity: "prescriptive" | "proscriptive";
  scope: string[];
  evidence: EvidenceRecord[];
  rationale?: string;
}

const ClusterDraftSchema = z.object({
  groups: z.array(
    z.object({
      memberIndexes: z.array(z.number().int().min(0)),
      canonicalStatement: z.string().min(1),
      conflictsWithGroup: z.number().int().min(0).optional(),
    }),
  ),
});
type ClusterDraft = z.infer<typeof ClusterDraftSchema>;
type DraftGroup = ClusterDraft["groups"][number];

const SYSTEM = `You group candidate engineering conventions that assert the SAME underlying norm.
Two candidates belong in the same group only if they state the same rule about the same topic,
even if phrased differently. If two groups give OPPOSITE guidance about the same topic (e.g.
"always do X" vs "never do X"), keep them as separate groups and link them by setting
conflictsWithGroup on one group to the other group's index in the groups array. Respond with
ONLY JSON matching the schema.`;

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

function firstRationale(members: VerifiedCandidate[]): string | undefined {
  for (const m of members) {
    if (m.rationale && m.rationale.length > 0) return m.rationale;
  }
  return undefined;
}

function majorityPolarity(members: VerifiedCandidate[]): "prescriptive" | "proscriptive" {
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
// (used for "first member" tie-breaks: rationale, polarity tie).
function validMemberIndexes(indexes: number[], bucketSize: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const i of indexes) {
    if (i < 0 || i >= bucketSize) continue;
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
  };
}

// Deterministic fallback: identical (whitespace/case normalized) statements merge into
// one group; canonical statement is the first member's own statement. No conflict pairs.
function fallbackDraft(bucket: VerifiedCandidate[]): ClusterDraft {
  const groups: DraftGroup[] = [];
  const indexByKey = new Map<string, number>();
  bucket.forEach((c, i) => {
    const key = normalize(c.statement);
    const gi = indexByKey.get(key);
    if (gi === undefined) {
      indexByKey.set(key, groups.length);
      groups.push({ memberIndexes: [i], canonicalStatement: c.statement });
    } else {
      groups[gi]!.memberIndexes.push(i);
    }
  });
  return { groups };
}

export async function clusterCandidates(
  candidates: VerifiedCandidate[],
  provider: ModelProvider,
  opts?: { counters?: { clusterFallbacks: number } },
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

    let draft: ClusterDraft;
    let usedFallback = false;
    try {
      const prompt = bucket.map((c, i) => `[${i}] ${c.statement} (${c.polarity})`).join("\n");
      draft = await provider.complete({
        system: SYSTEM,
        prompt,
        schema: ClusterDraftSchema,
        maxTokens: 4096,
      });
    } catch {
      usedFallback = true;
      draft = fallbackDraft(bucket);
      if (opts?.counters) opts.counters.clusterFallbacks++;
    }

    const assigned = new Set<number>();
    // undefined = this draft group produced no cluster (all its indexes were invalid).
    const groupGlobalIds: (number | undefined)[] = [];

    for (const group of draft.groups) {
      const memberIndexes = validMemberIndexes(group.memberIndexes, bucket.length);
      if (memberIndexes.length === 0) {
        groupGlobalIds.push(undefined);
        continue;
      }
      for (const i of memberIndexes) assigned.add(i);
      const members = memberIndexes.map((i) => bucket[i]!);
      const id = nextId++;
      groupGlobalIds.push(id);
      clusters.push(buildCluster(id, group.canonicalStatement, category, members));
    }

    // Never lose a candidate: anything not assigned to a surviving group becomes its own singleton.
    for (let i = 0; i < bucket.length; i++) {
      if (assigned.has(i)) continue;
      const c = bucket[i]!;
      const id = nextId++;
      clusters.push(buildCluster(id, c.statement, category, [c]));
    }

    if (!usedFallback) {
      draft.groups.forEach((group, gi) => {
        if (group.conflictsWithGroup === undefined) return;
        const otherGi = group.conflictsWithGroup;
        if (otherGi === gi) return; // self-pair
        if (otherGi < 0 || otherGi >= draft.groups.length) return; // out-of-range group
        const idA = groupGlobalIds[gi];
        const idB = groupGlobalIds[otherGi];
        if (idA === undefined || idB === undefined) return; // references a group with no surviving cluster
        const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
        if (seenPairKeys.has(key)) return;
        seenPairKeys.add(key);
        conflictPairs.push([idA, idB]);
      });
    }
  }

  return { clusters, conflictPairs };
}

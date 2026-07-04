import { z } from "zod";
import { AssociationSchema } from "./normalized-pr.js";

export const VerdictSchema = z.enum([
  "corroborated", "trending-toward", "unobservable",
  "trending-away", "contradicted-stable", "contested",
]);
export type Verdict = z.infer<typeof VerdictSchema>;

// v0.3 Task 2: how broadly a rule's guidance applies. "site-specific" rules name a
// particular function/file/internal (e.g. "always suffix cursor tokens the way
// buildCursorSuffix does") and only matter to someone touching that one thing;
// "area" rules apply to one subsystem; "repo-wide" rules apply to any contributor.
// Tagged by the model in cluster.ts's per-bucket draft; consumed as a scoring
// penalty in score.ts.
export const GeneralitySchema = z.enum(["repo-wide", "area", "site-specific"]);
export type Generality = z.infer<typeof GeneralitySchema>;

export const EvidenceRecordSchema = z.object({
  pr: z.number().int().positive(),
  author: z.string(),
  association: AssociationSchema,
  quote: z.string(),
  createdAt: z.string(),
  verified: z.boolean(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const RuleRecordSchema = z.object({
  id: z.string(),
  statement: z.string().min(1),
  category: z.enum(["style", "architecture", "testing", "process", "tooling", "domain"]),
  polarity: z.enum(["prescriptive", "proscriptive"]),
  scope: z.array(z.string()),
  score: z.number().min(0).max(1),
  verdict: VerdictSchema,
  rationale: z.string().optional(),
  evidence: z.array(EvidenceRecordSchema),
  exemplars: z.array(z.string()),
  lastCorroborated: z.string().nullable(),
  // Additive, optional (0.2.x sidecars stay parseable): why a record landed in
  // provenance.dropped rather than the rendered doc. Only ever set on dropped
  // records; "rules" entries never carry it. Currently only "recurrence-floor"
  // (v0.3 Task 1) populates it — score-threshold drops stay reason-less for now,
  // left open for a future task to tag without another schema change.
  droppedReason: z.enum(["recurrence-floor"]).optional(),
  // Additive, optional (v0.3 Task 2): the generality tag the cluster call assigned
  // this rule's group, carried through to provenance for auditability. Absent on
  // old sidecars, synthetic code-only rules, and any cluster the model (or a
  // deterministic fallback path) didn't tag — score.ts treats absence as
  // "repo-wide" (no penalty), so this being unset never implies a penalty was
  // silently dropped.
  generality: GeneralitySchema.optional(),
  // Additive, optional (v0.3 Task 3): set only on the KEPT member of a cross-bucket
  // dedup merge (see reconciler/dedupe.ts) — the original ids of the rules folded
  // into this one. Absent on every record that wasn't a merge target, including all
  // 0.2.x sidecars.
  mergedFrom: z.array(z.string()).optional(),
});
export type RuleRecord = z.infer<typeof RuleRecordSchema>;

export const ContestedItemSchema = z.object({
  id: z.string(),
  statement: z.string(),
  reason: z.string(),
  sides: z.array(z.object({ statement: z.string(), evidence: z.array(EvidenceRecordSchema) })),
});
export type ContestedItem = z.infer<typeof ContestedItemSchema>;

export const ProvenanceSchema = z.object({
  generatedAt: z.string(),
  intent: z.string(),
  rules: z.array(RuleRecordSchema),
  dropped: z.array(RuleRecordSchema),
  contested: z.array(ContestedItemSchema),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

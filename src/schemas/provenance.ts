import { z } from "zod";
import { AssociationSchema } from "./normalized-pr.js";

export const VerdictSchema = z.enum([
  "corroborated", "trending-toward", "unobservable",
  "trending-away", "contradicted-stable", "contested",
]);
export type Verdict = z.infer<typeof VerdictSchema>;

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

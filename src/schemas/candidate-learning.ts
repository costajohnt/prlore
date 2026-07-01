import { z } from "zod";
import { AssociationSchema } from "./normalized-pr.js";

export const CandidateLearningSchema = z.object({
  statement: z.string().min(1),
  rationale: z.string().optional(),
  category: z.enum(["style", "architecture", "testing", "process", "tooling", "domain"]),
  scope: z.array(z.string()).default([]),
  polarity: z.enum(["prescriptive", "proscriptive"]),
  evidence: z
    .array(
      z.object({
        pr: z.number().int().positive(),
        author: z.string(),
        association: AssociationSchema,
        quote: z.string(),
        createdAt: z.string(),
      }),
    )
    .min(1),
});
export type CandidateLearning = z.infer<typeof CandidateLearningSchema>;

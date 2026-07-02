import { z } from "zod";

export const AreaSchema = z.object({
  path: z.string(),
  stack: z.array(z.string()),
  recencyScore: z.number().min(0).max(1),
  owners: z.array(z.string()).optional(),
  description: z.string(),
});

export const PatternSchema = z.object({
  statement: z.string().min(1),
  scope: z.array(z.string()),
  exemplars: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export const MigrationSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  status: z.enum(["in-progress", "complete"]),
  evidence: z.object({
    oldCount: z.number().int().min(0),
    newCount: z.number().int().min(0),
    trend: z.enum(["rising", "falling", "flat"]),
  }),
});
export type Migration = z.infer<typeof MigrationSchema>;

export const PatternsModelSchema = z.object({
  areas: z.array(AreaSchema),
  patterns: z.array(PatternSchema),
  migrations: z.array(MigrationSchema),
  meta: z.object({
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    tooling: z.array(z.string()),
  }),
});
export type PatternsModel = z.infer<typeof PatternsModelSchema>;

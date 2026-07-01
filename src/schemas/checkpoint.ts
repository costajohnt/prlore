import { z } from "zod";

export const StageSchema = z.enum([
  "fetching", "extracting", "analyzing", "synthesizing", "ready-for-preview", "failed",
]);
export type Stage = z.infer<typeof StageSchema>;

export const CheckpointSchema = z.object({
  configHash: z.string(),
  stage: StageSchema,
  cursor: z.string().nullable(),
  overflowQueue: z.array(z.number().int()),
  maxUpdatedAt: z.string().nullable(),
  counters: z.record(z.string(), z.number()).default({}),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

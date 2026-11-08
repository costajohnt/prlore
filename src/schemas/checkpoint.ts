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
  // Set when a re-run starts an incremental pass over a finished corpus: the pass pages
  // newest-first and stops at this watermark (the previous pass's maxUpdatedAt). Kept
  // separate from maxUpdatedAt, which this pass raises as it goes, so a resumed pass
  // still stops at the right place.
  refreshFrom: z.string().nullable().optional(),
  counters: z.record(z.string(), z.number()).default({}),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

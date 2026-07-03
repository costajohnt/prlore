import type { Stage } from "../schemas/checkpoint.js";

// spec §8 shape. Replaces the Phase 1 stub union: every field beyond `state` is
// optional so `{ state: "idle" }` (the Phase 1 contract server.test.ts pins) stays
// a valid JobStatus without change.
export interface JobStatus {
  state: "idle" | "running" | "ready-for-preview" | "failed" | "cancelled";
  jobId?: string;
  stage?: Stage;
  counters?: Record<string, number>;
  warnings?: string[];
  tokensSpentUsd?: number;
  error?: string;
}

export class JobRegistry {
  // Phase 1: no jobs exist yet. Phase 6's JobManager (src/jobs/manager.ts) implements
  // the real orchestration; wiring it into server.ts is a later task.
  status(_jobId?: string): JobStatus {
    return { state: "idle" };
  }
}

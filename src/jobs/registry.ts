export type JobStatus =
  | { state: "idle" }
  | {
      state: "running" | "ready-for-preview" | "failed";
      jobId: string;
      stage: string;
      counters: Record<string, number>;
    };

export class JobRegistry {
  // Phase 1: no jobs exist yet. Phase 6's JobManager replaces the body,
  // keeping this signature — `status` tool output is a public contract.
  status(_jobId?: string): JobStatus {
    return { state: "idle" };
  }
}

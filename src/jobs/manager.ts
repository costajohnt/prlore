import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyze } from "../analyzer/analyze.js";
import { realGit, type GitRunner } from "../analyzer/git.js";
import type { GqlTransport } from "../github/client.js";
import { configHash } from "../github/config-hash.js";
import { fetchCorpus } from "../github/fetcher.js";
import { Throttle } from "../github/throttle.js";
import { Extractor } from "../extractor/extractor.js";
import { BudgetExceededError, type ModelProvider } from "../model/provider.js";
import { synthesize } from "../reconciler/synthesize.js";
import { CandidateLearningSchema, type CandidateLearning } from "../schemas/candidate-learning.js";
import { CheckpointSchema, type Checkpoint } from "../schemas/checkpoint.js";
import type { MineConfig } from "../schemas/mine-config.js";
import type { ContestedItem, Provenance } from "../schemas/provenance.js";
import { loadCheckpoint, saveCheckpoint } from "../state/checkpoint.js";
import { readCorpus } from "../state/corpus.js";
import { cappedProvider } from "./capped-provider.js";
import type { JobStatus } from "./registry.js";

export type { JobStatus };

// Fraction of maxBudgetUsd reserved for synthesis (reconcile + plan — the single most
// valuable LLM calls, which rethrow BudgetExceededError as a hard failure). Extraction
// is capped at the remaining (1 - reserve) so a budget-partial extraction leaves
// synthesis enough headroom to complete — otherwise "budget-partial -> ready-for-preview"
// would be unreachable against the real provider's shared monotonic spend counter.
// Fixed for v1; not config-exposed.
const SYNTHESIS_RESERVE = 0.2;

export interface JobDeps {
  transport: GqlTransport;
  provider: ModelProvider;
  git?: GitRunner;
  stateDir: string;
  repoPath: string;
  now?: () => number;
}

export interface JobResult {
  draft: string;
  provenance: Provenance;
  contested: ContestedItem[];
}

// Public surface the MCP tool layer (src/server-tools.ts) programs against, so tests
// can inject a stub structurally compatible with JobManager. A class with private
// fields (JobManager.job below) is otherwise only assignable from itself/subclasses,
// never from a plain object literal — this interface only lists the public methods,
// so any object shaped like it (real or stub) satisfies it.
export interface JobManagerApi {
  start(config: MineConfig, deps: JobDeps): { jobId: string; resumed: boolean };
  status(jobId?: string): JobStatus;
  cancel(jobId: string): Promise<{ checkpointed: boolean }>;
  result(jobId: string): JobResult | null;
}

const CHECKPOINT_FILE = "checkpoint.json";

interface RunningJob {
  jobId: string;
  config: MineConfig;
  deps: JobDeps;
  cancelRequested: boolean;
  status: JobStatus;
  result: JobResult | null;
  settledPromise: Promise<void>;
}

// Synchronous peek at an on-disk checkpoint, used ONLY to answer `resumed` and to seed
// the initial in-memory status from start() — which the spec contract requires to
// return `{ jobId, resumed }` synchronously, not a Promise. The async pipeline (run())
// re-reads the checkpoint for real via loadCheckpoint() and is the source of truth;
// this peek never writes anything and tolerates a missing/corrupt file by returning null.
function peekCheckpoint(stateDir: string): Checkpoint | null {
  try {
    const text = readFileSync(join(stateDir, CHECKPOINT_FILE), "utf8");
    const parsed = CheckpointSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function numericCounters(obj: object): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number") out[k] = v;
  }
  return out;
}

// Excludes threaded into the reconciliation probes (grep/pickaxe) so the tool never
// treats its own output, state dir, or the emit target as evidence of a convention.
function defaultExcludes(config: MineConfig): string[] {
  return [...new Set(["AGENTS.md", ".prlore", config.output.target])];
}

/**
 * Orchestrates the full mining pipeline (spec §9): analyze() first to reserve budget,
 * then fetchCorpus with the extractor attached via onPr (fetch and extraction overlap),
 * a post-fetch corpus sweep to cover PRs a resumed run's stream missed, then synthesize.
 *
 * start() returns synchronously and the pipeline runs detached in the background;
 * status() reads live state. Beyond the spec §8/§9 contract (start/status/cancel/result)
 * this class also exposes `settled()` — an internal test hook, not part of the public
 * contract — so tests can await the detached pipeline's completion deterministically
 * instead of polling with sleeps.
 */
export class JobManager implements JobManagerApi {
  private job: RunningJob | null = null;

  start(config: MineConfig, deps: JobDeps): { jobId: string; resumed: boolean } {
    if (this.job && this.job.status.state === "running") {
      throw new Error("a job is already running on this manager instance");
    }

    const jobId = randomUUID();
    const hash = configHash(config);
    const existing = peekCheckpoint(deps.stateDir);
    const resumed = existing !== null && existing.configHash === hash;

    const status: JobStatus = {
      state: "running",
      jobId,
      stage: resumed ? existing!.stage : "fetching",
      counters: resumed ? { ...existing!.counters } : {},
      warnings: [],
      tokensSpentUsd: 0,
    };

    const job: RunningJob = {
      jobId,
      config,
      deps,
      cancelRequested: false,
      status,
      result: null,
      settledPromise: Promise.resolve(),
    };
    job.settledPromise = this.run(job, hash).catch((err) => {
      job.status = {
        ...job.status,
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    });
    this.job = job;

    return { jobId, resumed };
  }

  status(jobId?: string): JobStatus {
    if (!this.job || (jobId !== undefined && jobId !== this.job.jobId)) {
      return { state: "idle" };
    }
    const s = this.job.status;
    // Deep-copy the mutable containers: callers must not be able to mutate live state
    // (or observe its mutation) through a returned snapshot.
    return {
      ...s,
      ...(s.counters ? { counters: { ...s.counters } } : {}),
      ...(s.warnings ? { warnings: [...s.warnings] } : {}),
      tokensSpentUsd: this.job.deps.provider.spentUsd(),
    };
  }

  async cancel(jobId: string): Promise<{ checkpointed: boolean }> {
    const job = this.job;
    if (!job || job.jobId !== jobId) return { checkpointed: false };

    if (job.status.state === "running") {
      job.cancelRequested = true;
      await job.settledPromise;
    }

    const now = job.deps.now ?? Date.now;
    const cp = await loadCheckpoint(job.deps.stateDir, now);
    return { checkpointed: cp !== null };
  }

  result(jobId: string): JobResult | null {
    if (!this.job || this.job.jobId !== jobId) return null;
    if (this.job.status.state !== "ready-for-preview") return null;
    return this.job.result;
  }

  /** Test-only hook (not part of the spec §8/§9 contract): resolves once the current
   * job's detached pipeline has settled into ready-for-preview, failed, or cancelled. */
  async settled(): Promise<void> {
    if (!this.job) return;
    await this.job.settledPromise;
  }

  private mergeStatus(job: RunningJob, patch: Partial<JobStatus>): void {
    job.status = { ...job.status, ...patch };
  }

  private checkCancel(job: RunningJob): boolean {
    if (!job.cancelRequested) return false;
    this.mergeStatus(job, { state: "cancelled" });
    return true;
  }

  private async run(job: RunningJob, hash: string): Promise<void> {
    const { config, deps } = job;
    const now = deps.now ?? Date.now;
    const git = deps.git ?? realGit;

    // Stage ownership: JobManager writes the initial checkpoint (stage "fetching")
    // when there is no matching one on disk yet — every stage transition after this
    // belongs to the self-flip that owns it (fetcher: fetching->extracting; extractor
    // sweep below: extracting->analyzing; synthesize: analyzing|synthesizing->ready-for-preview).
    let cp = await loadCheckpoint(deps.stateDir, now);
    if (!cp || cp.configHash !== hash) {
      cp = { configHash: hash, stage: "fetching", cursor: null, overflowQueue: [], maxUpdatedAt: null, counters: {} };
      await saveCheckpoint(deps.stateDir, cp);
    }
    this.mergeStatus(job, { stage: cp.stage, counters: { ...cp.counters } });
    if (this.checkCancel(job)) return;

    // Step 1: analyze() FIRST. Cheap, one LLM call — reserves budget before the
    // (much more expensive) per-PR extraction pass gets a chance to spend it.
    const patterns = await analyze(deps.repoPath, config, {
      provider: deps.provider,
      git,
      now,
      stateDir: deps.stateDir,
    });
    if (this.checkCancel(job)) return;

    // Step 2: fetchCorpus with the extractor attached via onPr — fetch and extraction
    // overlap. Extractor.enqueue() throws once drain() has run, so this instance must
    // never be drained before the post-fetch sweep below has finished enqueueing.
    // Extraction runs against a REDUCED cap (see SYNTHESIS_RESERVE): analyze (above)
    // and synthesize (below) get the raw provider with the full budget.
    const extractionProvider = cappedProvider(
      deps.provider,
      config.model.maxBudgetUsd * (1 - SYNTHESIS_RESERVE),
    );
    const extractor = new Extractor({ provider: extractionProvider, stateDir: deps.stateDir, model: config.model.model });
    const throttle = new Throttle({ now });
    const fetchSummary = await fetchCorpus(config, {
      transport: deps.transport,
      throttle,
      stateDir: deps.stateDir,
      onPr: (pr) => extractor.enqueue(pr),
    });
    // Merge both the checkpoint's own persisted counters (e.g. botCommentsStripped,
    // which never surfaces on FetchSummary) and the summary's computed fields (e.g.
    // drifted, which isn't a raw checkpoint counter) — status exposes the union.
    const cpAfterFetch = await loadCheckpoint(deps.stateDir, now);
    this.mergeStatus(job, {
      counters: { ...job.status.counters, ...(cpAfterFetch?.counters ?? {}), ...numericCounters(fetchSummary) },
    });
    if (this.checkCancel(job)) return;

    // Step 2.5: post-fetch corpus sweep. The streaming onPr hook covers PRs fetched
    // THIS run; a resumed run may have PRs already on disk from a prior invocation
    // that never streamed through this fresh Extractor instance. Enqueue them too —
    // Extractor's own (number|updatedAt) dedup absorbs the overlap with the stream for free.
    const { prs } = await readCorpus(join(deps.stateDir, "corpus.jsonl"));
    for (const pr of prs) extractor.enqueue(pr);
    const extractSummary = await extractor.drain();
    this.mergeStatus(job, { counters: { ...job.status.counters, ...numericCounters(extractSummary) } });

    const warnings = [...(job.status.warnings ?? [])];
    if (extractSummary.skippedBudget > 0) {
      warnings.push(
        `extraction budget-partial: ${extractSummary.skippedBudget} skipped; resume with a higher budget re-uses the cache`,
      );
    }
    if (extractSummary.prsSeen === 0) {
      warnings.push("no PRs processed — corpus empty or config too narrow");
    }
    this.mergeStatus(job, { warnings });

    // Self-flip extracting->analyzing, guarded exactly like extractFromCorpus.ts: a
    // budget-partial run must NOT advance the on-disk stage, so a later resume with a
    // raised budget re-enters extraction and gets cheap cache hits for everything
    // already extracted. The pipeline still proceeds to synthesize below regardless —
    // extraction budget-partial is a warning, not a stop.
    const cpAfterExtract = await loadCheckpoint(deps.stateDir, now);
    if (cpAfterExtract && cpAfterExtract.stage === "extracting" && extractSummary.skippedBudget === 0) {
      cpAfterExtract.stage = "analyzing";
      await saveCheckpoint(deps.stateDir, cpAfterExtract);
    }
    if (cpAfterExtract) this.mergeStatus(job, { stage: cpAfterExtract.stage });
    if (this.checkCancel(job)) return;

    // Step 3: synthesize. excludes defaulted+deduped; synthesize owns the
    // analyzing|synthesizing -> ready-for-preview self-flip.
    const candidatesText = await readFile(join(deps.stateDir, "candidates.json"), "utf8");
    const candidates: CandidateLearning[] = CandidateLearningSchema.array().parse(JSON.parse(candidatesText));

    let synthResult: Awaited<ReturnType<typeof synthesize>>;
    try {
      synthResult = await synthesize(config, patterns, candidates, prs, {
        provider: deps.provider,
        repoPath: deps.repoPath,
        git,
        now,
        stateDir: deps.stateDir,
        excludes: defaultExcludes(config),
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        this.mergeStatus(job, {
          state: "failed",
          error: `model budget exhausted during synthesis: $${err.spentUsd.toFixed(2)} of $${err.capUsd.toFixed(2)} cap`,
        });
        return;
      }
      throw err;
    }

    job.result = { draft: synthResult.draft, provenance: synthResult.provenance, contested: synthResult.contested };
    this.mergeStatus(job, {
      state: "ready-for-preview",
      stage: "ready-for-preview",
      warnings: [...(job.status.warnings ?? []), ...synthResult.warnings],
    });
  }
}

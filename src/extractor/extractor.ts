import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BudgetExceededError, type ModelProvider } from "../model/provider.js";
import type { CandidateLearning } from "../schemas/candidate-learning.js";
import type { NormalizedPr } from "../schemas/normalized-pr.js";
import { extractOne } from "./extract-one.js";
import { readCache, writeCache } from "./cache.js";
import { createLimiter } from "./pool.js";

export interface ExtractorDeps {
  provider: ModelProvider;
  stateDir: string;
  concurrency?: number;
  model?: string;
}

export interface ExtractSummary {
  prsSeen: number;
  extracted: number;
  cacheHits: number;
  failed: number;
  skippedBudget: number;
  duplicates: number;
  candidates: number;
}

const MAX_ATTEMPTS = 3;
// Must match AnthropicProvider's DEFAULT_MODEL; Phase 6 wires the real value from config.
const DEFAULT_MODEL = "claude-sonnet-5";

export class Extractor {
  private readonly limit: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly model: string;
  private readonly seen = new Set<string>();
  private readonly tasks: Promise<void>[] = [];
  private readonly collected: CandidateLearning[] = [];
  private budgetExhausted = false;
  private drained: Promise<ExtractSummary> | null = null;
  private readonly summary: ExtractSummary = {
    prsSeen: 0, extracted: 0, cacheHits: 0, failed: 0,
    skippedBudget: 0, duplicates: 0, candidates: 0,
  };

  constructor(private readonly deps: ExtractorDeps) {
    this.limit = createLimiter(deps.concurrency ?? 4);
    this.model = deps.model ?? DEFAULT_MODEL;
  }

  enqueue(pr: NormalizedPr): void {
    if (this.drained) throw new Error("Extractor.enqueue() called after drain()");
    const key = `${pr.number}|${pr.updatedAt}`;
    if (this.seen.has(key)) {
      this.summary.duplicates++;
      return;
    }
    this.seen.add(key);
    this.summary.prsSeen++;
    this.tasks.push(this.limit(() => this.process(pr)));
  }

  private async process(pr: NormalizedPr): Promise<void> {
    // Cache reads are free: check the cache before the budget short-circuit so a
    // budget trip never discards a candidate that costs nothing to retrieve.
    const cached = await readCache(this.deps.stateDir, pr, this.model);
    if (cached) {
      this.summary.cacheHits++;
      this.collected.push(...cached);
      return;
    }
    if (this.budgetExhausted) {
      this.summary.skippedBudget++;
      return;
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const candidates = await extractOne(pr, this.deps.provider, this.model);
        try {
          await writeCache(this.deps.stateDir, pr, this.model, candidates);
        } catch {
          // cache write failure is non-fatal: results are still collected, just not cached
        }
        this.summary.extracted++;
        this.collected.push(...candidates);
        return;
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          this.budgetExhausted = true;
          this.summary.skippedBudget++;
          return;
        }
        if (attempt === MAX_ATTEMPTS) this.summary.failed++;
      }
    }
  }

  drain(): Promise<ExtractSummary> {
    this.drained ??= (async () => {
      await Promise.all(this.tasks);
      const path = join(this.deps.stateDir, "candidates.json");
      await mkdir(this.deps.stateDir, { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(this.collected, null, 2), "utf8");
      await rename(tmp, path);
      this.summary.candidates = this.collected.length;
      return this.summary;
    })();
    // Return a snapshot so callers can't mutate (or observe mutation of) internal state.
    return this.drained.then((s) => ({ ...s }));
  }
}

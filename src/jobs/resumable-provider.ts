import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompleteOptions, ModelProvider } from "../model/provider.js";
import { atomicWriteFile } from "../state/atomic.js";

// untrustedFence() adds a random suffix to every prompt's tag; drop it from the key.
const FENCE_SUFFIX = /(untrusted_pr_data)_[0-9a-f]{12}/g;

/**
 * Saves every successful reply under `dir`, keyed on the prompt, so re-running after a
 * failed synthesis (budget, truncation, a model outage) reuses the calls already paid for
 * instead of starting over. Failed calls are never saved. JobManager clears `dir` once a
 * run synthesizes without any model failure.
 */
export function resumableProvider(inner: ModelProvider, dir: string, salt: string): ModelProvider {
  return {
    spentUsd: () => inner.spentUsd(),
    ...(inner.capUsd ? { capUsd: () => inner.capUsd!() } : {}),
    async complete<T>(opts: CompleteOptions<T>): Promise<T> {
      const key = createHash("sha256")
        .update(JSON.stringify([salt, opts.system ?? "", opts.prompt.replace(FENCE_SUFFIX, "$1"), opts.maxTokens ?? null]))
        .digest("hex");
      const path = join(dir, `${key}.json`);
      try {
        return opts.schema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch {
        // missing, corrupt, or schema-drifted: a miss
      }
      const result = await inner.complete(opts);
      await atomicWriteFile(path, JSON.stringify(result)).catch(() => {}); // a failed save only costs a later re-run
      return result;
    },
  };
}

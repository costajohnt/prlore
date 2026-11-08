import type { ZodType } from "zod";

export interface CompleteOptions<T> {
  system?: string;
  prompt: string;
  schema: ZodType<T>;
  maxTokens?: number;
}

export interface ModelProvider {
  complete<T>(opts: CompleteOptions<T>): Promise<T>;
  spentUsd(): number;
  /** The budget cap this provider enforces, when it has one. */
  capUsd?(): number;
}

export class BudgetExceededError extends Error {
  constructor(readonly spentUsd: number, readonly capUsd: number) {
    super(`model budget exhausted: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} cap`);
    this.name = "BudgetExceededError";
  }
}

/**
 * The model stopped because it hit the output-token cap, so its reply is cut off.
 * Providers throw this instead of a schema retry: resending the same prompt with the
 * same cap truncates again. Synthesis splits the batch and retries smaller halves.
 */
export class OutputTruncatedError extends Error {
  constructor(readonly maxTokens: number) {
    super(`model output truncated at the ${maxTokens}-token output cap`);
    this.name = "OutputTruncatedError";
  }
}

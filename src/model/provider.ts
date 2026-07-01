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
}

export class BudgetExceededError extends Error {
  constructor(readonly spentUsd: number, readonly capUsd: number) {
    super(`model budget exhausted: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} cap`);
    this.name = "BudgetExceededError";
  }
}

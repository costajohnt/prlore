import { expect, test } from "vitest";
import { cappedProvider } from "../src/jobs/capped-provider.js";
import { BudgetExceededError, type CompleteOptions, type ModelProvider } from "../src/model/provider.js";

/** Books `costPerCall` when each call finishes, after a delay, like a real provider. */
function slowProvider(costPerCall: number): ModelProvider {
  let spent = 0;
  return {
    spentUsd: () => spent,
    async complete<T>(_opts: CompleteOptions<T>): Promise<T> {
      await new Promise((resolve) => setTimeout(resolve, 5));
      spent += costPerCall;
      return {} as T;
    },
  };
}

test("concurrent calls cannot run the spend past the cap by the number of calls in flight", async () => {
  const inner = slowProvider(1);
  const capped = cappedProvider(inner, 8);
  const opts = { prompt: "x", schema: { parse: (v: unknown) => v } } as CompleteOptions<unknown>;

  // Four workers keep calling until the gate refuses, like the extractor's limiter.
  const worker = async () => {
    for (;;) {
      try {
        await capped.complete(opts);
      } catch (err) {
        if (err instanceof BudgetExceededError) return;
        throw err;
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  // Gating on booked spend alone lets all four in-flight calls through at 7, ending at 11.
  expect(inner.spentUsd()).toBeLessThanOrEqual(8);
});

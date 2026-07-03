import { expect, test, vi } from "vitest";
import { z } from "zod";
import { ClaudeCliProvider, type RunCli } from "../src/model/claude-cli.js";
import { BudgetExceededError } from "../src/model/provider.js";

const schema = z.object({ answer: z.string() });

/**
 * Fake RunCli, scripted like model.test.ts's fakeClient: each call consumes the
 * next scripted envelope (clamped to the last one once exhausted, so tests that
 * only care about the first N calls don't need to pad the list).
 */
function fakeRunCli(replies: { result: string; total_cost_usd?: number }[]) {
  let call = 0;
  const run = vi.fn(async (_args: string[], _input: string, _timeoutMs: number) => {
    const r = replies[Math.min(call, replies.length - 1)]!;
    call++;
    const envelope: Record<string, unknown> = { result: r.result };
    if (r.total_cost_usd !== undefined) envelope.total_cost_usd = r.total_cost_usd;
    return { stdout: JSON.stringify(envelope), exitCode: 0, stderr: "" };
  });
  return run;
}

test("complete returns schema-validated JSON and books cost", async () => {
  const run = fakeRunCli([{ result: '{"answer":"yes"}', total_cost_usd: 0.01 }]);
  const p = new ClaudeCliProvider({ maxBudgetUsd: 10 }, run as unknown as RunCli);
  await expect(p.complete({ prompt: "q", schema })).resolves.toEqual({ answer: "yes" });
  expect(p.spentUsd()).toBeCloseTo(0.01);

  // headless invocation shape: -p / --output-format json, prompt via stdin (2nd arg)
  const [args, input] = run.mock.calls[0]!;
  expect(args).toContain("-p");
  expect(args).toContain("--output-format");
  expect(args).toContain("json");
  expect(input).toBe("q");
});

test("passes --model and --system-prompt flags when provided", async () => {
  const run = fakeRunCli([{ result: '{"answer":"yes"}', total_cost_usd: 0.01 }]);
  const p = new ClaudeCliProvider({ model: "sonnet", maxBudgetUsd: 10 }, run as unknown as RunCli);
  await p.complete({ system: "be terse", prompt: "q", schema });
  const [args] = run.mock.calls[0]!;
  expect(args).toEqual(expect.arrayContaining(["--model", "sonnet", "--system-prompt", "be terse"]));
});

test("does not pass --model when opts.model is unset", async () => {
  const run = fakeRunCli([{ result: '{"answer":"yes"}', total_cost_usd: 0.01 }]);
  const p = new ClaudeCliProvider({ maxBudgetUsd: 10 }, run as unknown as RunCli);
  await p.complete({ prompt: "q", schema });
  const [args] = run.mock.calls[0]!;
  expect(args).not.toContain("--model");
  expect(args).not.toContain("--system-prompt");
});

test("spend accumulates monotonically across calls", async () => {
  const run = fakeRunCli([
    { result: '{"answer":"a"}', total_cost_usd: 0.01 },
    { result: '{"answer":"b"}', total_cost_usd: 0.02 },
  ]);
  const p = new ClaudeCliProvider({ maxBudgetUsd: 10 }, run as unknown as RunCli);
  await p.complete({ prompt: "q", schema });
  expect(p.spentUsd()).toBeCloseTo(0.01);
  await p.complete({ prompt: "q", schema });
  expect(p.spentUsd()).toBeCloseTo(0.03);
});

test("throws BudgetExceededError once spend crosses the cap, before calling the CLI again", async () => {
  const run = fakeRunCli([{ result: '{"answer":"a"}', total_cost_usd: 0.02 }]);
  const p = new ClaudeCliProvider({ maxBudgetUsd: 0.02 }, run as unknown as RunCli);
  await expect(p.complete({ prompt: "q", schema })).resolves.toEqual({ answer: "a" });
  await expect(p.complete({ prompt: "q", schema })).rejects.toThrow(BudgetExceededError);
  expect(run).toHaveBeenCalledTimes(1);
});

test("retries once on invalid output, feeding the validation error back via stdin", async () => {
  const run = fakeRunCli([
    { result: "not json at all", total_cost_usd: 0.01 },
    { result: '{"answer":"fixed"}', total_cost_usd: 0.01 },
  ]);
  const p = new ClaudeCliProvider({ maxBudgetUsd: 10 }, run as unknown as RunCli);
  await expect(p.complete({ prompt: "q", schema })).resolves.toEqual({ answer: "fixed" });
  expect(run).toHaveBeenCalledTimes(2);
  const secondInput = run.mock.calls[1]![1] as string;
  expect(secondInput).toContain("invalid");
  expect(secondInput).toContain("q");
});

test("fails after two invalid attempts, with the last validation error in the message", async () => {
  const run = fakeRunCli([{ result: "not json at all", total_cost_usd: 0.01 }]);
  const p = new ClaudeCliProvider({ maxBudgetUsd: 10 }, run as unknown as RunCli);
  await expect(p.complete({ prompt: "q", schema })).rejects.toThrow(/schema validation/);
  expect(run).toHaveBeenCalledTimes(2);
});

test("non-zero exit surfaces the exit code and a bounded stderr excerpt", async () => {
  const longStderr = "x".repeat(500);
  const run = vi.fn(async () => ({ stdout: "", exitCode: 7, stderr: longStderr }));
  const p = new ClaudeCliProvider({ maxBudgetUsd: 10 }, run as unknown as RunCli);
  const err = await p.complete({ prompt: "q", schema }).catch((e: unknown) => e as Error);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("7");
  // excerpt must be bounded — the raw 500-char stderr cannot appear whole in the message
  expect((err as Error).message.length).toBeLessThan(longStderr.length);
  expect((err as Error).message).toContain("x".repeat(300));
  expect((err as Error).message).not.toContain("x".repeat(301));
});

test("ENOENT spawn failure names the ANTHROPIC_API_KEY fallback", async () => {
  const run = vi.fn(async () => {
    const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  const p = new ClaudeCliProvider({ maxBudgetUsd: 10 }, run as unknown as RunCli);
  await expect(p.complete({ prompt: "q", schema })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  await expect(p.complete({ prompt: "q", schema })).rejects.toThrow(/claude CLI not found on PATH/);
});

test("missing total_cost_usd books 0 and fires onWarn", async () => {
  const run = vi.fn(async () => ({ stdout: JSON.stringify({ result: '{"answer":"a"}' }), exitCode: 0, stderr: "" }));
  const onWarn = vi.fn();
  const p = new ClaudeCliProvider({ maxBudgetUsd: 10, onWarn }, run as unknown as RunCli);
  await expect(p.complete({ prompt: "q", schema })).resolves.toEqual({ answer: "a" });
  expect(p.spentUsd()).toBe(0);
  expect(onWarn).toHaveBeenCalledTimes(1);
});

test("non-finite total_cost_usd books 0 and fires onWarn, never NaN", async () => {
  const run = vi.fn(async () => ({
    stdout: JSON.stringify({ result: '{"answer":"a"}', total_cost_usd: Number.NaN }),
    exitCode: 0,
    stderr: "",
  }));
  const onWarn = vi.fn();
  const p = new ClaudeCliProvider({ maxBudgetUsd: 10, onWarn }, run as unknown as RunCli);
  await p.complete({ prompt: "q", schema });
  expect(p.spentUsd()).toBe(0);
  expect(Number.isNaN(p.spentUsd())).toBe(false);
  expect(onWarn).toHaveBeenCalledTimes(1);
});

test("negative total_cost_usd books 0 and fires onWarn, maintains monotonicity", async () => {
  const run = fakeRunCli([{ result: '{"answer":"a"}', total_cost_usd: -5 }]);
  const onWarn = vi.fn();
  const p = new ClaudeCliProvider({ maxBudgetUsd: 10, onWarn }, run as unknown as RunCli);
  await expect(p.complete({ prompt: "q", schema })).resolves.toEqual({ answer: "a" });
  expect(p.spentUsd()).toBe(0);
  expect(onWarn).toHaveBeenCalledTimes(1);
});

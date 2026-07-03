import { expect, test, vi } from "vitest";
import { selectProvider, hasClaudeCli } from "../src/model/select-provider.js";
import { AnthropicProvider } from "../src/model/anthropic.js";
import { ClaudeCliProvider } from "../src/model/claude-cli.js";

const baseModelConfig = { provider: "anthropic" as const, maxBudgetUsd: 10 };

function noop() {}

function captureThrow(fn: () => unknown): string {
  try {
    fn();
    throw new Error("expected selectProvider to throw");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ---- explicit "anthropic" -------------------------------------------------

test('"anthropic" with a key set constructs AnthropicProvider', () => {
  const env = { ANTHROPIC_API_KEY: "sk-ant-fake-for-test" };
  const onNotice = vi.fn();
  const provider = selectProvider({ ...baseModelConfig, provider: "anthropic" }, env, () => false, onNotice);
  expect(provider).toBeInstanceOf(AnthropicProvider);
  expect(onNotice).not.toHaveBeenCalled();
});

test('"anthropic" with no key throws BEFORE constructing the SDK client, naming ANTHROPIC_API_KEY', () => {
  const env = {}; // no ANTHROPIC_API_KEY
  expect(() =>
    selectProvider({ ...baseModelConfig, provider: "anthropic" }, env, () => true, noop),
  ).toThrowError(/ANTHROPIC_API_KEY/);
});

test('"anthropic" pre-check error is our own message, not the SDK\'s late auth-resolution error', () => {
  const msg = captureThrow(() => selectProvider({ ...baseModelConfig, provider: "anthropic" }, {}, () => true, noop));
  expect(msg).not.toMatch(/Could not resolve authentication method/);
  expect(msg).toMatch(/ANTHROPIC_API_KEY/);
});

// ---- explicit "claude-cli" -------------------------------------------------

test('"claude-cli" constructs ClaudeCliProvider regardless of ANTHROPIC_API_KEY', () => {
  const withKey = selectProvider({ ...baseModelConfig, provider: "claude-cli" }, { ANTHROPIC_API_KEY: "x" }, () => true, noop);
  expect(withKey).toBeInstanceOf(ClaudeCliProvider);

  const withoutKey = selectProvider({ ...baseModelConfig, provider: "claude-cli" }, {}, () => true, noop);
  expect(withoutKey).toBeInstanceOf(ClaudeCliProvider);
});

// ---- explicit "sampling" (defensive; the mine tool layer is the primary guard) --

test('"sampling" is rejected with a clear error naming "sampling"', () => {
  expect(() =>
    selectProvider({ ...baseModelConfig, provider: "sampling" }, {}, () => true, noop),
  ).toThrowError(/sampling/i);
});

// ---- "auto" ----------------------------------------------------------------

test('"auto" with a key set resolves to anthropic and fires no notice (compat with old default)', () => {
  const env = { ANTHROPIC_API_KEY: "sk-ant-fake-for-test" };
  const onNotice = vi.fn();
  const provider = selectProvider({ ...baseModelConfig, provider: "auto" }, env, () => true, onNotice);
  expect(provider).toBeInstanceOf(AnthropicProvider);
  expect(onNotice).not.toHaveBeenCalled();
});

test('"auto" with no key and claude CLI present falls back to claude-cli and fires exactly one notice', () => {
  const env = {};
  const onNotice = vi.fn();
  const hasCli = vi.fn(() => true);
  const provider = selectProvider({ ...baseModelConfig, provider: "auto" }, env, hasCli, onNotice);
  expect(provider).toBeInstanceOf(ClaudeCliProvider);
  expect(hasCli).toHaveBeenCalledTimes(1);
  expect(onNotice).toHaveBeenCalledTimes(1);
  expect(onNotice.mock.calls[0]![0]).toMatch(/ANTHROPIC_API_KEY/);
  expect(onNotice.mock.calls[0]![0]).toMatch(/claude/i);
});

test('"auto" with no key and no claude CLI throws naming both remedies', () => {
  const msg = captureThrow(() => selectProvider({ ...baseModelConfig, provider: "auto" }, {}, () => false, noop));
  expect(msg).toMatch(/ANTHROPIC_API_KEY/);
  expect(msg).toMatch(/claude/i);
});

test('"auto" does not call hasClaudeCli when a key is present (short-circuit, no unnecessary PATH probe)', () => {
  const hasCli = vi.fn(() => true);
  selectProvider({ ...baseModelConfig, provider: "auto" }, { ANTHROPIC_API_KEY: "x" }, hasCli, noop);
  expect(hasCli).not.toHaveBeenCalled();
});

// ---- model/budget pass-through ---------------------------------------------

test("selectProvider forwards model and maxBudgetUsd to the constructed claude-cli provider", () => {
  // ClaudeCliProvider has no public getters for model/budget, so drive it through
  // its actual budget gate: cap of 0 must trip BudgetExceededError on the very
  // first complete() call, proving maxBudgetUsd was really threaded through
  // (a provider built with some other default cap wouldn't trip immediately).
  const provider = selectProvider(
    { provider: "claude-cli", maxBudgetUsd: 0 },
    {},
    () => true,
    noop,
  );
  return expect(
    provider.complete({ prompt: "x", schema: { parse: (v: unknown) => v } as never }),
  ).rejects.toThrow(/budget/i);
});

// ---- hasClaudeCli default implementation (mocked spawnSync, no real PATH probe) --

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

test("hasClaudeCli returns true when the probe exits 0", async () => {
  const { spawnSync } = await import("node:child_process");
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
  expect(hasClaudeCli()).toBe(true);
});

test("hasClaudeCli returns false when the probe exits non-zero or errors", async () => {
  const { spawnSync } = await import("node:child_process");
  vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);
  expect(hasClaudeCli()).toBe(false);

  vi.mocked(spawnSync).mockImplementation(() => {
    throw new Error("spawn failed");
  });
  expect(hasClaudeCli()).toBe(false);
});

import { spawnSync } from "node:child_process";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { ModelProvider } from "./provider.js";
import type { MineConfig } from "../schemas/mine-config.js";

/**
 * Real "is the `claude` CLI on PATH" probe: `which`/`command -v` equivalent via a
 * child-process spawn, so we don't shell out to a resolver that itself might be
 * missing. `where` on win32 is the PATH-lookup equivalent of `which`. Any spawn
 * failure (ENOENT for the probe binary itself, permissions, etc.) counts as "not
 * found" — this only ever needs to answer yes/no, never explain why.
 */
export function hasClaudeCli(): boolean {
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    const res = spawnSync(probe, ["claude"], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Resolves a ModelProvider from `config.model` per plan Task 2. Everything the
 * decision depends on (env, the PATH probe, the notice sink) is passed in rather
 * than read directly, so this is testable without touching the real environment
 * or spawning a real process.
 */
export function selectProvider(
  config: MineConfig["model"],
  env: NodeJS.ProcessEnv,
  hasClaudeCliFn: () => boolean,
  onNotice: (msg: string) => void,
): ModelProvider {
  const buildAnthropic = (): ModelProvider => {
    // Fail fast, before touching the SDK: `new Anthropic()` does NOT throw at
    // construction time when no key is resolvable (verified against
    // @anthropic-ai/sdk client.js — auth is only validated per-request, in
    // validateHeaders). Left unchecked, a keyless config would build a client
    // that silently fails deep inside the mining pipeline on its first model
    // call instead of at startup. This check is what makes that failure
    // immediate and diagnosable.
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error(
        'model.provider "anthropic" requires ANTHROPIC_API_KEY to be set — export it, or set model.provider to "claude-cli" to use the local Claude Code CLI instead',
      );
    }
    return new AnthropicProvider({ model: config.model, maxBudgetUsd: config.maxBudgetUsd });
  };

  const buildClaudeCli = (): ModelProvider =>
    new ClaudeCliProvider({ model: config.model, maxBudgetUsd: config.maxBudgetUsd, onWarn: onNotice });

  const GITHUB_MODELS_BASE = "https://models.github.ai/inference";

  const buildOpenAICompatible = (o: {
    baseUrl: string;
    apiKey?: string;
    model: string;
  }): ModelProvider =>
    new OpenAICompatibleProvider({
      baseUrl: o.baseUrl,
      apiKey: o.apiKey,
      model: o.model,
      maxBudgetUsd: config.maxBudgetUsd,
      onWarn: onNotice,
      // pricePerMTok intentionally omitted: these endpoints are free-tier or
      // arbitrary, so cost tracking is disabled and --max-budget won't gate them.
    });

  const buildGithubModels = (): ModelProvider => {
    const key = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (!key) {
      throw new Error(
        'model.provider "github-models" requires GITHUB_TOKEN or GH_TOKEN to be set (present automatically in GitHub Actions / Codespaces / Copilot environments)',
      );
    }
    return buildOpenAICompatible({ baseUrl: GITHUB_MODELS_BASE, apiKey: key, model: config.model ?? "openai/gpt-4o-mini" });
  };

  const buildOllama = (): ModelProvider =>
    buildOpenAICompatible({
      baseUrl: env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
      model: config.model ?? "qwen2.5:7b",
    });

  const buildOpenAI = (): ModelProvider => {
    const baseUrl = config.baseUrl ?? env.OPENAI_BASE_URL;
    if (!baseUrl) throw new Error('model.provider "openai" requires --base-url or OPENAI_BASE_URL to be set');
    if (!config.model) throw new Error('model.provider "openai" requires --model to be set');
    const key = env.OPENAI_API_KEY;
    if (!key) throw new Error('model.provider "openai" requires OPENAI_API_KEY to be set');
    return buildOpenAICompatible({ baseUrl, apiKey: key, model: config.model });
  };

  switch (config.provider) {
    case "anthropic":
      return buildAnthropic();

    case "claude-cli":
      return buildClaudeCli();

    case "sampling":
      // Defensive only: the MCP `mine` tool handler (src/server-tools.ts)
      // intercepts "sampling" with its own hard tool error before
      // defaultMineDepsFactory — and therefore selectProvider — is ever
      // reached, so this branch never fires on the real MCP path. It exists
      // so a future direct caller of selectProvider that skips that
      // pre-check still gets a clear error instead of silently falling
      // through.
      throw new Error('model.provider "sampling" is not implemented in v1; use "anthropic" or "claude-cli"');

    case "auto":
      // Compat contract: every pre-Task-2 config either set provider explicitly
      // or omitted it and got the old default "anthropic" — and AnthropicProvider
      // only ever worked in that world when ANTHROPIC_API_KEY was set (the SDK
      // would fail on first call otherwise). So for every config that used to
      // actually function, ANTHROPIC_API_KEY is set — meaning "auto" resolves
      // straight to anthropic below, with the exact same construction as before.
      // Observed MCP behavior for every working old config is therefore
      // unchanged; "auto" only introduces new behavior (claude-cli fallback) in
      // the case that used to be a hard failure anyway (no key).
      if (env.ANTHROPIC_API_KEY) return buildAnthropic();
      if (hasClaudeCliFn()) {
        onNotice("no ANTHROPIC_API_KEY — using local claude CLI (subscription usage limits apply)");
        return buildClaudeCli();
      }
      if (env.GITHUB_TOKEN || env.GH_TOKEN) {
        onNotice("no ANTHROPIC_API_KEY and no claude CLI — using GitHub Models (free-tier rate limits apply; use --provider ollama for a full mine)");
        return buildGithubModels();
      }
      throw new Error(
        "no model provider available: set ANTHROPIC_API_KEY (Anthropic API), install Claude Code (claude CLI), set GITHUB_TOKEN (GitHub Models), or use --provider ollama for a local model",
      );

    case "github-models":
      return buildGithubModels();

    case "ollama":
      return buildOllama();

    case "openai":
      return buildOpenAI();
  }
}

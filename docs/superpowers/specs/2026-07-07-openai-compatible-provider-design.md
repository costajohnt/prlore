# Design: OpenAI-compatible model provider + presets (GitHub Models, Ollama, generic)

- **Date:** 2026-07-07
- **Status:** approved (John, 2026-07-07)
- **Refines:** ADR 006 (BYO-key model provider). New ADR 009 to be written from this spec.

## Problem

prlore's `mine` pipeline needs an LLM for per-PR extraction and synthesis. Today it
supports exactly two providers, both Claude-only:

- `anthropic` — Anthropic API, requires `ANTHROPIC_API_KEY`.
- `claude-cli` — the local `claude` binary (Claude Code subscription).

`selectProvider` (`src/model/select-provider.ts`) resolves one of these (or `auto`),
and throws when neither is available:

> "no model provider available: set ANTHROPIC_API_KEY to use the Anthropic API, or
> install Claude Code so the `claude` CLI is on PATH..."

**Trigger scenario:** a user opens a GitHub Copilot session, points it at the prlore
repo, and asks it to install and run prlore against some repo. Copilot runs
`npx prlore mine ...` as a subprocess. That subprocess has no `ANTHROPIC_API_KEY` and
no `claude` on PATH, so `selectProvider` throws the message above. A subprocess can't
borrow Copilot's chat model, so prlore is unusable in that environment.

The credential that *is* present in Copilot / Codespaces / Actions environments is a
**GitHub token** (`GITHUB_TOKEN` / `GH_TOKEN`), which grants access to **GitHub Models**,
an OpenAI-compatible inference endpoint. That is the seam to exploit.

## Goals

1. prlore runs in a GitHub Copilot / Codespaces / Actions environment with zero extra
   configuration (auto-detect the GitHub token → GitHub Models).
2. The same code path unlocks **Ollama** (local, free, no rate limits) — the only option
   that can realistically finish a large mine — and any other OpenAI-compatible endpoint.
3. No regression to the existing `anthropic` / `claude-cli` / `auto` behavior.

## Non-goals

- Native structured-output (`response_format` / json_schema). v1 reuses the existing
  prompt-based schema-hint approach for one uniform code path across all endpoints.
- A per-model price table for arbitrary OpenAI-compatible models. Unknown-price
  providers book `$0` and disable the budget cap (see Cost tracking).
- Implementing the stubbed `sampling` MCP provider. Out of scope; it does not address
  the CLI-in-Copilot trigger scenario.

## The rate-limit reality (must be surfaced, not hidden)

GitHub Models free tier is severely rate-limited relative to prlore's workload:

- prlore does **one model call per PR** (map-reduce over up to `maxPrs` = 1500 PRs).
- GitHub Models free tier caps (verified 2026-07-07, docs.github.com/rest/models/inference
  and community discussions): e.g. GPT-4o ≈ 10 req/min, **50 req/day**; gpt-4o-mini
  ≈ 150 req/day. Limits are per-model-per-user-per-day and models differ.

So adding the provider **makes the error go away** but the free tier realistically only
finishes a *small* mine (a few dozen PRs) before the daily quota 429s it out. This is
documented in the README and enforced with an actionable error on quota exhaustion.
Ollama (or a paid endpoint / Anthropic key) is the path for a real mine.

## Approach

A single generic OpenAI-compatible provider, parameterized by base URL + optional key +
model, with three named presets that construct it. Chosen over a narrow GitHub-Models-only
provider because the same code gives Ollama for free, and Ollama is the only option that
sidesteps the rate-limit wall for a full mine.

### New module: `src/model/openai-compatible.ts`

`OpenAICompatibleProvider implements ModelProvider` (the existing interface:
`complete<T>()` + `spentUsd()`), modeled directly on `AnthropicProvider`.

```
interface OpenAICompatibleOpts {
  baseUrl: string;          // e.g. "https://models.github.ai/inference"
  apiKey?: string;          // omitted for Ollama
  model: string;            // no price gate; arbitrary model names allowed
  maxBudgetUsd: number;
  pricePerMTok?: { input: number; output: number }; // when known; else $0 booking
  onWarn?: (msg: string) => void;
  maxRateLimitRetries?: number; // default e.g. 4
}
```

- Injectable transport seam: constructor takes an optional `fetchFn` (defaults to the
  global `fetch`), exactly like `AnthropicProvider` injects `client` and
  `ClaudeCliProvider` injects `runCli`. Tests never touch the network.
- `complete<T>({ system, prompt, schema, maxTokens = 4096 })`:
  - **Reuses `appendSchemaHint` + `extractJson` + the 2-attempt schema-validation retry
    verbatim** from the Anthropic path. No `response_format` special-casing.
  - Builds `messages`: a `system` message when `system` is set, then the `user` message
    carrying the schema-hinted prompt.
  - POSTs `${baseUrl}/chat/completions` with body
    `{ model, max_tokens: maxTokens, messages }`, headers
    `Content-Type: application/json` and (only when `apiKey` present)
    `Authorization: Bearer ${apiKey}`.
  - Parses `choices[0].message.content` for the reply text; feeds it through
    `extractJson` → `JSON.parse` → `schema.parse`, same as Anthropic.
  - Tracks tokens from `usage.prompt_tokens` / `usage.completion_tokens` (tolerate a
    missing `usage`, book nothing and continue — do not throw).

### Rate-limit handling (new behavior)

Wrap each HTTP call in a bounded 429 retry loop that sits *outside* the 2-attempt
schema-validation loop:

- On HTTP 429: read `Retry-After` (seconds) or `x-ratelimit-reset` if present; sleep that
  long (capped), then retry, up to `maxRateLimitRetries`.
- On exhausting the retries (daily quota hit): throw a clear, actionable error:
  > "GitHub Models rate limit / daily quota exhausted. Use `--provider ollama` for a
  > local unlimited run, or set `ANTHROPIC_API_KEY` for a full mine."
- Non-2xx that is not 429: throw with status + a short body excerpt (like `claude-cli`'s
  stderr excerpt).

### Cost tracking / budget

- When `pricePerMTok` is known, book `(inTok*input + outTok*output)/1e6` into `spent`
  and honor `maxBudgetUsd` via `BudgetExceededError`, identical to Anthropic.
- When `pricePerMTok` is unknown (GitHub Models free tier, Ollama, arbitrary endpoints):
  book `$0`, and emit a one-time `onWarn`:
  > "cost tracking unavailable for this provider; --max-budget will not gate it."
  `maxBudgetUsd` still flows through harmlessly (never trips at $0 spend).

### Presets — `select-provider.ts`

Three new provider values, all constructing `OpenAICompatibleProvider`:

| Provider        | baseUrl                                   | key (env)                         | default model        | price |
|-----------------|-------------------------------------------|-----------------------------------|----------------------|-------|
| `github-models` | `https://models.github.ai/inference`      | `GITHUB_TOKEN` \|\| `GH_TOKEN` (required) | `openai/gpt-4o-mini` | unknown → $0 |
| `ollama`        | `OLLAMA_BASE_URL` \|\| `http://localhost:11434/v1` | none                       | `qwen2.5:7b`         | unknown → $0 |
| `openai`        | `--base-url` \|\| `OPENAI_BASE_URL` (required) | `OPENAI_API_KEY` (required) | from `--model` (required) | unknown → $0 |

- `github-models` throws a clear error if neither `GITHUB_TOKEN` nor `GH_TOKEN` is set.
- `openai` throws a clear error if base URL or model is missing.
- Default GitHub Models model is `gpt-4o-mini` (150 req/day) rather than `gpt-4o`
  (50 req/day) to maximize how much of a mine completes on the free tier; overridable
  with `--model`.

### `auto` fallback (extended)

Resolution order, first available wins:

1. `ANTHROPIC_API_KEY` present → `anthropic` (unchanged; preserves every prior config).
2. `claude` CLI on PATH → `claude-cli` (unchanged).
3. **`GITHUB_TOKEN` / `GH_TOKEN` present → `github-models`** (new; token-gated).
4. else → error, updated to mention `--provider github-models` and `--provider ollama`.

GitHub Models is token-gated at step 3 so it only engages when both Claude paths are
absent — precisely the Copilot/Codespaces case, where `npx prlore mine` then works with
zero flags. Ollama is **not** in `auto` (a running localhost daemon is not a signal of
user intent); it requires explicit `--provider ollama`.

### Config schema + CLI

- `src/schemas/mine-config.ts`: extend the `model.provider` enum to
  `["anthropic", "claude-cli", "sampling", "auto", "github-models", "ollama", "openai"]`.
  Add optional `model.baseUrl: z.string().url().optional()`.
- `src/cli.ts`: extend `PROVIDER_VALUES`; add `--base-url <url>`; update the `--provider`
  help line to list the new values; thread `baseUrl` into the config.

## Testing

Unit tests with an injected fake `fetchFn` (no network), mirroring the existing provider
test style:

- happy path (valid JSON first try);
- malformed JSON on attempt 1, valid on attempt 2 (schema-retry);
- schema-invalid twice → throws the "failed schema validation twice" error;
- 429 then 200 (rate-limit retry succeeds);
- 429 until retries exhausted → actionable rate-limit error;
- missing `usage` in the response → no throw, $0 booked;
- non-429 non-2xx → throws with status + excerpt;
- `Authorization` header present with key, absent for Ollama (no key).

`selectProvider` tests:

- each preset constructs the right base URL / key / default model;
- `github-models` / `openai` missing-credential errors;
- `auto` ordering: anthropic key wins; then claude CLI; then GitHub token →
  github-models; then error mentioning the new providers;
- `auto` does **not** pick Ollama.

Full suite (`npm test`) + `tsc --noEmit` must stay green.

## Docs

- README: provider table row for each new provider; a "Running prlore inside GitHub
  Copilot / Codespaces" section that states the free-tier limit honestly (small
  `--days` / `--max-prs` only; Ollama or an Anthropic key for real mines).
- New `decisions/009-openai-compatible-provider.md` (accepted), refining ADR 006.

## Rollout

Minor version bump (additive, no breaking change to existing providers or configs).
Publish per the usual release flow once merged.

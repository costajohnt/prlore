# 009. OpenAI-compatible model provider + presets

- Status: accepted
- Date: 2026-07-07
- Refines: 006 (BYO-key model provider)

## Context

prlore only supported Anthropic (`ANTHROPIC_API_KEY`) and the local `claude` CLI.
When a user runs `npx prlore mine` inside a GitHub Copilot / Codespaces / Actions
environment, neither credential exists, so `selectProvider` throws and prlore is
unusable there. The credential that is present in those environments is a GitHub
token, which grants access to GitHub Models, an OpenAI-compatible inference
endpoint.

## Decision

Add a single generic `OpenAICompatibleProvider` (reusing the existing prompt-based
schema-hint + JSON-extract + 2-attempt retry path) and expose it through three
presets:

- `github-models`: `https://models.github.ai/inference`, auth from
  `GITHUB_TOKEN`/`GH_TOKEN`, default model `openai/gpt-4o-mini`.
- `ollama`: `http://localhost:11434/v1` (or `OLLAMA_BASE_URL`), no key, default
  model `qwen2.5:7b`.
- `openai`: generic, `--base-url`/`OPENAI_BASE_URL` + `OPENAI_API_KEY` +
  `--model`.

`auto` falls back to `github-models` when a GitHub token is present, ranked below
both Claude paths (anthropic, then claude-cli, then github-models, then error).
Ollama is never auto-selected; it requires an explicit `--provider ollama`. Cost
tracking is disabled for these providers (they book $0; `--max-budget` does not
gate them). On HTTP 429 the provider retries with `Retry-After` backoff and, on
quota exhaustion, throws an actionable error steering to Ollama or an Anthropic
key.

## Consequences

- prlore runs in Copilot/Codespaces with zero flags.
- The GitHub Models free tier (roughly 50-150 requests/day, depending on model)
  realistically only completes a small mine; Ollama or a paid/Anthropic path is
  required for a full mine. This is documented, not hidden.
- Structured output stays prompt-based (no `response_format`), so one code path
  covers every endpoint; native structured output is a possible later
  optimization.

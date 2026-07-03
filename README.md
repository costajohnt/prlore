# prlore

Mines a repository's pull-request discussion history, reconciles it against the
current codebase, and emits a portable AGENTS.md-style conventions file with a
provenance sidecar. Standalone MCP server.

## Usage

prlore is an MCP server, not a CLI you run directly. Point an MCP host (Claude
Code, Claude Desktop, or any other MCP client) at it:

```json
{
  "mcpServers": {
    "prlore": {
      "command": "npx",
      "args": ["-y", "prlore"],
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

prlore always operates against a **local checkout** of the target repo — it
runs `git grep`/`git log` against `repoPath` to corroborate what the PR
discussion says against what the code actually does. Point `repoPath` at a
clone, not a bare `owner/name` reference.

### Environment variables

- `GITHUB_TOKEN` — a GitHub token with read access to the target repo. If
  unset, prlore falls back to `gh auth token` (requires the `gh` CLI to be
  authenticated).
- `ANTHROPIC_API_KEY` — used by the default Anthropic model provider (the
  `@anthropic-ai/sdk` client reads this directly; no prlore-specific wiring
  needed).

### The five tools + the interview prompt

| Tool | Purpose |
|---|---|
| `mine` | Starts (or resumes) a mining job. Only required inputs are `repo` (`owner/name`) and `intent` (free text describing what the doc is for) — everything else defaults. Rejects while a job is already running. |
| `status` | Reports job state, stage, progress counters, and spend so far. Poll it after `mine`. |
| `cancel` | Requests a graceful stop; the job checkpoints at the next stage boundary so a later `mine` call resumes instead of restarting. |
| `preview` | Once a job reaches `ready-for-preview`, returns the rendered markdown, any contested rules, summary stats, and a one-time `confirmToken`. |
| `write` | Writes the previewed draft to disk. Requires the `confirmToken` from the immediately preceding `preview` call — prlore never writes without one. Accepts `resolveContested` to keep or drop specific contested rules. |

The `interview` MCP prompt is a conversational script for gathering `mine`
inputs (repo, intent, focus areas, output preferences) instead of asking the
user to fill in a `MineConfig` by hand. It's optional — `mine({ repo, intent })`
works cold.

### Budget and model notes

`mine`'s `model` config controls spend:

- `model.model` — which Anthropic model to use (defaults to prlore's built-in
  default; see `src/model/anthropic.ts` for the current price table).
- `model.maxBudgetUsd` — a hard USD cap across the whole run (default `10`).
  Once tripped during extraction, the run degrades to a partial-corpus draft
  with a warning; once tripped during synthesis (the highest-value calls), the
  job fails outright rather than emitting a truncated conventions doc.

`model.provider` also accepts `"sampling"` in the config schema (MCP sampling
as a fallback when no API key is configured), but that path isn't wired yet.
`mine` rejects `provider: "sampling"` with a tool error rather than silently
running the Anthropic provider in its place — use `"anthropic"` (the default)
until sampling support ships.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck  # tsc --noEmit
npm run build      # tsc
```

No live network or LLM calls happen in the test suite — GitHub's GraphQL API
and the model provider are faked throughout, including in the end-to-end test
(`test/e2e.test.ts`), which runs the real mining pipeline against a
script-built fixture git repo.

## Limits (v1)

- **Local checkout required.** prlore reconciles PR discussion against the
  current codebase by running real `git` commands against `repoPath`; it does
  not fetch or shallow-clone the repo itself.
- **Managed-block emission only.** prlore writes into a fenced
  `<!-- prlore:begin -->` / `<!-- prlore:end -->` block (or a fresh file if the
  target doesn't exist). It refuses to touch a target file that has no valid
  marker pair rather than attempting a free-form merge into hand-written
  prose.
- **No incremental UI.** There's no diff view, no partial-accept-per-rule flow
  beyond the contested-item keep/drop list `write` accepts. Re-running `mine`
  re-synthesizes over the (cached) extraction corpus.
- **Contested rules are never auto-written.** When PR discussion and code
  trend disagree, or two candidate rules directly conflict, the rule lands in
  `contested`, not in the emitted draft — it only appears in the written file
  if the caller explicitly resolves it with `resolveContested: [{ id, action:
  "keep" }]` on `write`.
- Single repo per run; no GitLab/Bitbucket support; no continuous ingestion or
  webhooks — this is a batch tool you re-run, not a review bot or an
  enforcement tool.

# prlore

Mines a repository's pull-request discussion history, reconciles it against the
current codebase, and emits a portable AGENTS.md-style conventions file with a
provenance sidecar. Runs either as an MCP server or as a standalone terminal
command.

## Usage

prlore has two entry points from the same installed binary: `prlore` with no
arguments runs the MCP server; `prlore mine <owner/repo>` runs the full
pipeline directly in a terminal, with an interactive preview-and-confirm step
before anything is written.

Either way, prlore always operates against a **local checkout** of the target
repo — it runs `git grep`/`git log` against `repoPath` to corroborate what the
PR discussion says against what the code actually does. Point `repoPath` (or,
for the CLI, `--repo-path`) at a clone, not a bare `owner/name` reference.

### As a terminal command

```bash
npx prlore mine octo/repo --intent "onboard an AI coding agent"
```

This runs the mining pipeline in-process: it starts the job, polls progress to
stderr every 5 seconds, then once the draft is ready prints it to stdout along
with any contested rules (listed on stderr — v1's CLI never auto-resolves
them; use the MCP `write` tool's `resolveContested`, or edit the file by hand,
to keep one). It then asks before touching disk: `Write AGENTS.md? [y/N]` when
it will write the target directly, or `Write .prlore/AGENTS.md and add a pointer
block to AGENTS.md? [y/N]` when an existing hand-authored AGENTS.md means it
adopts pointer mode instead (see "Adaptive pointer mode" below).

```
usage: prlore mine <owner/repo> [options]

  --intent <text>           what the resulting doc should help with
  --since <ISO-datetime>     only PRs updated at/after this timestamp
  --days <n>                 only PRs updated in the last <n> days
                             (--since and --days are mutually exclusive)
  --author <login>           only mine PRs authored by this login
                             (case-insensitive; repeat --author for multiple
                             logins). When set and --intent is not given, the
                             default intent switches to documenting the
                             review feedback these authors received.
  --budget <usd>             max USD to spend on model calls (default: 10)
  --model <id>                model id override
  --provider <anthropic|claude-cli|auto>
                             which model backend to use (default: auto)
  --repo-path <path>         local checkout to mine against (default: cwd)
  --target <file>            output file (default: AGENTS.md)
  --max-rules <n>             cap on rules rendered in full detail; the rest
                             render as compact one-liners in a trailing
                             section (default: 60; must be a positive
                             integer — pass a large number for "no cap")
  --yes                       skip the write confirmation prompt
  --dry-run                   preview only; never writes, even with --yes
```

Exit codes: `0` on success (including a confirmed-no / `--dry-run` "not
written" outcome), `1` if the mining job itself failed or the write was
refused (a target file whose managed block is damaged: a corrupt/reversed
marker pair, or a lone stray marker. An existing file with no prlore markers is
not a refusal; it adopts pointer mode, see "Adaptive pointer mode" below), `2`
for a usage or configuration error (bad flags, invalid `MineConfig`, no model
provider available).

The CLI draws model calls from whichever provider `--provider`/`model.model`
resolves to (see "Budget and model notes" below) — with `--provider
claude-cli` or the `auto` fallback, that's your local Claude Code CLI running
headless against your subscription, so `prlore mine` works with **zero API
credentials** on a machine that already has `claude` authenticated.

### Mining your own PRs

If you're an outside contributor rather than a maintainer, `--author` narrows
mining down to PRs you authored, so the resulting doc becomes a record of the
review feedback you've gotten and the standing lessons from it, rather than a
general conventions guide. Authority weighting already does the rest here —
maintainer comments on your own PRs already drive rule scoring, so no scoring
changes are needed for this to work; `--author` is purely a client-side filter
over which PRs get mined at all (GitHub's GraphQL API has no server-side
author filter on the `pullRequests` connection, so every PR is still fetched
and paid for at the same rate cost — only the *kept*, and therefore
model-processed, set gets smaller).

```bash
prlore mine owner/repo --author yourlogin --days 730
```

`--author` is repeatable (`--author alice --author bob`) and matches
case-insensitively. When `--author` is given and `--intent` isn't, the
default intent switches from the general onboarding phrasing to documenting
the review feedback these authors received.

### Adaptive pointer mode

prlore never rewrites hand-authored prose. How it writes the mined conventions
depends on the target file's existing state, chosen automatically from what's on
disk (there is no flag):

- **Direct mode** (target absent, or already prlore-managed with a valid marker
  pair). The full mined doc goes straight into `AGENTS.md`, inside a
  `<!-- prlore:begin -->` / `<!-- prlore:end -->` block. Bytes outside that block
  are preserved exactly. This is the original behavior and is unchanged.
- **Pointer mode** (an existing `AGENTS.md` that prlore doesn't manage, i.e. one
  with no prlore markers). The full mined doc lands in a separate, prlore-owned
  file, `.prlore/AGENTS.md`, and your existing `AGENTS.md` is only ever appended
  to with a small managed pointer block (markers plus a one-line "the mined
  conventions live in .prlore/AGENTS.md, read that first" note). The prose you
  wrote above that block stays byte-for-byte identical, and re-running `mine`
  replaces just the pointer block in place. prlore also enters pointer mode
  whenever `.prlore/AGENTS.md` already exists, so once a repo adopts it the
  layout stays put.

With a non-default `--target`, the same rule applies with that filename
substituted throughout (`.prlore/<target>`, and the pointer references
`.prlore/<target>`).

Pointer mode is exactly the case that used to refuse. An existing unmarked
`AGENTS.md` is now adopted, not rejected (see the exit-code note above for what
still refuses).

### As an MCP server

Point an MCP host (Claude Code, Claude Desktop, or any other MCP client) at
it:

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

### Environment variables

- `GITHUB_TOKEN` — a GitHub token with read access to the target repo. If
  unset, prlore falls back to `gh auth token` (requires the `gh` CLI to be
  authenticated).
- `ANTHROPIC_API_KEY` — used by the Anthropic model provider (the
  `@anthropic-ai/sdk` client reads this directly; no prlore-specific wiring
  needed). This remains the documented default for CI and servers, where
  there's no interactive Claude Code session to draw on.

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

`model.provider` selects which model backend runs the mining calls:

- `"auto"` (the default) — uses the Anthropic API if `ANTHROPIC_API_KEY` is
  set; otherwise falls back to the local `claude` CLI if it's on PATH; errors
  naming both remedies if neither is available.
- `"anthropic"` — always uses the Anthropic API. Requires
  `ANTHROPIC_API_KEY`; fails immediately with a clear error if it's unset
  (rather than failing deep inside the pipeline on the first call).
- `"claude-cli"` — always uses your locally installed, already-authenticated
  Claude Code CLI in headless mode. No API key needed, but usage draws on
  your Claude subscription's usage limits, not billed API credits. Its
  default model is whatever the `claude` CLI itself defaults to (prlore
  doesn't override it unless `model.model` is set); the Anthropic provider's
  default is `claude-sonnet-5` (see `src/model/anthropic.ts` for the current
  price table).
- `"sampling"` also exists in the config schema (MCP sampling as a fallback
  when no API key is configured), but that path isn't wired yet. `mine`
  rejects `provider: "sampling"` with a tool error rather than silently
  running another provider in its place.

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
  target doesn't exist). It never merges into hand-written prose: an existing
  unmarked `AGENTS.md` is adopted via pointer mode (the mined doc goes to
  `.prlore/AGENTS.md` and only a small pointer block is appended to the human
  file, see "Adaptive pointer mode"), and a target whose managed block is
  damaged (a corrupt/reversed pair or a lone stray marker) is refused rather
  than guessed at.
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
- **Recurrence floor (always on, not configurable).** A non-contested rule
  backed by fewer than 2 distinct PRs, with no maintainer-tier (owner/member/
  collaborator) evidence, is demoted to `provenance.dropped` with
  `droppedReason: "recurrence-floor"` even if it would otherwise clear the
  score threshold — this filters out single-PR trivia (a one-off nit that
  happened to get said with confidence) without needing a config knob.
  Synthetic code-only rules (derived purely from codebase patterns, with no
  PR evidence) are exempt. Nothing is silently discarded: floored rules stay
  in the provenance sidecar with their reason, just not in the rendered doc.
- **Auto layout also triggers on draft size in bytes, not just line count.**
  `layout: "auto"` switches from a single file to per-area files once the
  draft exceeds 400 lines OR 24,000 bytes (~6k tokens), whichever trips
  first — a handful of very long rule lines can blow past a reasonable doc
  size while staying under the line-count check alone.
- **Tiered rendering caps how many rules get full treatment.** Only the top
  `output.maxRules` (default 60, by score — rules already arrive score-sorted)
  render in full inside their planned sections. Anything beyond the cap still
  ships, just compressed: one line each (`- statement _(citations)_`, no
  rationale) in a single trailing `## Additional conventions (lower signal)`
  section, before the contested section. Nothing is dropped from the doc by
  this — `provenance.rules` still carries full records for every rule,
  tagged with `renderedTier: "full" | "compact"`. Set `--max-rules` (CLI) or
  `output.maxRules` (MCP config) to change the cutoff; it must be a positive
  integer, so "no cap" means passing a large number, not `0`.

# Incremental re-mine design (2026-11-08)

## Problem

The v1 design spec deferred "incremental re-run via `updatedAt` watermark" and only recorded the watermark (`checkpoint.maxUpdatedAt`). In practice that meant a re-run with the same flags matched the config hash, found the checkpoint past `fetching`, skipped the fetch loop, and re-synthesized the first run's corpus forever (deep audit 2026-11-07, H1). Nothing told the user the PR evidence was frozen.

## Decision

Re-running `mine` with the same config is the refresh path.

1. **Incremental pass.** When `fetchCorpus` loads a matching checkpoint whose stage is past `fetching`, it flips it back to `fetching` with `cursor: null`, `counters: {}`, and `refreshFrom: maxUpdatedAt`, then pages newest-first and stops at the first PR with `updatedAt < refreshFrom` (or older than `since`). PRs at the watermark's exact second are re-read, and any row identical (`number|updatedAt`) to one already in the corpus is skipped as unchanged. `refreshFrom` is stored separately because the pass raises `maxUpdatedAt` as it goes; a crash mid-pass resumes from the cursor and still stops at the right watermark. Only page rows raise `maxUpdatedAt`: an overflow refetch can return an `updatedAt` later than the first page, and raising the watermark to it would hide PRs updated in between.
2. **Merge.** New and changed PRs are appended to `corpus.jsonl`; `readCorpus` already dedups by PR number, last write wins. The extraction cache is keyed on `updatedAt`, so only new or changed PRs cost tokens. Synthesis always re-runs.
3. **Window.** The corpus accumulates, so `windowCorpus` re-applies the run's window before extraction and synthesis: rows older than `since` drop out (so `--days N` slides) and only the newest `maxPrs` are used. `maxPrs` also caps each pass's fetch.
4. **Freshness.** `CorpusInfo { prs, newestUpdatedAt, addedThisRun }` (`addedThisRun` counts windowed rows newer than `checkpoint.synthesizedThrough`, the newest PR the last finished synthesis used, so a run that crashed after fetching still reports those PRs on the re-run) is recorded in `provenance.corpus` (additive, optional), returned in MCP `status` and `preview`, and printed by the CLI. A refresh that adds nothing emits a `corpus unchanged` warning.
5. **Full refetch.** Deleting `.prlore/checkpoint.json` triggers the existing config-hash reset (corpus moved to `superseded/`, extraction cache kept). No new flag.

## Not done

A `--refetch` flag; pruning out-of-window rows from `corpus.jsonl` on disk (they are filtered at read time).

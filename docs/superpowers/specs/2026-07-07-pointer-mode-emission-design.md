# Pointer-mode emission design (2026-07-07)

## Problem

`emitDraft` today has two outcomes for the root target file (default `AGENTS.md`):

- **File absent** → fresh-wrap the full draft in a managed block and write it.
- **File present with a valid `<!-- prlore:begin -->` … `<!-- prlore:end -->` pair** → replace only the block, preserving bytes outside it (ADR 004).
- **File present, no marker pair** → `EmitRefusedError`. Nothing is written.

That third branch is the failure case in practice. Many target repos already ship a hand-authored `AGENTS.md` with no prlore markers. Running `prlore mine` against them refuses outright, and the only escape today is `--target` at a different file (losing the harness-auto-loaded filename) or hand-editing markers into human prose.

We want prlore to be usable on a repo that already has an `AGENTS.md` without ever rewriting that human-authored prose. The mined conventions go into a file prlore fully owns, and the existing `AGENTS.md` gets only a tiny pointer telling the agent to read that file.

## Decisions (approved 2026-07-07)

1. **Pointer target: `Auto-insert small pointer block.`** When an unmarked `AGENTS.md` exists, prlore appends a small managed block (markers + a one-line "read this other file" pointer) to the end of it. The full mined content goes to a separate prlore-owned file. This is the one and only automated edit to a human-authored file, and it is idempotent on re-run.

2. **When active: `Adaptive.`** Behavior is chosen from durable filesystem state, not a flag:
   - No `AGENTS.md`, or one already fully prlore-managed → **direct mode** (today's behavior, unchanged).
   - Unmarked human `AGENTS.md` exists → **pointer mode**.

   Zero behavior change for repos where prlore already works; the change fixes exactly the branch that refuses today.

3. **File location: `.prlore/AGENTS.md`.** prlore already owns a checked-in `.prlore/` directory (the provenance sidecar, ADR 005). The full mined doc, and any per-area files, live under `.prlore/`, so prlore fully owns that directory and the *only* thing that ever touches a shared/human file is the tiny pointer block. Root stays clean; the explicit relative path in the pointer means agents still resolve it.

## Mode resolution

`emitDraft` picks a mode by checking, in this exact order:

1. `.prlore/<target>` **exists** → **pointer mode** (the repo has already adopted it). Update the managed block in `.prlore/<target>`; verify/repair the pointer block in the root `<target>`.
2. Root `<target>` **does not exist** → **direct mode**, today's fresh-wrap. (Greenfield repo: no reason to add indirection.)
3. Root `<target>` **exists with a valid marker pair** → **direct mode**, today's in-place block replacement. (Backward compatible with every repo prlore has already managed.)
4. Root `<target>` **exists with neither marker present** → **pointer mode, first adoption**. Write the full doc to `.prlore/<target>` (fresh-wrapped with markers) and append the pointer block to the existing root `<target>`.

**"Neither marker" is stricter than `checkMarkers`'s "missing pair".** `checkMarkers` reports the same "missing prlore:begin/end marker pair" reason for a file with *zero* markers and for one carrying a single stray marker (a lone `BEGIN` with no `END`, or vice versa). Only the zero-marker case is safe to adopt: appending a full pointer block to a file that already has a lone `BEGIN` yields two `BEGIN`s and one `END`, which the next run correctly refuses as corrupt — a confusing self-inflicted dead end. So rule 4 must check that the root file contains **neither** `BEGIN` **nor** `END` before adopting; a file with exactly one of them falls through to **refuse** (a damaged/partial managed file we must not guess at), same as the corrupt-pair case below.

**Order matters — rule 1 is checked first and makes the layout sticky.** Once a repo is in pointer mode, its root `AGENTS.md` now contains a valid marker pair (the pointer block's). Without the `.prlore/<target>`-first check, a later run would match rule 3 and replace that pointer block with the full 30 KB draft — silently converting the repo back to direct mode and stomping the human file. Deriving the mode from durable filesystem state rather than a CLI flag also keeps the MCP server and CLI from drifting apart: both call the same `emitDraft`, so both resolve identically.

## The pointer block

Appended to the end of the existing root `<target>` (shown for `target = AGENTS.md`):

```markdown
<!-- prlore:begin -->
## Mined PR-review conventions
Conventions mined from this repo's PR history live in [.prlore/AGENTS.md](.prlore/AGENTS.md). Read that file before working here.
<!-- prlore:end -->
```

- On first adoption (rule 4) the block is appended after the existing content, separated by a blank line. Everything above it is byte-identical to what the human wrote.
- On re-run (rule 1) the block is replaced in place via the existing marker-replacement path (`computeManagedContent`), so prose outside it stays byte-identical.
- The pointer text references `.prlore/<target>` with `<target>` interpolated, so a non-default `--target` name stays consistent between the pointer and the file it points at.

## Per-area layout in pointer mode

In pointer mode the per-area split stays entirely inside `.prlore/`:

- Root mined doc: `.prlore/<target>` (e.g. `.prlore/AGENTS.md`).
- Area files: `.prlore/areas/<area>.md`.
- The root mined doc's `## Areas` links point at `areas/<area>.md` (relative to `.prlore/`).
- Area stubs' "see the root doc" backlink points at `../<target>` — i.e. `.prlore/<target>`.

This removes the `<area>/AGENTS.md` writes from pointer mode, so the path-escape / clobber concerns that `isSafeAreaSegment` and `isInsideRepo` guard against one directory *down* cannot recur here — every write is a fixed relative path under `.prlore/`, not a model-derived directory name at repo root. (We keep both guards anyway; `<area>` is still model-derived text used as a filename.)

**Direct mode keeps today's per-area behavior unchanged:** root `<target>` plus `<area>/<target>` stubs, both guards active.

## What still refuses

Fail-closed is preserved. `EmitRefusedError` still fires for:

- A root `<target>` with a *corrupt* marker pair (duplicate begin, duplicate end, or reversed order) **or a lone marker** (exactly one of `BEGIN`/`END`). Both signal a prlore-managed file that got damaged, and we must not guess. Only the clean "neither marker present" case (rule 4) is reinterpreted as pointer-mode adoption.
- A `.prlore/<target>` that exists but is unmarked or has a corrupt pair. prlore owns that file; if it can't find its own clean block there, something is wrong and it refuses rather than overwrite.

All-or-nothing validation is preserved: every planned target (root pointer/doc + `.prlore/<target>` + area files + sidecar) is read and validated before any write happens; if any would refuse, nothing is written.

## Surfaces to change

- **`src/emitter/emit.ts`** — the core. Add mode resolution (the 4-rule order above), the pointer-block builder, and the `.prlore/`-rooted per-area planning for pointer mode. `EmitTarget` may gain a resolved-mode field internally, but the public contract (write the full thing, preserve human prose, all-or-nothing) is unchanged. `EmitResult.pathsWritten` now includes `.prlore/<target>` and the root pointer file in pointer mode.
- **`src/emitter/markers.ts`** — no new marker constants needed; the pointer block reuses `BEGIN`/`END`. `checkMarkers` already distinguishes "missing pair" from "duplicate/reversed", which is exactly the "no markers → adopt" vs "corrupt → refuse" split rule 4 needs. Confirm this distinction is surfaced (it returns a `reason` string; callers can branch on missing-vs-corrupt).
- **`src/server-tools.ts`** — `refusalPreflight` must stop predicting refusal for an unmarked root file (that case now adopts pointer mode). Rework it into a mode-preview: report which mode will run and which paths will be written, so the MCP `preview` output tells the user "will write `.prlore/AGENTS.md` and add a pointer to `AGENTS.md`" instead of "would refuse". Keep genuine-refusal prediction for corrupt markers.
- **`src/cli.ts`** — the confirm prompt should name what will actually be written. Instead of always `Write AGENTS.md?`, say e.g. `Write .prlore/AGENTS.md and add a pointer block to AGENTS.md? [y/N]` in pointer mode, `Write AGENTS.md? [y/N]` in direct mode. The post-write `wrote: <paths>` line already lists every path from `pathsWritten`, so it needs no change beyond the new paths flowing through.
- **`README.md`** — document adaptive pointer mode: what triggers it, where the full doc lands, that the human `AGENTS.md` is only ever appended to with a small block. Update the "refuses to write" language for the exit-code and behavior sections.
- **ADR 008 (`decisions/008-adaptive-pointer-mode.md`, in the vault)** — record this decision as a follow-on to ADR 004. ADR 004 said "refuse to touch existing files outside a managed block"; ADR 008 refines that: an *unmarked* file is adopted by appending a managed pointer block (still never rewriting prose outside a block), while corrupt-marker files still refuse. *Deferred from this spec pass because the vault has a concurrent live session; write it once that clears.*

## Testing

Golden-file / behavioral tests (the emitter is already golden-file testable per ADR 004):

- **Mode resolution matrix**, one test per rule: (1) `.prlore/AGENTS.md` present → pointer, sticky; (2) no root file → direct fresh-wrap; (3) marked root file → direct replace; (4) unmarked root file → pointer adoption.
- **Stickiness**: run pointer-mode adoption, then run again; assert the root `AGENTS.md` pointer block is replaced in place (not the full draft), human prose above it byte-identical, `.prlore/AGENTS.md` block updated.
- **Human-prose preservation**: unmarked `AGENTS.md` with arbitrary content → after adoption, everything above the appended block is byte-for-byte identical.
- **Corrupt-marker still refuses**: root file with duplicate/reversed markers → `EmitRefusedError`, nothing written; `.prlore/AGENTS.md` unmarked → `EmitRefusedError`, nothing written.
- **Per-area in pointer mode**: draft over the auto-layout threshold with real area directories → root doc + area files all land under `.prlore/`, links resolve, no `<area>/AGENTS.md` written at repo root.
- **Per-area in direct mode unchanged**: existing per-area golden tests still pass.
- **All-or-nothing**: a multi-file pointer-mode emission where one planned target would refuse → assert no file (including the sidecar) was touched.
- **CLI/MCP surface**: confirm prompt text and preview output reflect the resolved mode and the real path list.

## Non-goals

- Semantic merge into human prose (still explicitly out, per ADR 004).
- A user-facing flag to force a mode. Mode is derived from filesystem state; if a user truly wants the full content inline in a fresh file they still use `--target` at a new path (direct mode via rule 2).
- Migrating repos already in direct mode to pointer mode. If prlore already manages `AGENTS.md` in place (rule 3), it stays that way; no silent relocation.

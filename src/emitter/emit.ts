import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { BEGIN, checkMarkers, END, isMarkerIssue, sanitize } from "./markers.js";
import type { Provenance, RuleRecord } from "../schemas/provenance.js";
import { atomicWriteFile } from "../state/atomic.js";

// v1 auto-layout threshold (spec §Task 2): a draft over this many lines is
// treated as the per-area trigger. Accepted as-is for v1 — no smarter heuristic.
const AUTO_LAYOUT_LINE_THRESHOLD = 400;

// v0.3 Task 1: a draft over this many UTF-8 bytes (~6k tokens) also trips the
// per-area trigger, whichever of the two thresholds hits first. Line count alone
// is gameable: the ink acceptance run produced a 44KB single-file doc that
// stayed under 400 lines because its rules rendered as very long individual
// lines, dodging the line-count check entirely despite being far too large to
// read as one file.
const AUTO_LAYOUT_BYTE_THRESHOLD = 24_000;

export interface EmitTarget {
  repoPath: string;
  target: string; // e.g. "AGENTS.md"
  layout: "single" | "per-area" | "auto";
}

export interface EmitResult {
  pathsWritten: string[];
}

// Thrown whenever a target file exists but doesn't have exactly the shape
// ADR 004 requires (a single, correctly-ordered marker pair). The file named by
// `.path` is guaranteed untouched — this class is only ever thrown from the
// read-only validation pass, before any writes happen.
export class EmitRefusedError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`refusing to write ${path}: ${reason}`);
    this.name = "EmitRefusedError";
    this.path = path;
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// The block itself, with no trailing newline after END — callers decide what
// (if anything) follows: a fresh file appends its own final "\n" (nothing else
// will), a replacement lets the untouched suffix supply whatever originally
// followed the old END marker (so it isn't duplicated).
function coreBlock(body: string): string {
  const normalized = body.endsWith("\n") ? body : `${body}\n`;
  return `${BEGIN}\n${normalized}${END}`;
}

// Validates that `content` contains BOTH markers exactly once each, begin
// before end, and returns their positions. Throws EmitRefusedError (naming
// `path`) for anything else: missing either marker, either marker duplicated,
// or reversed order. Delegates the actual check to markers.ts's checkMarkers,
// shared with server-tools.ts's read-only refusalPreflight, which needs the
// identical validity rules but must turn a failure into a boolean instead of
// throwing.
function findMarkers(path: string, content: string): { beginIdx: number; endIdx: number } {
  const result = checkMarkers(content);
  if (isMarkerIssue(result)) throw new EmitRefusedError(path, result.reason);
  return result;
}

// Computes the FULL next-file-content for one managed-block target without
// writing anything: fresh wrap when the file doesn't exist, in-place block
// replacement (bytes outside the block preserved exactly) when it does.
async function computeManagedContent(path: string, body: string): Promise<string> {
  const existing = await readIfExists(path);
  if (existing === null) return `${coreBlock(body)}\n`; // fresh file: nothing else follows, so add the final newline ourselves
  const { beginIdx, endIdx } = findMarkers(path, existing);
  const prefix = existing.slice(0, beginIdx);
  const suffix = existing.slice(endIdx + END.length); // whatever followed the old END, preserved verbatim
  return `${prefix}${coreBlock(body)}${suffix}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

type EmitMode = "direct" | "pointer";

// Resolves the emission mode from durable filesystem state (spec §Mode
// resolution), checked in this exact order so the pointer layout stays sticky:
//   1. `.prlore/<target>` exists            → POINTER (repo already adopted it).
//   2. root `<target>` absent               → DIRECT  (greenfield fresh-wrap).
//   3. root `<target>` has a valid pair     → DIRECT  (in-place replace, ADR 004).
//   4. root `<target>` has NEITHER marker   → POINTER (first adoption).
// A root file with exactly one of BEGIN/END (a lone/stray marker) is a damaged
// managed file, NOT a clean human doc — it falls through to refuse, same as a
// corrupt pair. checkMarkers reports the same "missing pair" reason for zero
// markers and a lone marker, so the neither-marker test below is explicit and
// stricter than checkMarkers on its own (spec §Mode resolution).
async function resolveMode(rootPath: string, prloreTargetPath: string): Promise<EmitMode> {
  if (await pathExists(prloreTargetPath)) return "pointer"; // rule 1 (sticky)
  const rootContent = await readIfExists(rootPath);
  if (rootContent === null) return "direct"; // rule 2
  const markers = checkMarkers(rootContent);
  if (!isMarkerIssue(markers)) return "direct"; // rule 3: valid pair
  if (!rootContent.includes(BEGIN) && !rootContent.includes(END)) return "pointer"; // rule 4
  throw new EmitRefusedError(rootPath, markers.reason); // lone/corrupt marker → refuse
}

// The tiny managed block appended to (or replaced within) the human-authored
// root `<target>` in pointer mode. `<target>` is interpolated into both the
// link path and link text so a non-default --target stays self-consistent.
function pointerBlockBody(target: string): string {
  return (
    "## Mined PR-review conventions\n" +
    `Conventions mined from this repo's PR history live in [.prlore/${target}](.prlore/${target}). ` +
    "Read that file before working here."
  );
}

// Computes the next root `<target>` content for pointer mode without writing.
//   - file absent                → fresh-wrap the pointer block.
//   - file with NEITHER marker   → first adoption: append the pointer block after
//                                  the existing content, separated by a blank
//                                  line, human prose above kept byte-identical.
//   - file with a valid pair     → replace the block in place (stickiness on
//                                  re-run), prose outside it byte-identical.
//   - file with a lone/corrupt   → refuse (findMarkers throws): prlore's own
//                                  pointer file got damaged and we must not guess.
async function computePointerRootContent(rootPath: string, pointerBody: string): Promise<string> {
  const existing = await readIfExists(rootPath);
  if (existing === null) return `${coreBlock(pointerBody)}\n`;
  if (!existing.includes(BEGIN) && !existing.includes(END)) {
    if (existing.length === 0) return `${coreBlock(pointerBody)}\n`;
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${separator}${coreBlock(pointerBody)}\n`;
  }
  const { beginIdx, endIdx } = findMarkers(rootPath, existing); // throws on lone/corrupt
  const prefix = existing.slice(0, beginIdx);
  const suffix = existing.slice(endIdx + END.length);
  return `${prefix}${coreBlock(pointerBody)}${suffix}`;
}

// A rule's `scope` entries are untrusted, model-derived text — the first path
// segment becomes a directory name we join onto repoPath and write into.
// Without an allowlist, "." resolves (via existingDirs' stat) to repoPath
// itself, so its "area" stub write silently clobbers the freshly written root
// managed content; ".." resolves to repoPath's parent, so its stub write
// lands OUTSIDE repoPath entirely. Both are directories that legitimately
// exist, so existingDirs' bare stat-and-check can't catch them — only an
// allowlist on the segment's shape can. `\w.-` covers ordinary path-segment
// names (letters, digits, underscore, dot, hyphen) while still rejecting the
// exact "." / ".." tokens and anything carrying a "/" or other escape
// character. Tradeoff, accepted for v1: `\w` is ASCII-only, so a real
// directory named with non-ASCII characters (e.g. "résumé", "日本語") is
// never treated as an area — no stub gets written for it and the root's
// "## Areas" links silently omit it. Fail-closed rather than fail-open: an
// area that's dropped just doesn't get a stub, whereas loosening the
// allowlist to admit non-ASCII risks re-opening a path-escape character we
// haven't audited for.
function isSafeAreaSegment(segment: string): boolean {
  return segment !== "." && segment !== ".." && /^[\w.-]+$/.test(segment);
}

function areaFirstSegments(rules: RuleRecord[]): string[] {
  const segments = new Set<string>();
  for (const rule of rules) {
    for (const scope of rule.scope) {
      const first = scope.split("/")[0];
      if (first && isSafeAreaSegment(first)) segments.add(first);
    }
  }
  return [...segments];
}

// Belt-and-braces on top of isSafeAreaSegment: confirms the resolved stub
// path is a strict descendant of repoPath before anything is ever written
// there. Kept as a second, independent check (not a replacement for the
// allowlist) so a future change to the allowlist regex can't reopen the
// escape on its own.
function isInsideRepo(repoPath: string, candidatePath: string): boolean {
  const rel = relative(resolve(repoPath), resolve(candidatePath));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function existingDirs(repoPath: string, candidates: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const candidate of candidates) {
    try {
      const s = await stat(join(repoPath, candidate));
      if (s.isDirectory()) out.push(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue; // not present, or not a directory — not an area
      throw err; // anything else (EACCES, etc.) is a real failure, not "not an area"
    }
  }
  return out;
}

function withAreaLinks(draft: string, areas: string[], hrefFor: (area: string) => string): string {
  if (areas.length === 0) return draft;
  const links = areas.map((area) => `- [${area}](${hrefFor(area)})`);
  return `${draft.replace(/\n+$/, "")}\n\n## Areas\n${links.join("\n")}\n`;
}

function areaBullet(rule: RuleRecord): string {
  const statement = sanitize(rule.statement);
  if (rule.verdict === "trending-toward") return `- **[migration in progress]** ${statement}`;
  if (rule.verdict === "trending-away") return `- **[fading]** ${statement}`;
  return `- **${statement}**`;
}

function areaStubBody(area: string, target: string, rules: RuleRecord[]): string {
  const matching = rules.filter((r) => r.scope.some((s) => s.split("/")[0] === area));
  const lines = [
    `# Conventions for ${area}`,
    "",
    `See the root [${target}](../${target}) for full context.`,
    "",
    ...matching.map((r) => areaBullet(r)),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Writes the mined `draft` for `targetInfo.target`, choosing one of two modes
 * from durable filesystem state (spec §Mode resolution, resolveMode above):
 *
 * - DIRECT mode (today's behavior, unchanged): the full draft goes into the
 *   root `<target>` under a managed block (ADR 004: human prose outside the
 *   block is never touched); per-area layout writes `<area>/<target>` stubs.
 * - POINTER mode (unmarked human `<target>` exists, or the repo already
 *   adopted it): the full mined doc goes to `.prlore/<target>` and any per-area
 *   files to `.prlore/areas/<area>.md`; the root `<target>` receives only a
 *   tiny managed pointer block (appended on first adoption, replaced in place
 *   on re-run), so the human-authored prose is never rewritten.
 *
 * The provenance sidecar (ADR 005) is always written at
 * `<repoPath>/.prlore/provenance.json`.
 *
 * All planned targets (root pointer/doc + `.prlore/<target>` + area files) are
 * read and validated BEFORE any write happens. If any would refuse (a
 * missing/lone/duplicated/reversed marker on a file prlore expects to own),
 * emitDraft throws EmitRefusedError and NOTHING is written — not the other
 * targets, not the sidecar — keeping every emission all-or-nothing.
 */
export async function emitDraft(
  draft: string,
  provenance: Provenance,
  targetInfo: EmitTarget,
): Promise<EmitResult> {
  const { repoPath, target, layout } = targetInfo;
  const effectiveLayout: "single" | "per-area" =
    layout === "auto"
      ? draft.split("\n").length > AUTO_LAYOUT_LINE_THRESHOLD ||
        Buffer.byteLength(draft, "utf8") > AUTO_LAYOUT_BYTE_THRESHOLD
        ? "per-area"
        : "single"
      : layout;

  const rootPath = join(repoPath, target);
  const prloreTargetPath = join(repoPath, ".prlore", target);
  const sidecarPath = join(repoPath, ".prlore", "provenance.json");

  const mode = await resolveMode(rootPath, prloreTargetPath);

  // Second, independent gate (see isInsideRepo doc comment): drop — never
  // throw — any area whose resolved stub path would land outside repoPath. A
  // dropped area is excluded from BOTH the stub write and the root's "## Areas"
  // links, so the two never disagree about which areas exist.
  const resolveAreas = async (stubPathFor: (area: string) => string): Promise<string[]> => {
    const segments = areaFirstSegments(provenance.rules);
    const candidateAreas = await existingDirs(repoPath, segments);
    return candidateAreas.filter((area) => isInsideRepo(repoPath, stubPathFor(area)));
  };

  // Build the plan of managed-block targets for the resolved mode. Each entry's
  // content is computed lazily (read-only) and only written after every target
  // validates — see the doc comment above.
  const planned: { path: string; content: Promise<string> }[] = [];

  if (mode === "direct") {
    if (effectiveLayout === "single") {
      planned.push({ path: rootPath, content: computeManagedContent(rootPath, draft) });
    } else {
      const areas = await resolveAreas((area) => join(repoPath, area, target));
      planned.push({
        path: rootPath,
        content: computeManagedContent(rootPath, withAreaLinks(draft, areas, (area) => `${area}/${target}`)),
      });
      for (const area of areas) {
        const stubPath = join(repoPath, area, target);
        planned.push({ path: stubPath, content: computeManagedContent(stubPath, areaStubBody(area, target, provenance.rules)) });
      }
    }
  } else {
    // Pointer mode: root `<target>` gets only the pointer block; the full mined
    // doc and any per-area files live entirely under `.prlore/`.
    planned.push({ path: rootPath, content: computePointerRootContent(rootPath, pointerBlockBody(target)) });
    if (effectiveLayout === "single") {
      planned.push({ path: prloreTargetPath, content: computeManagedContent(prloreTargetPath, draft) });
    } else {
      const areaStubPath = (area: string) => join(repoPath, ".prlore", "areas", `${area}.md`);
      const areas = await resolveAreas(areaStubPath);
      // Root mined doc's "## Areas" links point at `areas/<area>.md` (relative
      // to `.prlore/`); each stub's backlink is `../<target>` == `.prlore/<target>`.
      planned.push({
        path: prloreTargetPath,
        content: computeManagedContent(prloreTargetPath, withAreaLinks(draft, areas, (area) => `areas/${area}.md`)),
      });
      for (const area of areas) {
        planned.push({
          path: areaStubPath(area),
          content: computeManagedContent(areaStubPath(area), areaStubBody(area, target, provenance.rules)),
        });
      }
    }
  }

  // Read + validate every target first (no writes yet); Promise.all rejects
  // before any write if any target refuses — see doc comment above.
  const resolved = await Promise.all(
    planned.map(async (p) => ({ path: p.path, content: await p.content })),
  );

  for (const r of resolved) {
    await atomicWriteFile(r.path, r.content);
  }
  await atomicWriteFile(sidecarPath, JSON.stringify(provenance, null, 2));

  return { pathsWritten: [...resolved.map((r) => r.path), sidecarPath] };
}

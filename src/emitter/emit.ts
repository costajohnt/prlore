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

function withAreaLinks(draft: string, areas: string[], target: string): string {
  if (areas.length === 0) return draft;
  const links = areas.map((area) => `- [${area}](${area}/${target})`);
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
 * Writes `draft` into `targetInfo.target` under a managed block (ADR 004: human
 * prose outside the block is never touched), plus the checked-in provenance
 * sidecar (ADR 005) at `<repoPath>/.prlore/provenance.json`.
 *
 * All target files (the root file, and per-area stub files in "per-area"
 * layout) are validated BEFORE any write happens. If any target would refuse
 * (missing/duplicated/reversed markers on an existing file), emitDraft throws
 * EmitRefusedError and NOTHING is written — not the other targets, not the
 * sidecar. This keeps a multi-file per-area emission all-or-nothing rather
 * than leaving some files written and others refused.
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

  const targetPath = join(repoPath, target);
  const sidecarPath = join(repoPath, ".prlore", "provenance.json");

  const planned: { path: string; body: string }[] =
    effectiveLayout === "single"
      ? [{ path: targetPath, body: draft }]
      : await (async () => {
          const segments = areaFirstSegments(provenance.rules);
          const candidateAreas = await existingDirs(repoPath, segments);
          // Second, independent gate (see isInsideRepo doc comment): drop —
          // never throw — any area whose resolved stub path would land
          // outside repoPath. A dropped area is excluded from BOTH the stub
          // write and the root's "## Areas" links, so the two never disagree
          // about which areas exist.
          const areas = candidateAreas.filter((area) => isInsideRepo(repoPath, join(repoPath, area, target)));
          return [
            { path: targetPath, body: withAreaLinks(draft, areas, target) },
            ...areas.map((area) => ({
              path: join(repoPath, area, target),
              body: areaStubBody(area, target, provenance.rules),
            })),
          ];
        })();

  // Read + validate every target first (no writes yet) — see doc comment above.
  const resolved = await Promise.all(
    planned.map(async (p) => ({ path: p.path, content: await computeManagedContent(p.path, p.body) })),
  );

  for (const r of resolved) {
    await atomicWriteFile(r.path, r.content);
  }
  await atomicWriteFile(sidecarPath, JSON.stringify(provenance, null, 2));

  return { pathsWritten: [...resolved.map((r) => r.path), sidecarPath] };
}

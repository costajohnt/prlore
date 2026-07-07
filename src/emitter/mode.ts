import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BEGIN, END, checkMarkers, isMarkerIssue } from "./markers.js";

// Shared, READ-ONLY mode preview. emit.ts's resolveMode picks the emission mode
// from durable filesystem state and THROWS EmitRefusedError on a damaged managed
// file; the CLI confirm prompt and the MCP `preview` tool need the SAME decision
// as a plain value (which mode, would it refuse, why) WITHOUT writing or throwing
// for an ordinary not-yet-managed file. Keeping this in one module means cli.ts
// and server-tools.ts can never disagree with each other about the resolved mode,
// and it mirrors emit.ts's resolveMode rule order exactly so the preview can't
// lie about what emitDraft will do.

export type EmitMode = "direct" | "pointer";

export interface EmitModePreview {
  mode: EmitMode;
  // Whether the root `<target>` file already exists.
  targetExists: boolean;
  // True when emitDraft would throw EmitRefusedError for this repo state.
  wouldRefuse: boolean;
  // The marker-issue reason behind a predicted refusal (undefined otherwise).
  reason?: string;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// A root file carries a "lone" or corrupt marker when checkMarkers reports an
// issue AND at least one of BEGIN/END is physically present — a damaged managed
// file emit.ts refuses to guess at, NOT clean human prose (which has neither).
function loneOrCorruptReason(content: string): string | null {
  const result = checkMarkers(content);
  if (!isMarkerIssue(result)) return null;
  if (content.includes(BEGIN) || content.includes(END)) return result.reason;
  return null; // neither marker present → clean human file, safe to adopt
}

// Mirrors emit.ts's resolveMode + its per-target refusal checks (spec §Mode
// resolution / §What still refuses), but read-only and boolean-returning.
export async function previewEmitMode(repoPath: string, target: string): Promise<EmitModePreview> {
  const rootPath = join(repoPath, target);
  const prloreTargetPath = join(repoPath, ".prlore", target);

  // Rule 1 (sticky): `.prlore/<target>` exists → pointer mode. prlore owns that
  // file, so an unmarked/corrupt block there refuses; the root pointer block is
  // replaced in place, so a lone/corrupt marker in the root refuses too.
  const prloreContent = await readIfExists(prloreTargetPath);
  if (prloreContent !== null) {
    const rootContent = await readIfExists(rootPath);
    const targetExists = rootContent !== null;
    const prloreCheck = checkMarkers(prloreContent);
    if (isMarkerIssue(prloreCheck)) {
      return { mode: "pointer", targetExists, wouldRefuse: true, reason: prloreCheck.reason };
    }
    const rootReason = rootContent !== null ? loneOrCorruptReason(rootContent) : null;
    if (rootReason !== null) {
      return { mode: "pointer", targetExists, wouldRefuse: true, reason: rootReason };
    }
    return { mode: "pointer", targetExists, wouldRefuse: false };
  }

  // Rule 2: no root file → direct fresh-wrap.
  const rootContent = await readIfExists(rootPath);
  if (rootContent === null) return { mode: "direct", targetExists: false, wouldRefuse: false };

  // Rule 3: valid marker pair → direct in-place replace (backward compatible).
  const markers = checkMarkers(rootContent);
  if (!isMarkerIssue(markers)) return { mode: "direct", targetExists: true, wouldRefuse: false };

  // Rule 4: NEITHER marker present → pointer adoption (append a pointer block).
  if (!rootContent.includes(BEGIN) && !rootContent.includes(END)) {
    return { mode: "pointer", targetExists: true, wouldRefuse: false };
  }

  // A lone/corrupt marker in the root (with no `.prlore/<target>` yet) is a
  // damaged managed file: emit.ts's resolveMode throws before choosing a mode.
  return { mode: "direct", targetExists: true, wouldRefuse: true, reason: markers.reason };
}

// The confirm-prompt question, phrased for the resolved mode. Pointer mode names
// BOTH the prlore-owned file it writes and the human file it appends a pointer
// to, so the user knows their hand-authored `<target>` is only ever appended to.
export function confirmWriteQuestion(mode: EmitMode, target: string): string {
  return mode === "pointer"
    ? `Write .prlore/${target} and add a pointer block to ${target}?`
    : `Write ${target}?`;
}

// A one-line, non-interrogative summary of what a write will do, for the MCP
// `preview` tool output (which is structured data, not a y/N prompt).
export function writePlanSummary(mode: EmitMode, target: string): string {
  return mode === "pointer"
    ? `will write .prlore/${target} and add a pointer block to ${target}`
    : `will write ${target}`;
}

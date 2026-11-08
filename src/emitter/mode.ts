import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BEGIN, END, checkMarkers, isMarkerIssue } from "./markers.js";

// Shared, READ-ONLY write preview. emitDraft always writes the mined doc to
// `.prlore/<target>` and only a pointer block to the root `<target>`, and it
// THROWS EmitRefusedError on a damaged managed file; the CLI confirm prompt and
// the MCP `preview` tool need the same decision as a plain value (would it
// refuse, why) WITHOUT writing or throwing. Keeping this in one module means
// cli.ts and server-tools.ts can never disagree, and it mirrors emit.ts's
// refusal checks so the preview can't lie about what emitDraft will do.

export interface WritePreview {
  // Whether the root `<target>` file already exists.
  targetExists: boolean;
  // True when emitDraft would throw EmitRefusedError for this repo state.
  wouldRefuse: boolean;
  // The marker-issue reason behind a predicted refusal (undefined otherwise).
  reason?: string;
  // The root `<target>` carries a valid prlore block but `.prlore/<target>`
  // doesn't exist yet: a repo from before pointer mode was the only mode, whose
  // root block held the full mined doc. The write replaces that block with the
  // pointer (prose outside the markers untouched) and the doc moves to
  // `.prlore/<target>`.
  migrating: boolean;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function previewWrite(repoPath: string, target: string): Promise<WritePreview> {
  const prloreContent = await readIfExists(join(repoPath, ".prlore", target));
  const rootContent = await readIfExists(join(repoPath, target));
  const targetExists = rootContent !== null;

  // prlore owns `.prlore/<target>`, so any marker issue there refuses.
  if (prloreContent !== null) {
    const check = checkMarkers(prloreContent);
    if (isMarkerIssue(check)) return { targetExists, wouldRefuse: true, reason: check.reason, migrating: false };
  }
  if (rootContent === null) return { targetExists, wouldRefuse: false, migrating: false };

  // Root with NEITHER marker is human prose: the pointer block is appended.
  // A valid pair is replaced in place. A lone/corrupt marker is a damaged
  // managed file emit.ts refuses to guess at.
  const rootCheck = checkMarkers(rootContent);
  if (isMarkerIssue(rootCheck)) {
    if (rootContent.includes(BEGIN) || rootContent.includes(END)) {
      return { targetExists, wouldRefuse: true, reason: rootCheck.reason, migrating: false };
    }
    return { targetExists, wouldRefuse: false, migrating: false };
  }
  return { targetExists, wouldRefuse: false, migrating: prloreContent === null };
}

// The confirm-prompt question. Names BOTH the prlore-owned file and the root
// file, so the user knows their hand-authored `<target>` only gets a pointer.
export function confirmWriteQuestion(preview: WritePreview, target: string): string {
  return preview.migrating
    ? `Write .prlore/${target} and replace prlore's block in ${target} with a pointer?`
    : `Write .prlore/${target} and add a pointer block to ${target}?`;
}

// A one-line, non-interrogative summary of what a write will do, for the MCP
// `preview` tool output (which is structured data, not a y/N prompt).
export function writePlanSummary(preview: WritePreview, target: string): string {
  return preview.migrating
    ? `will write .prlore/${target} and replace prlore's managed block in ${target} with a pointer block`
    : `will write .prlore/${target} and add a pointer block to ${target}`;
}

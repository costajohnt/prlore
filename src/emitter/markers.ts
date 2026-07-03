// Single source of truth for the ADR 004 managed-block markers and the
// untrusted-text sanitizer, both of which used to be copy-pasted across
// src/reconciler/render.ts, src/emitter/emit.ts, and src/server-tools.ts (the
// last of those also carried a THIRD, hand-rolled copy of the marker-validity
// checks in its read-only refusalPreflight). The duplication was a deliberate
// scoping precedent while those pieces were built in separate phases; now
// that the build is done, this is the one place all three depend on.

export const BEGIN = "<!-- prlore:begin -->";
export const END = "<!-- prlore:end -->";

export interface MarkerPositions {
  beginIdx: number;
  endIdx: number;
}

export interface MarkerIssue {
  reason: string;
}

// Checks that `content` contains BOTH markers exactly once each, with BEGIN
// before END. Returns their positions when valid, or a `reason` describing
// which invariant failed (missing pair / duplicate begin / duplicate end /
// reversed order) when not — callers decide how to surface that: emit.ts
// throws EmitRefusedError naming the path, server-tools.ts's read-only
// preview preflight turns it into a boolean and must never throw for an
// ordinary not-yet-managed file.
export function checkMarkers(content: string): MarkerPositions | MarkerIssue {
  const beginIdx = content.indexOf(BEGIN);
  const endIdx = content.indexOf(END);
  if (beginIdx === -1 || endIdx === -1) {
    return { reason: "missing prlore:begin/end marker pair" };
  }
  if (content.indexOf(BEGIN, beginIdx + BEGIN.length) !== -1) {
    return { reason: "duplicate prlore:begin marker" };
  }
  if (content.indexOf(END, endIdx + END.length) !== -1) {
    return { reason: "duplicate prlore:end marker" };
  }
  if (beginIdx > endIdx) {
    return { reason: "prlore:end marker appears before prlore:begin" };
  }
  return { beginIdx, endIdx };
}

export function isMarkerIssue(result: MarkerPositions | MarkerIssue): result is MarkerIssue {
  return "reason" in result;
}

// Every interpolated model-derived field that lands in generated markdown (a
// rule statement, rationale, section heading, contested statement/reason, an
// area stub bullet, ...) is untrusted text that could carry a newline-smuggled
// "## Injected heading" or an HTML comment that closes/reopens a structural
// marker like "<!-- prlore:end -->". Collapsing whitespace runs (including
// embedded newlines and the Unicode line separators JS `\s` covers) to a
// single space keeps everything on one rendered line — no new heading, no
// list-item break, no line-initial text a line-anchored consumer could mistake
// for a real structural line. Marker stripping runs to a FIXPOINT, not just
// one pass: a single pass is bypassable — "<<!--!-- prlore:end ---->>"
// reassembles to "<!-- prlore:end -->" once the inner markers are removed — so
// keep stripping until the string stops changing.
export function sanitize(s: string): string {
  let out = s.replace(/\s+/g, " ");
  let prev: string;
  do {
    prev = out;
    out = out.replaceAll("<!--", "").replaceAll("-->", "");
  } while (out !== prev);
  return out.trim();
}

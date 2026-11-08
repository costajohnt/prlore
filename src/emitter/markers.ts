import LinkifyIt from "linkify-it";
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
// for a real structural line. Escaping (below) also neutralizes any
// "<!-- prlore:end -->" in the text.
// Terminal control sequences (ESC/BEL/OSC hyperlinks, clipboard writes) and
// bidi overrides have no place in a convention; drop them from anything printed
// or written. Every whitespace run (CR, LF, U+2028/2029, ...) collapses to one
// space so the text can't start a new line in a terminal or a markdown block.
export function stripControls(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitize(s: string): string {
  return escapeMarkdown(stripControls(s));
}

// Rule text is model output derived from untrusted PR text (audit 2026-11-07
// H2), and the written file is read by coding agents and humans. Structural
// rule instead of chasing constructs one by one:
//   1. Every ASCII punctuation character is backslash-escaped. CommonMark
//      allows escaping all of them, and an escaped character never starts
//      or ends structure, so no emphasis, link, reference definition, image,
//      heading, list, quote, table, HTML, entity, or code span can form, at
//      line start or mid-line, in this field or across fields. Untrusted code
//      renders as escaped plain text; that's the accepted cost.
//   2. Anything linkify-it (the matcher behind markdown-it's linkify) would
//      link, including bare/Unicode/punycode domains, emails and IPs, gets its
//      separators (. : / @) entity-encoded instead. Entities and escapes both
//      split markdown-it's text tokens, so no linkifier sees a whole host.
//   3. Whitespace (including newlines) was already collapsed to single spaces
//      above, so a field can never start a new block.
// "&" becomes "&amp;" so input can't smuggle entities (e.g. "&#91;" or
// "&#x2F;") past the escaping or the linkify pass. Single pass, linear time:
// output is at most 6 chars per input char. "<!-- prlore:end -->" in input
// comes out escaped, so it can never match the emitter's marker strings.
// ponytail: matches are computed on the plain text; GFM's own autolinker isn't
// tested here (no JS port), markdown-it + commonmark are.
const linkify = new LinkifyIt(undefined, { fuzzyLink: true, fuzzyEmail: true, fuzzyIP: true });
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

function escapeMarkdown(text: string): string {
  const inLink = new Uint8Array(text.length);
  for (const m of linkify.match(text) ?? []) inLink.fill(1, m.index, m.lastIndex);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "&") out += "&amp;"; // first: no attacker-supplied entity survives
    else if (inLink[i] && /[.:/@]/.test(c)) out += `&#${c.charCodeAt(0)};`;
    else if (ASCII_PUNCT.test(c)) out += `\\${c}`;
    else out += c;
  }
  return out;
}

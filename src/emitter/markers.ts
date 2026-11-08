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
  return neutralizeLinksAndHtml(out.trim());
}

// A CommonMark code span: a maximal backtick run (not backslash-escaped) closed
// by the next run of exactly the same length. Inside one, nothing renders as a
// link or HTML, so it's left verbatim (keeps `Array<string>` readable).
const CODE_SPAN = /(?<![`\\])(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

// Rule text is model output derived from untrusted PR text (audit 2026-11-07
// H2), and the written file is read by coding agents and humans. Outside code
// spans, make sure it can't render a link, image, autolink, or raw HTML:
//   - "[" becomes "&#91;" so no inline link, reference link, or link reference
//     definition can form (a field can start a block: the overview line, or
//     the content of a "- " list item). CommonMark never treats an entity as
//     structure. "](" is also split, belt and braces.
//   - "<" is escaped, killing HTML tags and <scheme:...> autolinks;
//   - any backtick NOT part of a span matched here becomes "&#96;", so every
//     field's spans are balanced on their own. Without this, a stray backtick
//     in one field could pair with one in the next field rendered on the same
//     line, and the renderer would see different span boundaries than this
//     per-field split (letting HTML through in the other field).
//   - URLs ("scheme://...", protocol-relative "//...", "www....", "mailto:...")
//     are wrapped in a code span: linkifiers (GFM, markdown-it linkify) never look inside code, and
//     the URL stays readable. A bracket defang like "https[:]//host" is not
//     enough: markdown-it still links the "//host" part.
// Where this splitter and a renderer could disagree (odd backtick nesting),
// the splitter errs toward treating text as NOT code, i.e. over-escaping.
// Finally, a field may be rendered at the start of a line or list item, so a
// leading block marker (heading, quote, list, setext/thematic break, table,
// fence) is backslash-escaped.
function neutralizeLinksAndHtml(s: string): string {
  const neutralize = (t: string): string =>
    t
      .replaceAll("](", "] (")
      .replaceAll("[", "&#91;")
      .replaceAll("<", "&lt;")
      .replaceAll("`", "&#96;")
      .replace(/(?:\b[a-z][a-z0-9+.-]*:)?\/\/\S*|\bwww\.\S*|\bmailto:\S*/gi, (url) => `\`${url}\``);
  let out = "";
  let last = 0;
  for (const m of s.matchAll(CODE_SPAN)) {
    out += neutralize(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += neutralize(s.slice(last));
  return out.replace(/^[#>+\-*=|_~]/, "\\$&").replace(/^(\d{1,9})([.)])/, "$1\\$2");
}

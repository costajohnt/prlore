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
//   - Anything a linkifier would turn into a link is defanged in place:
//     linkify-it (the matcher markdown-it's linkify uses) finds URLs, bare and
//     Unicode/punycode domains, emails and IPs; each match gets "." -> "[.]"
//     and "://" -> "[://]", which no linkifier matches and a reader still
//     understands. No code spans are added, so backtick runs never change.
//     A regex pass then defangs any leftover "scheme://", "//host", "www."
//     or "mailto:" linkify-it didn't report.
// Where this splitter and a renderer could disagree (odd backtick nesting),
// the splitter errs toward treating text as NOT code, i.e. over-escaping.
// Finally, a field may be rendered at the start of a line or list item, so a
// leading block marker (heading, quote, list, setext/thematic break, table,
// fence) is backslash-escaped.
const linkify = new LinkifyIt(undefined, { fuzzyLink: true, fuzzyEmail: true, fuzzyIP: true });

const escapeText = (t: string): string =>
  t.replaceAll("[", "&#91;").replaceAll("<", "&lt;").replaceAll("`", "&#96;");

const defang = (t: string): string =>
  t
    .replaceAll("://", "[://]")
    .replace(/(?<!:)\/\/(?=\S)/g, "/[/]")
    .replace(/\bwww\./gi, "www[.]")
    .replace(/\bmailto:/gi, "mailto[:]");

// Defang every linkify-it match (and the regex leftovers) until nothing
// changes: a defang can create new context ("src=//host" -> "src=/[/]host"
// makes "host" a fuzzy link), so one pass isn't enough. Anything linkify-it
// still matches after that gets its separators entity-encoded, which splits
// markdown-it's text tokens so no linkifier sees a host.
function neutralizeText(raw: string): string {
  let t = escapeText(raw.replaceAll("](", "] ("));
  for (;;) {
    let next = "";
    let last = 0;
    for (const m of linkify.match(t) ?? []) {
      next += t.slice(last, m.index) + t.slice(m.index, m.lastIndex).replaceAll(".", "[.]");
      last = m.lastIndex;
    }
    next = defang(next + t.slice(last)).replaceAll("](", "] (");
    if (next === t) break;
    t = next;
  }
  for (const m of [...(linkify.match(t) ?? [])].reverse()) {
    const encoded = t.slice(m.index, m.lastIndex).replace(/[.:/@]/g, (c) => `&#${c.charCodeAt(0)};`);
    t = t.slice(0, m.index) + encoded + t.slice(m.lastIndex);
  }
  return t;
}

function neutralizeLinksAndHtml(s: string): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(CODE_SPAN)) {
    out += neutralizeText(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += neutralizeText(s.slice(last));
  return out.replace(/^[#>+\-*=|_~]/, "\\$&").replace(/^(\d{1,9})([.)])/, "$1\\$2");
}

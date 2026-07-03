import { CONTESTED_HEADER } from "../reconciler/render.js";
import { sanitize } from "./markers.js";

// Single source of truth for the contested-strip/finalize transform. Both the MCP
// `write` tool (src/server-tools.ts) and the `prlore mine` CLI's write gate
// (src/cli.ts) call this SAME function — the hardened, poisoned-header-resistant
// semantics below must never be duplicated or reimplemented at either call site.

// Line-anchored, not a bare substring: a contested item's statement is
// untrusted, PR-derived text and may itself contain the literal header
// substring. render.ts's sanitize() collapses every run of whitespace
// (including embedded newlines — JS `\s` covers \n, \r, and the Unicode line
// separators) in every interpolated field to a single space before it ever
// reaches the draft, and the only place a contested item's text lands is
// inside a `- ${statement} — ${reason}` bullet. That means a contested item's
// own text can never start a line with exactly this heading. A DocPlan
// section heading COULD, though — it renders as its own line-initial "## "
// heading, same as the genuine header — so render.ts's guardSectionHeading()
// perturbs a section heading whose sanitized form would collide with
// CONTESTED_HEADER before this code ever sees the draft. With that guard in
// place, the genuine heading (render.ts emits it at most once) is the only
// thing that can ever match a full line. Anchoring here, instead of
// lastIndexOf on the bare substring, is what keeps a poisoned CONTESTED
// statement (whose text sits AFTER the real header in the rendered draft)
// from being mistaken for the genuine occurrence and causing the strip to
// keep the header plus every unresolved contested bullet ahead of the
// poisoned one. Built from render.ts's CONTESTED_HEADER constant rather than
// a second hardcoded literal, so the two can't drift apart.
const CONTESTED_HEADER_LINE = new RegExp(`^## ${CONTESTED_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");

// Strips the contested section (everything from the "Needs your call" header
// onward — unresolved contested items stay preview-only, never written) and, for
// any items the caller resolved "keep", appends a "Resolved" section ahead of that
// cut point. v1-simple per the plan: no re-render, just string surgery on the
// already-rendered draft.
export function finalizeDraft(draft: string, resolvedStatements: string[]): string {
  const match = CONTESTED_HEADER_LINE.exec(draft);
  const base = (match === null ? draft : draft.slice(0, match.index)).replace(/\n+$/, "");
  const withResolved =
    resolvedStatements.length === 0
      ? base
      : `${base}\n\n## Resolved\n${resolvedStatements.map((s) => `- **${sanitize(s)}** _(resolved)_`).join("\n")}`;
  return `${withResolved.replace(/\n+$/, "")}\n`;
}

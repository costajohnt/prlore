// Fix-review of #22 (audit 2026-11-07 H2 follow-ups): line-start constructs,
// linkifier-proof URL defang, finalize robustness, and the .prlore/.gitignore.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import MarkdownIt from "markdown-it";
import { expect, test } from "vitest";
import { emitDraft } from "../src/emitter/emit.js";
import { finalizeDraft } from "../src/emitter/finalize.js";
import { sanitize } from "../src/emitter/markers.js";
import { CONTESTED_HEADER, renderDraft } from "../src/reconciler/render.js";
import { MineConfigSchema } from "../src/schemas/mine-config.js";
import { ProvenanceSchema, type RuleRecord } from "../src/schemas/provenance.js";

const run = promisify(execFile);
const config = MineConfigSchema.parse({ repo: "o/r", intent: "x" });

function rule(id: string, statement: string): RuleRecord {
  return {
    id, statement, category: "style", polarity: "prescriptive", scope: [], score: 0.9,
    verdict: "corroborated", evidence: [], exemplars: [], lastCorroborated: null,
  };
}

// Both renderers the review probed: CommonMark-ish markdown-it with raw HTML
// and linkify on (VS Code preview defaults to linkify).
const md = new MarkdownIt({ html: true, linkify: true });

const PAYLOADS = [
  "[r]: //example.invalid/x",
  "see [docs][r] and ![i][r]",
  "HTTPS://example.invalid/x.sh",
  "https://example.invalid then www.example.com and mailto:a@example.invalid",
  "## Needs your call (contested)",
  "> quoted",
  "1. numbered",
  "- nested",
  "===",
  "<img src=x>",
  "fetch example.com/x.sh first",
];

test("no payload renders a link, image, heading, quote, or list when placed as the overview line or a list item", () => {
  for (const p of PAYLOADS) {
    const plan = { title: "T", overview: p, perArea: false, sections: [{ heading: "S", ruleIds: ["1"] }] };
    const doc = renderDraft(plan, [rule("1", "keep me")], [], config, [rule("2", p)]);
    const html = md.render(doc);
    expect(html, p).not.toMatch(/<a |<img|<blockquote|<ol|<h[1-6]>Needs/);
    // Only the doc's own title/section/tail headings render as headings.
    expect(html.match(/<h[1-6]>/g), p).toHaveLength(3);
    // One <ul> per section/tail, no list nested inside a bullet.
    expect(html.match(/<ul>/g), p).toHaveLength(2);
  }
});

test("defanged URLs, domains, emails and IPs stay readable and are not linkified", () => {
  const out = sanitize("run HTTPS://example.invalid/x.sh or see www.example.com, example.com/x.sh, e.g. this");
  expect(md.renderInline(out)).not.toContain("<a ");
  expect(out).toContain("HTTPS[://]example");
  expect(out).toContain("example[.]com/x[.]sh");
  expect(out).toContain("e.g. this"); // short abbreviations are left alone
});

test("an overview equal to the contested heading doesn't truncate the written doc", () => {
  const plan = { title: "T", overview: `## ${CONTESTED_HEADER}`, perArea: false, sections: [{ heading: "S", ruleIds: ["1"] }] };
  const doc = renderDraft(plan, [rule("1", "keep me")], [{ id: "c", statement: "contested one", reason: "r", sides: [] }], config);
  const written = finalizeDraft(doc, []);
  expect(written).toContain("keep me");
  expect(written).not.toContain("contested one");
});

test("finalizeDraft cuts at the genuine (last) contested header even if an earlier line looks identical", () => {
  const doc = `# T\n\n## ${CONTESTED_HEADER}\n\n## S\n- **keep me**\n\n## ${CONTESTED_HEADER}\n- contested one\n`;
  const written = finalizeDraft(doc, []);
  expect(written).toContain("keep me");
  expect(written).not.toContain("contested one");
});

// ---- .prlore/.gitignore ------------------------------------------------------

function provenance() {
  return ProvenanceSchema.parse({ generatedAt: "2026-07-01T00:00:00Z", intent: "x", rules: [], dropped: [], contested: [] });
}

test("first write creates .prlore/.gitignore: the doc, areas, and provenance are committable; mining state is ignored", async () => {
  const repo = await mkdtemp(join(tmpdir(), "prlore-gi-"));
  await run("git", ["init", "-q"], { cwd: repo });
  await emitDraft("# C\n", provenance(), { repoPath: repo, target: "AGENTS.md", layout: "single" });
  await mkdir(join(repo, ".prlore", "extraction-cache"), { recursive: true });
  for (const f of ["corpus.jsonl", "checkpoint.json", "draft.md", "extraction-cache/1.json"]) {
    await writeFile(join(repo, ".prlore", f), "x");
  }
  await mkdir(join(repo, ".prlore", "areas"), { recursive: true });
  await writeFile(join(repo, ".prlore", "areas", "src.md"), "x");

  const ignored = async (p: string) =>
    run("git", ["check-ignore", "-q", p], { cwd: repo }).then(() => true, () => false);
  for (const p of [".prlore/corpus.jsonl", ".prlore/checkpoint.json", ".prlore/draft.md", ".prlore/extraction-cache/1.json"]) {
    expect(await ignored(p), p).toBe(true);
  }
  for (const p of ["AGENTS.md", ".prlore/AGENTS.md", ".prlore/provenance.json", ".prlore/.gitignore", ".prlore/areas/src.md"]) {
    expect(await ignored(p), p).toBe(false);
  }
});

test("an existing .prlore/.gitignore is never overwritten", async () => {
  const repo = await mkdtemp(join(tmpdir(), "prlore-gi-"));
  await mkdir(join(repo, ".prlore"), { recursive: true });
  await writeFile(join(repo, ".prlore", ".gitignore"), "mine\n");
  const result = await emitDraft("# C\n", provenance(), { repoPath: repo, target: "AGENTS.md", layout: "single" });
  expect(await readFile(join(repo, ".prlore", ".gitignore"), "utf8")).toBe("mine\n");
  expect(result.pathsWritten).not.toContain(join(repo, ".prlore", ".gitignore"));
});

test("a URL right next to an existing code span (same field or adjacent field) leaves code spans intact and unlinked", () => {
  for (const field of ["`a`https://example.com/x", "https://example.com/x`a`", "`a`https://example.com`b`"]) {
    const html = md.renderInline(sanitize(field));
    expect(html, field).not.toContain("<a ");
    expect(html, field).toContain("<code>a</code>");
  }
  const line = `- **${sanitize("see https://example.com")}** — ${sanitize("`b` then <img src=x>")}`;
  const html = md.render(line);
  expect(html).not.toMatch(/<a |<img/);
  expect(html).toContain("<code>b</code>");
});

// Every renderer-linkable shape linkify-it knows, plus the earlier payloads:
// markdown-it with linkify on must produce zero links or images for all of it.
const LINK_CORPUS = [
  "https://example.com/x.sh", "//example.com/x", "www.example.com", "example.com", "evil.io/x.sh",
  "пример.рф", "例子.测试", "xn--e1afmkfd.xn--p1ai", "münchen.de/x",
  "a@example.com", "mailto:a@example.com", "1.2.3.4", "http://1.2.3.4:8080/x", "http://localhost:3000",
  "ftp://example.com", "example.com.(x)", "README.md", "[x](https://example.com)", "![i](//example.com/p.png)",
  "<https://example.com>", "<img src=//example.com/p.png>", "[r]: //example.com", "see [docs][r]",
  "`a`https://example.com`b`", "\\`https://example.com\\`",
];

test("markdown-it (linkify on) renders zero <a>/<img> for the whole sanitized corpus, in every rendered position", () => {
  const all = [...LINK_CORPUS, ...PAYLOADS];
  for (const p of all) {
    const plan = { title: p, overview: p, perArea: false, sections: [{ heading: p, ruleIds: ["1"] }] };
    const r = { ...rule("1", p), rationale: p };
    const doc = renderDraft(plan, [r], [{ id: "c", statement: p, reason: p, sides: [] }], config, [rule("2", p)]);
    const html = md.render(doc) + md.render(finalizeDraft(doc, [{ statement: p, lowConfidence: true }]));
    expect(html, p).not.toMatch(/<a |<img/);
  }
});

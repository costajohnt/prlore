// Fix-review of #22 (audit 2026-11-07 H2 follow-ups): line-start constructs,
// linkifier-proof URL defang, finalize robustness, and the .prlore/.gitignore.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as commonmark from "commonmark";
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

// markdown-it with raw HTML and linkify on (VS Code preview defaults to
// linkify), and the commonmark reference implementation.
const md = new MarkdownIt({ html: true, linkify: true });
const cmParser = new commonmark.Parser();
const cmRenderer = new commonmark.HtmlRenderer();
const renderers: [string, (src: string) => string][] = [
  ["markdown-it", (src) => md.render(src)],
  ["commonmark", (src) => cmRenderer.render(cmParser.parse(src))],
];

const CORPUS = [
  "[r]: //example.invalid/x", "see [docs][r] and ![i][r]", "://: x", ".: x", "[x]: //h", "[://]: x",
  "HTTPS://example.invalid/x.sh", "https://example.com/x.sh", "//example.com/x", "www.example.com",
  "example.com", "evil.io/x.sh", "README.md", "пример.рф", "例子.测试", "xn--e1afmkfd.xn--p1ai",
  "münchen.de/x", "a@example.com", "mailto:a@example.com", "1.2.3.4", "http://1.2.3.4:8080/x",
  "http://localhost:3000", "example.com.(x)", "[x](https://example.com)", "![i](//example.com/p.png)",
  "<https://example.com>", "<img src=//example.com/p.png>", "<img src=x>", "<b>bold</b>",
  "`a`https://example.com`b`", "https://example.com`a`", "\\`<img src=x>\\`", "`<b>x``",
  "## Needs your call (contested)", "# h", "> quoted", "1. numbered", "1) numbered", "- nested", "* star",
  "+ plus", "===", "---", "***", "| a | b |", "```js", "~~~", "    indented", "*em* _em_ **strong**",
  "&lt;img&gt; &amp; &#60;b&#62;", "line one\n# line two\n\n- item", "\u001b]8;;https://example.com\u0007x\u202ey",
];

// Deterministic pseudo-random strings over markdown-significant characters.
function randomCorpus(n: number): string[] {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const atoms = ["[", "]", "(", ")", "<", ">", "`", "``", "*", "_", "#", "!", ":", "//", ".", "@", "-", "=", "|", "\\", "&", ";",
    "\n", " ", "a", "x", "example", "com", "www", "http", "img", "src", "1", "2.", "rf", "рф", "例子"];
  return Array.from({ length: n }, () =>
    Array.from({ length: 1 + Math.floor(rnd() * 24) }, () => atoms[Math.floor(rnd() * atoms.length)]).join(""),
  );
}

test("property: every sanitized field renders as exactly one plain paragraph in markdown-it (linkify) and commonmark", () => {
  for (const p of [...CORPUS, ...randomCorpus(500)]) {
    const field = sanitize(p);
    if (field === "") continue;
    for (const [name, render] of renderers) {
      const html = render(field);
      expect(html, `${name}: ${JSON.stringify(p)}`).toMatch(/^<p>[^<]*<\/p>\n$/);
    }
  }
});

test("property: fields in every rendered position (title, overview, heading, bullets, contested, resolved) add no structure", () => {
  const build = (p: string) => {
    const plan = { title: p, overview: p, perArea: false, sections: [{ heading: p, ruleIds: ["1"] }] };
    const r = { ...rule("1", p), rationale: p };
    const doc = renderDraft(plan, [r], [{ id: "c", statement: p, reason: p, sides: [] }], config, [rule("2", p)]);
    return [doc, finalizeDraft(doc, [{ statement: p, lowConfidence: true }])];
  };
  // The tag sequence must be exactly what a plain word produces: prlore's own
  // headings, bullets, bold and citations, nothing contributed by the field.
  const tags = (html: string) => html.match(/<\/?[a-z0-9]+/g)?.join(" ");
  const baseline = build("plain");
  for (const p of [...CORPUS, ...randomCorpus(200)]) {
    if (sanitize(p) === "") continue;
    build(p).forEach((src, i) => {
      for (const [name, render] of renderers) {
        expect(tags(render(src)), `${name}: ${JSON.stringify(p)}`).toBe(tags(render(baseline[i]!)));
      }
    });
  }
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

test("pathological input is linear: 10k repetitions of :// and ]( finish fast with bounded output", () => {
  const input = "://](".repeat(10_000);
  const t0 = performance.now();
  const out = sanitize(input);
  expect(performance.now() - t0).toBeLessThan(100);
  expect(out.length).toBeLessThanOrEqual(input.length * 6);
});

test("attacker-supplied entities can't hide link syntax or destinations", () => {
  for (const p of ["&#91;x&#93;&#40;https&#58;&#x2F;&#x2F;example.com&#41;", "&#x5B;r]: &#x2F;&#x2F;example.com", "&lt;img src=x&gt;"]) {
    const out = sanitize(p);
    expect(out).not.toMatch(/&(?!amp;|#(46|47|58|64);)/); // every input "&" became "&amp;"
    for (const [name, render] of renderers) {
      expect(render(out), `${name}: ${p}`).toMatch(/^<p>[^<]*<\/p>\n$/);
    }
  }
});

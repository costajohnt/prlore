import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { emitDraft, EmitRefusedError } from "../src/emitter/emit.js";
import { ProvenanceSchema, type Provenance, type RuleRecord } from "../src/schemas/provenance.js";

const BEGIN = "<!-- prlore:begin -->";
const END = "<!-- prlore:end -->";

const tmpRepo = () => mkdtemp(join(tmpdir(), "prlore-emit-"));

function mkRule(overrides: Partial<RuleRecord> = {}): RuleRecord {
  return {
    id: "1",
    statement: "Always write tests first",
    category: "testing",
    polarity: "prescriptive",
    scope: [],
    score: 0.9,
    verdict: "corroborated",
    evidence: [],
    exemplars: [],
    lastCorroborated: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

function mkProvenance(rules: RuleRecord[] = [mkRule()]): Provenance {
  return ProvenanceSchema.parse({
    generatedAt: "2026-07-01T00:00:00Z",
    intent: "help contributors",
    rules,
    dropped: [],
    contested: [],
  });
}

// ---- fresh write -------------------------------------------------------

test("fresh file: target absent gets the draft wrapped in managed markers", async () => {
  const repoPath = await tmpRepo();
  const provenance = mkProvenance();
  const result = await emitDraft("# Conventions\n\nWrite tests.\n", provenance, {
    repoPath,
    target: "AGENTS.md",
    layout: "single",
  });

  const written = await readFile(join(repoPath, "AGENTS.md"), "utf8");
  expect(written).toBe(`${BEGIN}\n# Conventions\n\nWrite tests.\n${END}\n`);
  expect(result.pathsWritten).toContain(join(repoPath, "AGENTS.md"));
});

// ---- managed-block replacement -----------------------------------------

test("managed-block replacement leaves surrounding human prose byte-identical", async () => {
  const repoPath = await tmpRepo();
  const above = "# My Project\n\nSome human-written intro that must survive untouched.\n\n";
  const below = "\n## Human section below\n\nMore hand-written prose, untouched.\n";
  const original = `${above}${BEGIN}\nold draft content\n${END}${below}`;
  await writeFile(join(repoPath, "AGENTS.md"), original, "utf8");

  const provenance = mkProvenance();
  await emitDraft("new draft content\n", provenance, { repoPath, target: "AGENTS.md", layout: "single" });

  const written = await readFile(join(repoPath, "AGENTS.md"), "utf8");
  const beginIdx = written.indexOf(BEGIN);
  const endIdx = written.indexOf(END);
  expect(written.slice(0, beginIdx)).toBe(above);
  expect(written.slice(endIdx + END.length)).toBe(below);
  expect(written).toContain("new draft content");
  expect(written).not.toContain("old draft content");
});

// ---- refusal cases -------------------------------------------------------

test("refuses when target has no markers at all; file untouched", async () => {
  const repoPath = await tmpRepo();
  const original = "# Human doc\n\nNo markers here.\n";
  const path = join(repoPath, "AGENTS.md");
  await writeFile(path, original, "utf8");
  const before = await stat(path);

  await expect(emitDraft("draft\n", mkProvenance(), { repoPath, target: "AGENTS.md", layout: "single" })).rejects.toThrow(
    EmitRefusedError,
  );

  expect(await readFile(path, "utf8")).toBe(original);
  const after = await stat(path);
  expect(after.mtimeMs).toBe(before.mtimeMs);
});

test("refuses when begin marker is duplicated; file untouched", async () => {
  const repoPath = await tmpRepo();
  const original = `intro\n${BEGIN}\nfirst\n${END}\nmiddle\n${BEGIN}\nsecond\n${END}\nend\n`;
  const path = join(repoPath, "AGENTS.md");
  await writeFile(path, original, "utf8");

  await expect(emitDraft("draft\n", mkProvenance(), { repoPath, target: "AGENTS.md", layout: "single" })).rejects.toThrow(
    EmitRefusedError,
  );

  expect(await readFile(path, "utf8")).toBe(original);
});

test("refuses when markers are reversed (end before begin); file untouched", async () => {
  const repoPath = await tmpRepo();
  const original = `intro\n${END}\nmiddle\n${BEGIN}\nend\n`;
  const path = join(repoPath, "AGENTS.md");
  await writeFile(path, original, "utf8");

  await expect(emitDraft("draft\n", mkProvenance(), { repoPath, target: "AGENTS.md", layout: "single" })).rejects.toThrow(
    EmitRefusedError,
  );

  expect(await readFile(path, "utf8")).toBe(original);
});

test("refusal leaves the sidecar unwritten too — nothing written at all", async () => {
  const repoPath = await tmpRepo();
  await writeFile(join(repoPath, "AGENTS.md"), "no markers\n", "utf8");

  await expect(emitDraft("draft\n", mkProvenance(), { repoPath, target: "AGENTS.md", layout: "single" })).rejects.toThrow(
    EmitRefusedError,
  );

  await expect(stat(join(repoPath, ".prlore", "provenance.json"))).rejects.toThrow();
});

// ---- sidecar -------------------------------------------------------------

test("sidecar is always written to <repoPath>/.prlore/provenance.json and is schema-valid on re-read", async () => {
  const repoPath = await tmpRepo();
  const provenance = mkProvenance();
  const result = await emitDraft("draft\n", provenance, { repoPath, target: "AGENTS.md", layout: "single" });

  const sidecarPath = join(repoPath, ".prlore", "provenance.json");
  expect(result.pathsWritten).toContain(sidecarPath);
  const reread = JSON.parse(await readFile(sidecarPath, "utf8"));
  expect(ProvenanceSchema.parse(reread)).toEqual(provenance);
});

// ---- per-area mode ---------------------------------------------------------

test("per-area layout: root gets links + full draft, area files get filtered stubs, non-existent dirs skipped", async () => {
  const repoPath = await tmpRepo();
  await mkdir(join(repoPath, "auth"), { recursive: true });
  await mkdir(join(repoPath, "webapp"), { recursive: true });
  // no "ghost" dir created — its rule scope must NOT produce an area file

  const authRule = mkRule({ id: "a1", statement: "Hash passwords with bcrypt", scope: ["auth/login.ts"] });
  const webappRule = mkRule({ id: "w1", statement: "Use functional components", scope: ["webapp"] });
  const ghostRule = mkRule({ id: "g1", statement: "Ghost dir rule", scope: ["ghost/thing.ts"] });
  const provenance = mkProvenance([authRule, webappRule, ghostRule]);

  const draft = "# Conventions\n\nFull draft body with everything.\n";
  const result = await emitDraft(draft, provenance, { repoPath, target: "AGENTS.md", layout: "per-area" });

  const root = await readFile(join(repoPath, "AGENTS.md"), "utf8");
  expect(root).toContain("Full draft body with everything.");
  expect(root).toContain("auth/AGENTS.md");
  expect(root).toContain("webapp/AGENTS.md");
  expect(root).not.toContain("ghost/AGENTS.md");

  const authStub = await readFile(join(repoPath, "auth", "AGENTS.md"), "utf8");
  expect(authStub).toContain("# Conventions for auth");
  expect(authStub).toContain("Hash passwords with bcrypt");
  expect(authStub).not.toContain("Use functional components");

  const webappStub = await readFile(join(repoPath, "webapp", "AGENTS.md"), "utf8");
  expect(webappStub).toContain("# Conventions for webapp");
  expect(webappStub).toContain("Use functional components");
  expect(webappStub).not.toContain("Hash passwords with bcrypt");

  await expect(stat(join(repoPath, "ghost", "AGENTS.md"))).rejects.toThrow();

  expect(result.pathsWritten).toEqual(
    expect.arrayContaining([
      join(repoPath, "AGENTS.md"),
      join(repoPath, "auth", "AGENTS.md"),
      join(repoPath, "webapp", "AGENTS.md"),
      join(repoPath, ".prlore", "provenance.json"),
    ]),
  );

  const sidecar = JSON.parse(await readFile(join(repoPath, ".prlore", "provenance.json"), "utf8"));
  expect(ProvenanceSchema.parse(sidecar)).toEqual(provenance);
});

test("per-area stub files are managed blocks too: existing stub with valid markers gets its region replaced only", async () => {
  const repoPath = await tmpRepo();
  await mkdir(join(repoPath, "auth"), { recursive: true });
  const above = "# hand-authored heading for auth\n\n";
  await writeFile(join(repoPath, "auth", "AGENTS.md"), `${above}${BEGIN}\nold stub\n${END}\n`, "utf8");

  const authRule = mkRule({ id: "a1", statement: "Hash passwords with bcrypt", scope: ["auth/login.ts"] });
  const provenance = mkProvenance([authRule]);
  await emitDraft("# Conventions\n\nbody\n", provenance, { repoPath, target: "AGENTS.md", layout: "per-area" });

  const authStub = await readFile(join(repoPath, "auth", "AGENTS.md"), "utf8");
  expect(authStub.startsWith(above)).toBe(true);
  expect(authStub).toContain("Hash passwords with bcrypt");
  expect(authStub).not.toContain("old stub");
});

// ---- auto layout ------------------------------------------------------------

test("auto layout falls back to single when the draft is under the line threshold", async () => {
  const repoPath = await tmpRepo();
  await mkdir(join(repoPath, "auth"), { recursive: true });
  const authRule = mkRule({ id: "a1", statement: "Hash passwords with bcrypt", scope: ["auth/login.ts"] });
  const provenance = mkProvenance([authRule]);

  await emitDraft("short draft\n", provenance, { repoPath, target: "AGENTS.md", layout: "auto" });

  await expect(stat(join(repoPath, "auth", "AGENTS.md"))).rejects.toThrow();
  const root = await readFile(join(repoPath, "AGENTS.md"), "utf8");
  expect(root).toContain("short draft");
});

// ---- Fix (per-area escape): untrusted scope segments must stay inside repoPath --
//
// Area names come from `rule.scope[]`'s first path segment — untrusted,
// model-derived text. Without an allowlist, "." resolves to repoPath itself
// (its "area" stub write silently clobbers the freshly written root managed
// content) and ".." resolves to repoPath's parent (its stub write lands
// OUTSIDE repoPath entirely) — both are real, existing directories, so
// existingDirs' bare stat-and-check alone can't catch either case.

test("Fix (per-area escape): a scope segment of '..' does not escape repoPath — no file is written to the parent directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "prlore-emit-escape-"));
  const repoPath = join(parent, "repo");
  await mkdir(repoPath, { recursive: true });

  const evilRule = mkRule({ id: "e1", statement: "Escape rule", scope: ["../evil.ts"] });
  const provenance = mkProvenance([evilRule]);

  await emitDraft("# Conventions\n\nbody\n", provenance, { repoPath, target: "AGENTS.md", layout: "per-area" });

  // The unfixed code resolves ".." to `parent` (a real, existing directory —
  // it's repoPath's own parent) and writes the area stub there.
  await expect(stat(join(parent, "AGENTS.md"))).rejects.toThrow();
});

test("Fix (per-area escape): a scope segment of '.' does not clobber the root target's managed content", async () => {
  const repoPath = await tmpRepo();
  const dotRule = mkRule({ id: "d1", statement: "Dot rule", scope: ["./whatever.ts"] });
  const provenance = mkProvenance([dotRule]);

  await emitDraft("# Conventions\n\nRoot body text that must survive.\n", provenance, {
    repoPath,
    target: "AGENTS.md",
    layout: "per-area",
  });

  const root = await readFile(join(repoPath, "AGENTS.md"), "utf8");
  expect(root).toContain("Root body text that must survive.");
  // The unfixed code resolves "." to repoPath itself, so its area-stub write
  // (this exact body) overwrites the root managed content just written above.
  expect(root).not.toContain("Conventions for .");
});

test("Fix (per-area escape): a normal path segment still produces its area stub (allowlist isn't overly strict)", async () => {
  const repoPath = await tmpRepo();
  await mkdir(join(repoPath, "src"), { recursive: true });
  const rule = mkRule({ id: "s1", statement: "Normal area rule", scope: ["src/foo.ts"] });
  const provenance = mkProvenance([rule]);

  await emitDraft("# Conventions\n\nbody\n", provenance, { repoPath, target: "AGENTS.md", layout: "per-area" });

  const stub = await readFile(join(repoPath, "src", "AGENTS.md"), "utf8");
  expect(stub).toContain("Normal area rule");
});

test("auto layout switches to per-area when the draft exceeds 400 lines", async () => {
  const repoPath = await tmpRepo();
  await mkdir(join(repoPath, "auth"), { recursive: true });
  const authRule = mkRule({ id: "a1", statement: "Hash passwords with bcrypt", scope: ["auth/login.ts"] });
  const provenance = mkProvenance([authRule]);
  const longDraft = `${"line\n".repeat(401)}`;

  await emitDraft(longDraft, provenance, { repoPath, target: "AGENTS.md", layout: "auto" });

  const authStub = await readFile(join(repoPath, "auth", "AGENTS.md"), "utf8");
  expect(authStub).toContain("Hash passwords with bcrypt");
});

// ---- v0.3 Task 1: byte-based auto layout ------------------------------------
//
// The ink acceptance run produced a 44KB single-file doc that dodged the
// line-count check entirely because its rules rendered as very long individual
// lines (~150 lines total). A byte-length trigger closes that gap.

test("auto layout switches to per-area when the draft is under 400 lines but exceeds the 24KB byte threshold", async () => {
  const repoPath = await tmpRepo();
  await mkdir(join(repoPath, "auth"), { recursive: true });
  const authRule = mkRule({ id: "a1", statement: "Hash passwords with bcrypt", scope: ["auth/login.ts"] });
  const provenance = mkProvenance([authRule]);
  // One giant line (simulating a long single-PR rule statement): well under 400
  // lines, well over 24,000 bytes.
  const longSingleLineDraft = `# Conventions\n\n${"x".repeat(30_000)}\n`;
  expect(longSingleLineDraft.split("\n").length).toBeLessThan(400);
  expect(Buffer.byteLength(longSingleLineDraft, "utf8")).toBeGreaterThan(24_000);

  await emitDraft(longSingleLineDraft, provenance, { repoPath, target: "AGENTS.md", layout: "auto" });

  const authStub = await readFile(join(repoPath, "auth", "AGENTS.md"), "utf8");
  expect(authStub).toContain("Hash passwords with bcrypt");
});

test("auto layout stays single when the draft is under BOTH the line and byte thresholds", async () => {
  const repoPath = await tmpRepo();
  await mkdir(join(repoPath, "auth"), { recursive: true });
  const authRule = mkRule({ id: "a1", statement: "Hash passwords with bcrypt", scope: ["auth/login.ts"] });
  const provenance = mkProvenance([authRule]);
  const shortDraft = "# Conventions\n\nJust a few short lines.\n";

  await emitDraft(shortDraft, provenance, { repoPath, target: "AGENTS.md", layout: "auto" });

  await expect(stat(join(repoPath, "auth", "AGENTS.md"))).rejects.toThrow();
});

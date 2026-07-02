const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript",
  ".py": "python", ".go": "go", ".rb": "ruby", ".rs": "rust", ".java": "java",
};

const FRAMEWORK_DEPS: Record<string, string> = {
  react: "react", vue: "vue", svelte: "svelte", "@angular/core": "angular",
  next: "next", express: "express", fastify: "fastify",
};

export async function collectTooling(
  files: string[],
  readFile: (path: string) => Promise<string>,
): Promise<{ languages: string[]; frameworks: string[]; tooling: string[] }> {
  const extCounts = new Map<string, number>();
  let codeFiles = 0;
  for (const f of files) {
    const idx = f.lastIndexOf(".");
    const ext = idx > f.lastIndexOf("/") ? f.slice(idx) : "";
    if (!(ext in LANGUAGE_BY_EXT)) continue;
    codeFiles++;
    extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }
  const langShares = new Map<string, number>();
  for (const [ext, n] of extCounts) {
    const lang = LANGUAGE_BY_EXT[ext]!;
    langShares.set(lang, (langShares.get(lang) ?? 0) + n);
  }
  const languages = [...langShares.entries()]
    .filter(([, n]) => codeFiles > 0 && n / codeFiles >= 0.1)
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang);

  const frameworks: string[] = [];
  if (files.includes("package.json")) {
    try {
      const pkg = JSON.parse(await readFile("package.json")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [dep, name] of Object.entries(FRAMEWORK_DEPS)) {
        if (dep in deps) frameworks.push(name);
      }
    } catch {
      // unreadable/invalid package.json → no framework detection
    }
  }

  const tooling: string[] = [];
  const has = (pred: (f: string) => boolean) => files.some(pred);
  if (has((f) => f.startsWith(".eslintrc") || f.startsWith("eslint.config."))) tooling.push("eslint");
  if (has((f) => f.startsWith(".prettierrc"))) tooling.push("prettier");
  if (files.includes("tsconfig.json")) tooling.push("typescript-config");
  if (has((f) => f.startsWith("vitest.config."))) tooling.push("vitest");
  if (has((f) => f.startsWith("jest.config."))) tooling.push("jest");
  if (has((f) => f.startsWith(".github/workflows/"))) tooling.push("github-actions");
  if (files.includes("pyproject.toml")) tooling.push("python-project");
  if (files.includes("go.mod")) tooling.push("go-modules");
  if (files.includes("Cargo.toml")) tooling.push("cargo");

  return { languages, frameworks, tooling };
}

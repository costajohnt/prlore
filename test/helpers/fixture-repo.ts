import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, args: string[], date?: string): Promise<void> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
    ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
  };
  await run("git", args, { cwd, env });
}

async function write(repo: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), content, "utf8");
}

/**
 * Deterministic fixture: a staged oldApi→newApi migration.
 *  2023-12: legacy/ jQuery-era files, oldApi everywhere (3 occurrences)
 *  (date chosen INSIDE the 36-month pickaxe window from now=2026-07-01, so the
 *   prior bucket sees 2 oldApi commits vs 1 recent → trend "falling")
 *  2024-06: src/app.ts mixes oldApi (2) + newApi (1)
 *  2026-05: src/components/button.ts newApi; app.ts drops one oldApi
 *  2026-06: src/components/input.ts newApi; manifests + CODEOWNERS + eslint
 * HEAD occurrence totals: oldApi = 5 (2 legacy jquery + 1 legacy util + 1 import + 1 app.ts call), newApi = 7 (1 import + 2 app.ts calls + 2 button + 2 input).
 */
export async function buildFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "prlore-fixture-"));
  await git(repo, ["init", "-q", "-b", "main"]);

  await write(repo, "legacy/jquery-widget.js",
    `$(function () {\n  oldApi("widget");\n  oldApi("menu");\n});\n`);
  await write(repo, "legacy/util.js", `function helper() {\n  return oldApi("util");\n}\n`);
  await git(repo, ["add", "-A"], undefined);
  await git(repo, ["commit", "-q", "-m", "legacy widgets"], "2023-12-01T12:00:00Z");

  await write(repo, "src/app.ts",
    `import { oldApi, newApi } from "./api";\nexport const a = oldApi("x");\nexport const b = oldApi("y");\nexport const c = newApi("z");\n`);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "start app"], "2024-06-01T12:00:00Z");

  await write(repo, "src/components/button.ts",
    `import { newApi } from "../api";\nexport const button = newApi("button");\n`);
  await write(repo, "src/app.ts",
    `import { oldApi, newApi } from "./api";\nexport const a = oldApi("x");\nexport const b = newApi("y");\nexport const c = newApi("z");\n`);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "migrate app toward newApi"], "2026-05-15T12:00:00Z");

  await write(repo, "src/components/input.ts",
    `import { newApi } from "../api";\nexport const input = newApi("input");\n`);
  await write(repo, "package.json",
    `{\n  "name": "fixture",\n  "dependencies": { "react": "^19.0.0" }\n}\n`);
  await write(repo, ".eslintrc.json", `{ "root": true }\n`);
  await write(repo, "CODEOWNERS", `src/ @alice @bob\nlegacy/ @carol\n`);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "components, manifests, owners"], "2026-06-10T12:00:00Z");

  return repo;
}

#!/usr/bin/env node
import { accessSync, constants as fsConstants, createReadStream, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runMineCli } from "./cli.js";
import type { JobManagerApi } from "./jobs/manager.js";
import { defaultMineDepsFactory } from "./server-tools.js";
import { buildServer } from "./server.js";

// Argv dispatch (plan Task 3): no args -> MCP stdio server exactly as before Task
// 3 existed; `mine <owner/repo> [...]` -> the in-process CLI flow; anything else
// -> usage to stderr, exit 2.
//
// `main()` is exported and takes an injectable `MainIo` so tests can drive
// dispatch without a real stdin/stdout stdio transport or real GitHub/Anthropic
// wiring — see test/index.test.ts. The `if (isMain)` guard below is what keeps
// `import "./index.js"` (as this test does) from ever running the real CLI
// entrypoint's side effects during module load.
export interface MainIo {
  stdout: Writable;
  stderr: Writable;
  connectStdioServer: () => Promise<void>;
  manager?: JobManagerApi;
}

// Best-effort interactive confirm: prefers /dev/tty (so the prompt still works
// when stdout is piped, e.g. `prlore mine ... | tee log`) and falls back to
// process.stdin when /dev/tty isn't accessible (Windows, non-interactive CI).
// Not covered by the automated suite — driving a real TTY prompt from vitest
// isn't practical; verified manually instead (see report).
function ttyInputStream(): NodeJS.ReadableStream {
  try {
    accessSync("/dev/tty", fsConstants.R_OK);
    return createReadStream("/dev/tty");
  } catch {
    return process.stdin;
  }
}

async function realConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: ttyInputStream(), output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const defaultIo: MainIo = {
  stdout: process.stdout,
  stderr: process.stderr,
  connectStdioServer: () => buildServer().connect(new StdioServerTransport()),
};

const USAGE = "usage: prlore [mine <owner/repo> [options]]\n";

export async function main(argv: string[], io: MainIo = defaultIo): Promise<number> {
  if (argv.length === 0) {
    await io.connectStdioServer();
    return 0;
  }

  if (argv[0] === "mine") {
    return runMineCli(argv.slice(1), {
      // defaultMineDepsFactory's declared MineDepsFactory type allows a sync
      // JobDeps return (it's shared with the MCP tool layer); CliDeps.makeDeps
      // is typed strictly as Promise<JobDeps>, so wrap rather than widen either
      // contract.
      makeDeps: (config, ctx) => Promise.resolve(defaultMineDepsFactory(config, ctx)),
      manager: io.manager,
      stdout: io.stdout,
      stderr: io.stderr,
      confirm: realConfirm,
    });
  }

  io.stderr.write(`prlore: unknown command "${argv[0]}"\n\n${USAGE}`);
  return 2;
}

// Module-entry guard: only run the real CLI entrypoint (and its side effects —
// connecting a real stdio transport, reading real argv) when this file is
// executed directly (`node dist/index.js`), not when it's imported (as
// test/index.test.ts does to reach `main`).
//
// A bare `import.meta.url === file://${process.argv[1]}` string comparison
// (the common version of this guard) breaks under any symlink indirection:
// npm's installed bin (`prlore` -> node_modules/prlore/dist/index.js, which is
// exactly how `npx -y prlore` — the README's own documented MCP host config —
// invokes this file) leaves process.argv[1] as the UNRESOLVED symlink path
// while Node's ESM loader resolves import.meta.url to the REAL file, so the
// two never match and the real binary would silently no-op instead of serving
// MCP. Verified empirically (see cli-t3-report.md) — even a plain `node
// dist/index.js` invocation can mismatch this way if any path segment is
// itself a symlink (e.g. macOS's /tmp -> /private/tmp). realpathSync on both
// sides fixes it.
function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}

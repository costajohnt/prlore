#!/usr/bin/env node
import { accessSync, constants as fsConstants, openSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { Writable } from "node:stream";
import { ReadStream as TtyReadStream } from "node:tty";
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
// Note: this MUST be a node:tty ReadStream (a uv_tty handle), not an
// fs.createReadStream on the same path. A real pty probe proved
// fs.createReadStream cannot be made to release the event loop from
// destroy(): readline puts the fs ReadStream in flowing mode, and by the
// time the answer chunk arrives the stream has already issued its *next*
// uv_fs_read against /dev/tty. That read is threadpool-backed and
// uncancellable — destroy() is too late by construction, and the process
// hangs until the pty itself hits EOF. A tty.ReadStream isn't
// threadpool-backed, so destroy() in the finally below actually closes the
// fd and lets the event loop drain.
function ttyInputStream(): TtyReadStream | NodeJS.ReadStream {
  try {
    accessSync("/dev/tty", fsConstants.R_OK);
    return new TtyReadStream(openSync("/dev/tty", "r"));
  } catch {
    return process.stdin;
  }
}

// Exported so a real-pty probe can import and exercise it directly (see
// cli-t3-report.md, "Fix Round 2") — vitest can't drive a real TTY, so this
// is the seam manual verification hooks into. Otherwise a pure IO helper;
// not meant to be called outside prlore's own CLI wiring.
export async function realConfirm(question: string): Promise<boolean> {
  const input = ttyInputStream();
  const rl = createInterface({ input, output: process.stderr });
  try {
    // Race the answer against readline's own "close" event. If the input
    // stream hits EOF (Ctrl-D, or the tty/stdin is closed) before a line is
    // typed, readline auto-closes itself — which otherwise leaves
    // rl.question()'s promise permanently unsettled (Node then reports an
    // "unsettled top-level await" and exits 13 instead of running the rest
    // of the CLI). Treat that EOF as an explicit decline, same as any other
    // non-"y" answer.
    const answer = await Promise.race([
      rl.question(`${question} [y/N] `),
      new Promise<null>((resolve) => rl.once("close", () => resolve(null))),
    ]);
    return answer !== null && /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
    if (input === process.stdin) {
      // process.stdin is a shared, process-wide stream — destroying it here
      // would break any later read from stdin in this process. Just stop it
      // from pinning the event loop open so `prlore mine` (which never calls
      // process.exit(), only sets process.exitCode) can still exit.
      input.pause();
      input.unref();
    } else {
      // The /dev/tty path: rl.close() only detaches readline's listeners, it
      // does NOT close the underlying fd. An open ReadStream on a character
      // device keeps the event loop alive indefinitely, so `prlore mine`
      // would hang forever after the user answers. destroy() closes it.
      input.destroy();
    }
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

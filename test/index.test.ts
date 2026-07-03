import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { main } from "../src/index.js";

// index.ts's top-level `if (isMain) { ... }` guard means importing this module in
// tests never spins up a real stdio MCP server or reads real argv — only `main()`,
// the exported dispatch function, runs. This is the "add one dispatch unit test"
// the plan calls for: it proves bare argv still routes to the MCP-server path
// (existing test/server.test.ts / test/server-tools.test.ts cover the MCP surface
// itself against buildServer() directly), without needing a real stdin/stdout
// stdio transport in the test process.

function streams() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const errChunks: string[] = [];
  stderr.on("data", (c) => errChunks.push(String(c)));
  return { stdout, stderr, err: () => errChunks.join("") };
}

test("bare argv (no args) dispatches to the MCP stdio server, not the mine CLI", async () => {
  const { stdout, stderr } = streams();
  const connectStdioServer = vi.fn(async () => {});
  const code = await main([], { stdout, stderr, connectStdioServer });
  expect(code).toBe(0);
  expect(connectStdioServer).toHaveBeenCalledTimes(1);
});

test('"mine" subcommand dispatches to the mine CLI, not the MCP server', async () => {
  const { stdout, stderr, err } = streams();
  const connectStdioServer = vi.fn(async () => {});
  // No positional owner/repo -> the mine CLI's own usage/exit-2 path fires; proves
  // dispatch reached runMineCli (distinguishable from the "unknown command" path
  // by content) without ever touching connectStdioServer.
  const code = await main(["mine"], { stdout, stderr, connectStdioServer });
  expect(code).toBe(2);
  expect(connectStdioServer).not.toHaveBeenCalled();
  expect(err()).toMatch(/usage/i);
});

test("an unrecognized subcommand prints usage to stderr and exits 2", async () => {
  const { stdout, stderr, err } = streams();
  const connectStdioServer = vi.fn(async () => {});
  const code = await main(["bogus"], { stdout, stderr, connectStdioServer });
  expect(code).toBe(2);
  expect(connectStdioServer).not.toHaveBeenCalled();
  expect(err()).toMatch(/bogus/);
});

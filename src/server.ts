import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JobManager, type JobManagerApi } from "./jobs/manager.js";
import { registerTools, type MineDepsFactory } from "./server-tools.js";

// Phase 1 pinned `buildServer()` (no args) as the default-construction contract —
// that default now boots a real JobManager instead of the old status-only
// JobRegistry stub. Tests inject a JobManagerApi-shaped stub in its place.
//
// Phase 6 Task 5 adds an optional `depsFactory` (default: registerTools' real GitHub +
// Anthropic wiring, unchanged) so a test can drive `mine` through the real MCP tool
// surface with a fake transport/provider instead of forking the pipeline logic.
export function buildServer(
  manager: JobManagerApi = new JobManager(),
  depsFactory?: MineDepsFactory,
): McpServer {
  const server = new McpServer({ name: "prlore", version: "0.0.0" });
  registerTools(server, manager, depsFactory);
  return server;
}

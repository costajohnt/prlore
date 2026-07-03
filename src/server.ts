import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JobManager, type JobManagerApi } from "./jobs/manager.js";
import { registerTools } from "./server-tools.js";

// Phase 1 pinned `buildServer()` (no args) as the default-construction contract —
// that default now boots a real JobManager instead of the old status-only
// JobRegistry stub. Tests inject a JobManagerApi-shaped stub in its place.
export function buildServer(manager: JobManagerApi = new JobManager()): McpServer {
  const server = new McpServer({ name: "prlore", version: "0.0.0" });
  registerTools(server, manager);
  return server;
}

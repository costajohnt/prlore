import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JobRegistry } from "./jobs/registry.js";

export function buildServer(registry: JobRegistry = new JobRegistry()): McpServer {
  const server = new McpServer({ name: "prlore", version: "0.0.0" });

  server.registerTool(
    "status",
    {
      description:
        "Report the state of the current prlore mining job: stage, progress counters, rate-limit budget.",
      inputSchema: { jobId: z.string().optional() },
    },
    async ({ jobId }) => ({
      content: [{ type: "text" as const, text: JSON.stringify(registry.status(jobId)) }],
    }),
  );

  return server;
}

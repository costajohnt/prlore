import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "vitest";
import { buildServer } from "../src/server.js";

async function connectedClient() {
  const server = buildServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("server lists the status tool", async () => {
  const client = await connectedClient();
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("status");
});

test("status returns idle before any job", async () => {
  const client = await connectedClient();
  const res = await client.callTool({ name: "status", arguments: {} });
  const [first] = res.content as { type: string; text: string }[];
  expect(JSON.parse(first!.text)).toEqual({ state: "idle" });
});

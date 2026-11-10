// Connects a real MCP client to createServer() over an in-memory transport, so tests exercise the tools
// through the protocol (schemas, defaults, isError) rather than by calling handlers directly.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../../src/server.js";

export const tempHome = t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "singit-mcp-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "home"); // not created yet: the server must make it itself
};

export async function connect(t, options) {
  const server = createServer(options);
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.map(c => c.text).join("\n");
    let data = null;
    try { data = JSON.parse(text); } catch { /* error results are plain text */ }
    return { isError: Boolean(result.isError), text, data, raw: JSON.stringify(result) };
  };
  return { client, call };
}

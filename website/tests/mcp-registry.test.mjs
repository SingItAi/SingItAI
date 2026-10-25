// The MCP Registry verifies the app.singitai/* namespace by fetching website/.well-known/mcp-registry-auth
// (one "v=MCPv1; k=ed25519; p=<32-byte key>" line, served as text). server.json at the repo root is what
// mcp-publisher submits: its name must sit in that namespace and its remote must be our MCP endpoint.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const website = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(website, "..");

test("mcp-registry-auth holds one Ed25519 public key record", async () => {
  const text = await readFile(path.join(website, ".well-known", "mcp-registry-auth"), "utf8");
  const match = text.match(/^v=MCPv1; k=ed25519; p=([A-Za-z0-9+/]{43}=)\n?$/);
  assert.ok(match, "record must be a single v=MCPv1 ed25519 line");
  assert.equal(Buffer.from(match[1], "base64").length, 32);
});

test("mcp-registry-auth is served as text", async () => {
  const headers = await readFile(path.join(website, "_headers"), "utf8");
  assert.match(headers, /^\/\.well-known\/mcp-registry-auth\n  Content-Type: text\/plain; charset=utf-8$/m);
});

test("server.json names the app.singitai namespace and the live MCP endpoint", async () => {
  const server = JSON.parse(await readFile(path.join(root, "server.json"), "utf8"));
  assert.match(server.name, /^app\.singitai\/[a-z0-9-]+$/);
  assert.ok(server.description.length <= 100, "the Registry rejects descriptions over 100 characters");
  assert.deepEqual(server.remotes.map((remote) => [remote.type, remote.url]),
    [["streamable-http", "https://app.singitai.app/mcp"]]);
});

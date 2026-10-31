// website/llms.txt (llmstxt.org format) must exist at the publish root, start with a top-level heading, and point
// at SingIt Ask's own llms.txt and OpenAPI document so an agent can follow it from the landing to the API.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const website = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("website/llms.txt starts with a heading and links to ask.singitai.app", async () => {
  const text = await readFile(path.join(website, "llms.txt"), "utf8");
  assert.match(text, /^# /);
  assert.match(text, /https:\/\/ask\.singitai\.app\/llms\.txt/);
  assert.match(text, /https:\/\/ask\.singitai\.app\/openapi\.json/);
});

// SI-91 / SI-44: the path free → key → MCP, and the first paid x402 call. Only live claims: every MCP tool named is
// one the MCP server lists, video (unlisted for now) is not offered, and `upto` is described before `exact`.
const repo = path.resolve(website, "..");
const text = await readFile(path.join(website, "llms.txt"), "utf8");
const section = (title) => text.split(`## ${title}\n`)[1]?.split(/\n## /)[0];

test("website/llms.txt starts free, then a key, then MCP, naming only tools the MCP server has", async () => {
  const start = section("Start here: free, then a key, then MCP");
  assert.ok(start, "Start here section");
  assert.match(start, /"free\/deepseek-v4\.1-flash"/);
  assert.match(start, /https:\/\/app\.singitai\.app\/mcp/);
  const mcp = await readFile(path.join(repo, "sign402-gateway", "sign402_gateway", "web_mcp.py"), "utf8");
  const gateway = await readFile(path.join(repo, "sign402-gateway", "sign402_gateway", "server.py"), "utf8");
  const hidden = [...(mcp.match(/MCP_HIDDEN_TOOLS = frozenset\(\{([^}]*)\}\)/)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
  const served = new Set([...mcp.matchAll(/^\s+\{"name": "(\w+)", "description"/gm), ...gateway.matchAll(/"mcpStyleName": "(\w+)"/g)]
    .map((m) => m[1]).filter((name) => !hidden.includes(name)));
  const listed = [...start.matchAll(/^\s+- [^:]+: (.+)$/gm)].filter(([line]) => !/Claude Code|Install guide/.test(line))
    .flatMap(([, names]) => names.replace(/\.$/, "").split(/[,;]\s*|\s+/)).filter((word) => /^[a-z]+(_[a-z0-9]+)+$/.test(word));
  assert.ok(listed.length >= 10, `tools listed: ${listed}`);
  for (const name of listed) assert.ok(served.has(name), `${name} is not an MCP tool`);
  for (const name of served) assert.ok(listed.includes(name), `${name} is missing from llms.txt`);
});

test("website/llms.txt explains the first paid x402 call, upto before exact, with no video route", () => {
  const paid = section("First paid x402 call");
  assert.ok(paid, "First paid x402 call section");
  assert.match(paid, /POST https:\/\/ask\.singitai\.app\/v1\/chat\/completions/);
  assert.match(paid, /402/);
  assert.match(paid, /PAYMENT-SIGNATURE/);
  assert.ok(paid.indexOf("`upto`") >= 0 && paid.indexOf("`upto`") < paid.indexOf("`exact`"));
  assert.match(paid, /flat price for a typical-length answer \(about 30% of max_tokens\)/);
  assert.match(paid, /https:\/\/github\.com\/SingItAi\/SingItAI\/blob\/main\/docs\/first-paid-call\.md/);
  assert.ok(!/video/i.test(text));
  assert.ok(!text.includes("when enabled"));
});

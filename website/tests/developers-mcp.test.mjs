// /developers lists the MCP server as Live and has an MCP quickstart tab: Claude Code and mcp.json setups, and
// an "Add to Cursor" deeplink whose config is exactly the keyless remote server (a key placeholder in it would
// be sent as a wrong key and get a 401, where no key at all still serves the free tools).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const website = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(path.join(website, "developers", "index.html"), "utf8");
const MCP_URL = "https://app.singitai.app/mcp";

test("the MCP server is listed as Live, not Soon", () => {
  const item = html.match(/<li><span class="status[^"]*">([^<]+)<\/span><b>An MCP server<\/b>/);
  assert.ok(item, "MCP entry in the works list");
  assert.equal(item[1], "Live");
});

test("the MCP tab is wired to its panel and carries both setups", () => {
  assert.match(html, /role="tab" id="tab-mcp" aria-controls="panel-mcp"/);
  const panel = html.match(/<section class="tab-panel" role="tabpanel" id="panel-mcp"[\s\S]*?<\/section>/)?.[0];
  assert.ok(panel, "panel-mcp");
  assert.ok(panel.includes(`claude mcp add --transport http singit ${MCP_URL}`));
  assert.ok(panel.includes(`"url": "${MCP_URL}"`));
  assert.ok(panel.includes('data-copy="code-mcp"') && panel.includes('id="code-mcp"'));
});

test("Add to Cursor installs the keyless remote server", () => {
  const href = html.match(/href="(cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?[^"]+)"/)?.[1];
  assert.ok(href, "Add to Cursor deeplink");
  const params = new URL(href.replaceAll("&amp;", "&")).searchParams;
  assert.equal(params.get("name"), "singit");
  assert.deepEqual(JSON.parse(Buffer.from(params.get("config"), "base64").toString()), { url: MCP_URL });
});

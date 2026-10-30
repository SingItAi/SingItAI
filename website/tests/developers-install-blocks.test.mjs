import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { init } from "../dev.mjs";

const website = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(path.join(website, "developers", "index.html"), "utf8");
const install = html.match(/<section[^>]*id="install"[^>]*>[\s\S]*?<\/section>/)?.[0];
const MCP = "https://app.singitai.app/mcp";

test("install follows quickstart, precedes Works with and covers five tools", () => {
  assert.ok(install);
  assert.ok(html.indexOf('id="quickstart"') < html.indexOf(install));
  assert.ok(html.indexOf(install) < html.indexOf('id="works"'));
  assert.match(install, /<h2[^>]*>Install in your tool<\/h2>/);
  assert.deepEqual([...install.matchAll(/<h3>(.*?)<\/h3>/g)].map(m => m[1]),
    ["Claude Code", "Cursor", "Codex", "LangChain (JS)", "Vercel AI SDK"]);
});

test("all copy buttons have unique targets, including every install snippet", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, target] of html.matchAll(/data-copy="([^"]+)"/g)) assert.ok(ids.includes(target), target);
  for (const [, id] of install.matchAll(/<code id="([^"]+)"/g)) assert.ok(install.includes(`data-copy="${id}"`), id);
});

test("status labels remain exactly as before and install has no status pills", () => {
  const labels = text => [...text.matchAll(/<span class="status[^\"]*">[^<]*<\/span>/g)].map(m => m[0]);
  // Counts read from HEAD before SI-70; keep existing labels unchanged.
  assert.equal(labels(html).filter(s => s.includes('is-live')).length, 13);
  assert.equal(labels(html).filter(s => s.includes('>Live</span>')).length, 11);
  assert.equal(labels(html).filter(s => s.includes('>Live · free</span>')).length, 2);
  assert.equal(labels(html).filter(s => s.includes('>Soon</span>')).length, 2);
  assert.equal(labels(html).length, 15);
  assert.deepEqual(labels(install), []);
});

test("install has no contract claims, video or wallet addresses", () => {
  assert.doesNotMatch(install, /AgentAllowance|\bvideo\b|0x[0-9a-f]{40}\b/i);
  assert.match(install, /evmPrivateKey: process.env.AGENT_PRIVATE_KEY/);
  assert.equal((install.match(/limits are enforced in your code before anything is signed/g) ?? []).length, 3);
  assert.match(install, /@singitai\/sdk is released by the maintainer; until it appears on npm, use the repo checkout \(sdk\/typescript\)\./);
});

test("every Cursor deeplink still installs exactly the keyless remote server", () => {
  const links = [...install.matchAll(/href="(cursor:[^"]+)"/g)];
  assert.equal(links.length, 1);
  for (const [, href] of html.matchAll(/href="(cursor:[^"]+)"/g)) {
    const params = new URL(href.replaceAll("&amp;", "&")).searchParams;
    assert.equal(params.get("name"), "singit");
    assert.deepEqual(JSON.parse(Buffer.from(params.get("config"), "base64").toString()), { url: MCP });
  }
});

test("copy wiring registers buttons outside tab panels", () => {
  let registered = false;
  const button = { addEventListener(event, callback) { assert.equal(event, "click"); assert.equal(typeof callback, "function"); registered = true; } };
  // No tabs or live-price widgets: this document still receives copy handling.
  init({ querySelectorAll(selector) { return selector === "[data-copy]" ? [button] : []; }, querySelector() { return null; } });
  assert.ok(registered);
});

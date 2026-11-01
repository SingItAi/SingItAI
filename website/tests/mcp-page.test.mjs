import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generate, renderTools } from '../../scripts/generate-mcp-page.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = file => readFileSync(path.join(root, file), 'utf8');
const html = read('website/docs/mcp/index.html');
const data = JSON.parse(read('website/data/mcp-tools.json'));
const decode = s => s.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
test('MCP snapshot has exactly the served and Start here tool names', () => {
  const mcp = read('sign402-gateway/sign402_gateway/web_mcp.py');
  const gateway = read('sign402-gateway/sign402_gateway/server.py');
  const hidden = [...(mcp.match(/MCP_HIDDEN_TOOLS = frozenset\(\{([^}]*)\}\)/)?.[1] ?? '').matchAll(/"(\w+)"/g)].map(m => m[1]);
  const served = new Set([...mcp.matchAll(/^\s+\{"name": "(\w+)", "description"/gm), ...gateway.matchAll(/"mcpStyleName": "(\w+)"/g)].map(m => m[1]).filter(n => !hidden.includes(n)));
  const start = read('website/llms.txt').split('## Start here: free, then a key, then MCP\n')[1].split(/\n## /)[0];
  const listed = [...start.matchAll(/^\s+- [^:]+: (.+)$/gm)].filter(([line]) => !/Claude Code|Install guide/.test(line)).flatMap(([, names]) => names.replace(/\.$/, '').split(/[,;]\s*|\s+/)).filter(word => /^[a-z]+(_[a-z0-9]+)+$/.test(word));
  const names = data.result.tools.map(t => t.name);
  assert.equal(names.length, 16);
  assert.equal(new Set(names).size, 16);
  assert.deepEqual([...names].sort(), [...served].sort());
  assert.deepEqual([...names].sort(), [...new Set(listed)].sort());
  assert.equal(data.fetchedAt, '2026-10-31T09:27:44Z');
  assert.equal(data.source, 'https://app.singitai.app/mcp tools/list, server version 0.1.3');
  for (const t of data.result.tools) {
    assert.deepEqual(Object.keys(t).sort(), ['annotations', 'description', 'inputSchema', 'name']);
    assert.equal(typeof t.description, 'string');
  }
});
test('MCP generator check and schema-derived table', async () => {
  await generate(true);
  assert.ok(html.includes(renderTools(data)));
  assert.equal((html.match(/<th scope="row">/g) ?? []).length, 16);
  for (const t of data.result.tools) {
    assert.ok(html.includes(`<code>${t.name}</code>`));
    for (const [name, schema] of Object.entries(t.inputSchema.properties ?? {})) {
      assert.ok(html.includes(`<code>${name}</code>: ${schema.type}, ${(t.inputSchema.required ?? []).includes(name) ? 'required' : 'optional'}`));
    }
  }
  const synthetic = structuredClone(data);
  synthetic.result.tools[0].description = '<script>alert("x")</script>. Second sentence.';
  assert.ok(renderTools(synthetic).includes('&lt;script&gt;'));
  assert.ok(!renderTools(synthetic).includes('Second sentence.'));
  const table = renderTools(data);
  for (const row of table.matchAll(/<tr><th scope="row">([\s\S]*?)<\/tr>/g)) {
    const text = decode(row[1]);
    const name = text.match(/<code>(\w+)<\/code>/)[1];
    if (['web_search', 'read_page'].includes(name)) assert.match(text, /search<\/td><td>USDC on Base or Solana/);
    else if (!['get_price', 'list_price_symbols', 'list_models', 'get_balance', 'get_limits', 'get_receipts'].includes(name)) assert.match(text, /tools<\/td><td>USDC on Base only for now/);
  }
});
test('MCP metadata, sitemap and public content constraints', () => {
  const title = html.match(/<title>([^<]+)<\/title>/)[1];
  const desc = html.match(/<meta name="description" content="([^"]+)"/)[1];
  assert.ok(title.length <= 60 && title.length > 0);
  for (const file of readdirSync(path.join(root, 'website'), { recursive: true })) {
    if (!file.endsWith('.html') || file === 'docs/mcp/index.html') continue;
    assert.notEqual(read(`website/${file}`).match(/<title>([^<]+)<\/title>/)?.[1], title, `duplicate title in ${file}`);
  }
  assert.ok(desc.length <= 155 && desc.length > 0);
  assert.match(html, /<link rel="canonical" href="https:\/\/singitai.app\/docs\/mcp\/">/);
  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const page = graph['@graph'].find(n => n['@type'] === 'WebPage');
  assert.equal(page.name, title); assert.equal(page.description, desc);
  assert.equal(page.url, 'https://singitai.app/docs/mcp/');
  assert.ok(graph['@graph'].some(n => n['@type'] === 'BreadcrumbList'));
  assert.match(read('website/sitemap.xml'), /<loc>https:\/\/singitai.app\/docs\/mcp\/<\/loc>/);
  assert.doesNotMatch(html + JSON.stringify(data), /video|no admin|0x[0-9a-fA-F]{40}|other.{0,35}agents.{0,35}AgentAllowance/i);
  for (const match of html.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
    const target = match[1].split(/[?#]/)[0];
    assert.ok(existsSync(path.join(root, 'website', target, target.endsWith('/') ? 'index.html' : '')), target);
  }
});
test('Every snippet has verification status and required client configuration', () => {
  const snippets = [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)];
  assert.equal(snippets.length, 10);
  for (const match of snippets) {
    const before = html.slice(0, match.index);
    assert.ok(before.lastIndexOf('Verification:') > before.lastIndexOf('</pre>'));
  }
  const decoded = decode(html);
  assert.ok(decoded.includes("claude mcp add --transport http singit https://app.singitai.app/mcp --header 'Authorization: Bearer ${SINGIT_API_KEY}'"));
  assert.ok(decoded.includes('codex mcp add singit --url https://app.singitai.app/mcp --bearer-token-env-var SINGIT_API_KEY'));
  assert.ok(decoded.includes('[mcp_servers.singit]\nurl = "https://app.singitai.app/mcp"\nbearer_token_env_var = "SINGIT_API_KEY"'));
  assert.match(decoded, /"type": "http"/);
  assert.match(decoded, /"serverUrl":"https:\/\/app.singitai.app\/mcp"/);
  const deeplink = html.match(/href="(cursor:\/\/[^"]+)"/)[1];
  assert.ok(read('website/developers/index.html').includes(`href="${deeplink}"`));
  const generic = read('llms-install.md').match(/```json\n([\s\S]*?)\n```/)[1];
  assert.ok(decoded.includes(generic));
  for (const method of ['initialize', 'tools/list']) assert.ok(decoded.includes(`"method":"${method}"`));
});

test('MCP initialize expectation is independent of the deployed version', () => {
  assert.ok(html.includes('Expected: initialize returns serverInfo name singit and title SingIt x402; tools/list returns 16 tools.'));
  assert.doesNotMatch(html, /Expected: initialize returns serverInfo\.version/);
});

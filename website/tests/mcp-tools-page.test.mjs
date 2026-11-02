import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generate, renderToolsReference, renderGroupOverview } from '../../scripts/generate-mcp-tools-page.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = file => readFileSync(path.join(root, file), 'utf8');
const html = read('website/docs/mcp-tools/index.html');
const data = JSON.parse(read('website/data/mcp-tools.json'));
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
test('reference generation, ordered sections and complete parameter schemas', async () => {
  await generate(true);
  const rendered = renderToolsReference(data);
  assert.ok(html.includes(rendered));
  assert.deepEqual([...rendered.matchAll(/<h3 id="([^"]+)">/g)].map(m => m[1]), data.result.tools.map(t => t.name));
  for (const tool of data.result.tools) {
    const section = rendered.split(`<h3 id="${tool.name}">`)[1].split('<h3')[0];
    assert.ok(section.includes(escape(tool.description)));
    assert.ok(section.includes(`readOnlyHint: ${tool.annotations.readOnlyHint}`));
    assert.ok(section.includes(`idempotentHint: ${tool.annotations.idempotentHint}`));
    const properties = Object.entries(tool.inputSchema.properties ?? {});
    if (!properties.length) assert.ok(section.includes('Parameters: None'));
    for (const [name, schema] of properties) {
      const row = section.split(`<tr><th scope="row"><code>${name}</code>`)[1].split('</tr>')[0];
      assert.ok(row.includes(`<td>${schema.type}</td>`));
      assert.ok(row.includes(`<td>${(tool.inputSchema.required ?? []).includes(name) ? 'required' : 'optional'}</td>`));
      for (const v of schema.enum ?? []) assert.ok(row.includes(`<code>${escape(v)}</code>`));
      if (schema.description) assert.ok(row.includes(escape(schema.description)));
      for (const k of ['minimum', 'maximum']) if (schema[k] !== undefined) assert.ok(row.includes(`${k}: ${schema[k]}`));
    }
  }
  const overview = renderGroupOverview(data);
  assert.ok(html.includes(overview));
  assert.deepEqual([...overview.matchAll(/<code>([^<]+)<\/code>/g)].map(m => m[1]), data.result.tools.map(t => t.name));
  assert.equal((overview.match(/<th scope="row">/g) ?? []).length, 5);
  const synthetic = structuredClone(data);
  synthetic.result.tools[0].description = '<script>alert("x")</script>';
  synthetic.result.tools[0].inputSchema.properties.kind.description = '<script>parameter</script>';
  const injected = renderToolsReference(synthetic);
  assert.ok(injected.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.ok(injected.includes('&lt;script&gt;parameter&lt;/script&gt;'));
  assert.doesNotMatch(injected, /<script>/);
  assert.doesNotMatch(rendered, /\$0\./);
});
test('reference metadata, discovery links and local targets', () => {
  const title = html.match(/<title>([^<]+)<\/title>/)[1];
  const desc = html.match(/<meta name="description" content="([^"]+)"/)[1];
  assert.equal(title, 'SingIt MCP tools reference: 18 tools | SingIt');
  assert.ok(title.length <= 60 && desc.length > 0 && desc.length <= 155);
  for (const file of readdirSync(path.join(root, 'website'), { recursive: true })) {
    if (file.endsWith('.html') && file !== 'docs/mcp-tools/index.html') assert.notEqual(read(`website/${file}`).match(/<title>([^<]+)<\/title>/)?.[1], title, file);
  }
  const url = 'https://singitai.app/docs/mcp-tools/';
  assert.ok(html.includes(`<link rel="canonical" href="${url}">`));
  for (const [key, value] of [['title', title], ['description', desc], ['url', url]]) assert.ok(html.includes(`<meta property="og:${key}" content="${value}">`));
  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
  const page = graph.find(n => n['@type'] === 'WebPage');
  assert.equal(page.name, title); assert.equal(page.description, desc); assert.equal(page.url, url);
  const crumbs = graph.find(n => n['@type'] === 'BreadcrumbList').itemListElement;
  assert.deepEqual(crumbs.map(n => n.name), ['Developers', 'MCP', 'Tools reference']);
  assert.equal(crumbs.at(-1).item, url);
  assert.ok(read('website/sitemap.xml').includes(`<loc>${url}</loc>`));
  for (const file of ['docs/index.html', 'docs/mcp/index.html']) assert.ok(read(`website/${file}`).includes('href="/docs/mcp-tools/"'));
  assert.ok(read('website/llms.txt').includes(`   - Tool reference (all 18 tools, parameters, scopes): ${url}`));
  for (const [, target] of html.matchAll(/(?:href|src)="([^" ]+)"/g)) {
    if (target.startsWith('#')) { assert.ok(html.includes(`id="${target.slice(1)}"`)); continue; }
    if (!target.startsWith('/')) continue;
    const pathname = target.split(/[?#]/)[0];
    assert.ok(existsSync(path.join(root, 'website', pathname, pathname.endsWith('/') ? 'index.html' : '')), target);
  }
});
test('reference spending boundary and content restrictions', () => {
  assert.ok(html.includes("The key's daily and per-request caps are enforced by SingIt's server for calls made with that key to SingIt's MCP and the same key's /v1 endpoint. They do not limit what an agent spends anywhere else. SingIt's contracts do not protect other people's agents' own wallets."));
  assert.doesNotMatch(html, /video|cheaper|telegram|0x[0-9a-f]{40}/i);
  const block = html.split('<!-- generated:mcp-tools-reference:start -->')[1].split('<!-- generated:mcp-tools-reference:end -->')[0];
  assert.doesNotMatch(block, /\$0\./);
});

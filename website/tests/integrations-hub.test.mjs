import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const site = fileURLToPath(new URL('../', import.meta.url));
const page = readFileSync(path.join(site, 'integrations/index.html'), 'utf8');
const unescape = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#x27);/gi, (_, e) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[e] ?? (e.startsWith('#x') ? String.fromCodePoint(parseInt(e.slice(2),16)) : String.fromCodePoint(Number(e.slice(1))))));
test('integration metadata, structured data and sitemap', () => {
  const title = page.match(/<title>(.*?)<\/title>/)[1];
  const description = page.match(/name="description" content="([^"]*)"/)[1];
  assert.ok(title.length > 0 && title.length <= 60);
  assert.ok(description.length > 0 && description.length <= 155);
  for (const dir of readdirSync(site, {withFileTypes:true}).filter(d=>d.isDirectory() && d.name !== 'integrations')) {
    const file = path.join(site, dir.name, 'index.html');
    if (existsSync(file)) assert.ok(!readFileSync(file,'utf8').includes(`<title>${title}</title>`));
  }
  const url = 'https://singitai.app/integrations/';
  assert.ok(page.includes(`<link rel="canonical" href="${url}">`));
  const graph = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
  const web = graph.find(x=>x['@type']==='WebPage');
  assert.equal(web.url,url); assert.equal(web.name,title); assert.equal(web.description,description);
  const crumbs = graph.find(x=>x['@type']==='BreadcrumbList');
  assert.equal(crumbs.itemListElement.at(-1).item,url);
  assert.ok(!graph.some(x=>x['@type']==='FAQPage'));
  assert.ok(readFileSync(path.join(site,'sitemap.xml'),'utf8').includes(`<loc>${url}</loc>`));
});
test('every exact snippet has its own verification label', () => {
  const files = readdirSync(path.join(site,'data/integration-snippets')).sort();
  const blocks = [...page.matchAll(/<article data-snippet="([^"]+)">([\s\S]*?)<\/article>/g)];
  assert.equal(blocks.length,10);
  assert.deepEqual(blocks.map(m=>m[1]).sort(), files);
  assert.equal([...page.matchAll(/<code(?:\s[^>]*)?>/g)].length,files.length);
  for (const [,file,body] of blocks) {
    assert.match(body,/<strong>(?:Verified|Not tested)<\/strong>/);
    assert.match(body,/31 October 2026/);
    assert.match(body,/Result: (?:pong|16 MCP tools)/);
    const code = unescape(body.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)[1]);
    assert.equal(code,readFileSync(path.join(site,'data/integration-snippets',file),'utf8'),file);
    for (const match of code.matchAll(/(?:apiKey|api_key)\s*[:=]\s*["']([^"']+)["']/g)) assert.equal(match[1],'unused');
    assert.doesNotMatch(code,/\bsk-[A-Za-z0-9_-]+/);
  }
});
test('links resolve and vendors use https', () => {
  const source = readFileSync(path.join(site,'../docs/integrations-hub-sources.md'),'utf8');
  const vendors = source.split('## Vendor URLs')[1].split('## Claim sources')[0].match(/https:\/\/[^\s|]+/g);
  assert.equal(vendors.length,13);
  for (const url of vendors) assert.ok(page.includes(`href="${url}"`));
  for (const [,raw] of page.matchAll(/href="([^"]+)"/g)) {
    const url = unescape(raw);
    if (url.startsWith('#')) continue;
    if (url.startsWith('/')) {
      const pathname = url.split(/[?#]/)[0];
      assert.ok(!pathname.startsWith('/docs/'));
      const local = path.join(site,pathname.endsWith('/') ? pathname+'index.html' : pathname);
      assert.ok(existsSync(local),url);
    } else {
      assert.ok(url.startsWith('https://'),url);
      if (url.startsWith('https://github.com/SingItAi/SingItAI/')) {
        assert.ok(url.startsWith('https://github.com/SingItAi/SingItAI/blob/main/'));
        const relative = url.split('/blob/main/')[1].split('#')[0];
        assert.ok(existsSync(path.join(site,'..',relative)),relative);
      }
    }
  }
});
test('honest status and forbidden text', () => {
  assert.doesNotMatch(page,/video|no admin|0x[0-9a-fA-F]{40}/i);
  assert.doesNotMatch(page,/AgentAllowance[^<]*(?:other|every|all) agents/i);
  assert.doesNotMatch(page,/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
  for (const id of ['agentkit','elizaos']) {
    const section = page.match(new RegExp(`<section[^>]*id="${id}"[^>]*>([\\s\\S]*?)</section>`))[1];
    assert.match(section,/Not tested/);
    assert.doesNotMatch(section,/<pre>/);
  }
  assert.match(page,/That exact variant was not run/);
  assert.match(page,/Not tested:<\/strong> paid x402 payment/);
  assert.match(page,/Not published to npm; install from a Git checkout/);
});

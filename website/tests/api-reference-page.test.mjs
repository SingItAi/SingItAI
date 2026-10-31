import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const site = fileURLToPath(new URL('../', import.meta.url));
const html = readFileSync(path.join(site, 'docs/api/index.html'), 'utf8');
const canonical = 'https://singitai.app/docs/api/';

test('API reference has complete metadata, structured data and sitemap entry', () => {
  const title = html.match(/<title>([^<]+)<\/title>/)[1];
  const description = html.match(/<meta name="description" content="([^"]+)"/)[1];
  assert.ok(title.length <= 60 && description.length <= 155);
  assert.match(html, /<html lang="en">/);
  assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`));
  assert.ok(html.includes(`<meta property="og:url" content="${canonical}">`));
  assert.match(html, /name="twitter:card"/);
  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(graph['@context'], 'https://schema.org');
  const page = graph['@graph'].find(n => n['@type'] === 'WebPage');
  assert.equal(page.url, canonical);
  assert.equal(page.name, title);
  assert.equal(page.description, description);
  const crumbs = graph['@graph'].find(n => n['@type'] === 'BreadcrumbList').itemListElement;
  assert.deepEqual(crumbs.map(n => n.position), [1, 2]);
  assert.equal(crumbs.at(-1).item, canonical);
  assert.ok(!graph['@graph'].some(n => n['@type'] === 'FAQPage'));
  const sitemap = readFileSync(path.join(site, 'sitemap.xml'), 'utf8');
  assert.equal(sitemap.split(`<loc>${canonical}</loc>`).length - 1, 1);
  assert.ok(sitemap.indexOf(`<loc>${canonical}</loc>`) < sitemap.indexOf('<!-- generated:model-pages:start -->'));
  function pages(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() && !['tests', 'node_modules'].includes(e.name) ? pages(path.join(dir, e.name)) : e.isFile() && e.name.endsWith('.html') ? [path.join(dir, e.name)] : []); }
  for (const other of pages(site)) if (other !== path.join(site, 'docs/api/index.html')) {
    assert.notEqual(readFileSync(other, 'utf8').match(/<title>([^<]+)<\/title>/)?.[1], title);
  }
});

test('API reference links resolve and public copy follows content rules', () => {
  assert.doesNotMatch(html, /video|no admin|0x[0-9a-fA-F]{40}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/i);
  assert.doesNotMatch(html, /AgentAllowance|run by bots|AI team/i);
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const url = new URL(match[1].replace(/&amp;/g, '&'), canonical);
    if (url.origin !== 'https://singitai.app') continue;
    if (['/.well-known/x402', '/openapi.json'].includes(url.pathname)) continue; // tested redirect rules
    const file = path.join(site, decodeURIComponent(url.pathname));
    assert.ok(existsSync(file.endsWith('/') ? path.join(file, 'index.html') : file), url.pathname);
  }
  assert.ok(html.includes('https://github.com/bubon-ik/SingItAI/blob/main/singit-ask/ERRORS.md'));
  assert.ok(!html.includes('/docs/errors/'));
});

test('API reference distinguishes specs, health fields and example verification', () => {
  for (const text of ['https://ask.singitai.app/openapi.json', '/openapi-keys.json', 'https://app.singitai.app/v1', 'https://ask.singitai.app/v1', '$SINGIT_API_KEY', 'x-api-key', 'models_summary', 'windowHours', 'attempts', 'lastOutcome', 'sellerFailures', 'failureReasons', 'reason', 'up', 'degraded', 'down', 'insufficient_data', 'unavailable', '/status/', '/llms.txt']) assert.ok(html.includes(text), text);
  const blocks = [...html.matchAll(/<pre><code data-verification="([^"]+)">([\s\S]*?)<\/code><\/pre>/g)];
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0][1], 'repository-unpaid-probe');
  assert.equal(blocks[1][1], 'illustrative-not-run');
  const guide = readFileSync(path.join(site, '../docs/first-paid-call.md'), 'utf8');
  assert.ok(guide.includes(blocks[0][2]));
  assert.ok(blocks[1][2].includes('Bearer $SINGIT_API_KEY'));
  assert.match(html, /was not rerun/);
});

import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';
import { ERROR_CODES, defaultErrorCode } from '../../singit-ask/src/errors.mjs';
const site = new URL('../', import.meta.url);
const slugs = ['', 'errors', 'limits', 'payments', 'security', 'faq', 'mcp-key'];
const read = p => readFile(new URL(p, site), 'utf8');
const text = s => s.replace(/<[^>]*>/g, '').replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replace(/\s+/g, ' ').trim();
const nodes = html => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
test('docs metadata, schema, sitemap, tracking and links', async () => {
  const sitemap = await read('sitemap.xml');
  const llms = await read('llms.txt');
  const template = await read('x402-llm-api/index.html');
  const tracker = template.match(/<script defer src="https:\/\/stats\.singitai\.app\/s\.js"[^>]*><\/script>/)[0];
  const titles = new Set(), descriptions = new Set();
  for (const slug of slugs) {
    const path = `docs/${slug ? slug + '/' : ''}`;
    const html = await read(path + 'index.html');
    const title = text(html.match(/<title>(.*?)<\/title>/)[1]);
    const description = html.match(/<meta name="description" content="([^"]+)"/)[1];
    assert.ok(title.length > 0 && title.length <= 60);
    assert.ok(description.length > 0 && description.length <= 155);
    assert.ok(!titles.has(title)); titles.add(title);
    assert.ok(!descriptions.has(description)); descriptions.add(description);
    const canonical = `https://singitai.app/${path}`;
    assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`));
    assert.ok(html.includes(`<meta property="og:url" content="${canonical}">`));
    assert.ok(html.includes('name="twitter:card"'));
    assert.ok(sitemap.includes(`<loc>${canonical}</loc>`));
    assert.ok(llms.includes(canonical));
    const graph = nodes(html);
    const page = graph.find(n => n['@type'] === 'WebPage');
    assert.equal(page.url, canonical); assert.equal(page.name, title); assert.equal(page.description, description);
    const crumbs = graph.find(n => n['@type'] === 'BreadcrumbList').itemListElement;
    assert.equal(crumbs.at(-1).item, canonical);
    assert.equal(graph.some(n => n['@type'] === 'FAQPage'), slug === 'faq');
    assert.equal(html.split(tracker).length - 1, 1);
    assert.ok(html.indexOf(tracker) < html.indexOf('</head>'));
    assert.doesNotMatch(html, /video|no admin|0x[0-9a-fA-F]{40}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b|other (?:people.s )?agents.{0,50}(?:protect|limit)|\/docs\/(?:quickstart|mcp)\//i);
    for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^(?:https?:|mailto:|#)/.test(href)) continue;
      const target = new URL(href.replaceAll('&amp;', '&'), canonical);
      const pathname = decodeURIComponent(target.pathname);
      const file = new URL('.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''), site);
      assert.ok((await stat(file)).isFile(), `${path}: ${href}`);
    }
    for (const [, attrs] of html.matchAll(/<pre><code([^>]*)>/g)) assert.match(attrs, /data-verification="(?:live-2026-10-31|source-schema)"/);
  }
});
test('docs error vocabulary exactly matches dependency-free API source', async () => {
  const html = await read('docs/errors/index.html');
  const codes = [...html.matchAll(/data-error-code="([a-z_]+)"/g)].map(m => m[1]);
  assert.deepEqual(codes.sort(), [...ERROR_CODES].sort());
  for (const status of [400, 401, 402, 403, 404, 409, 413, 422, 429, 502, 503, 504, 500]) {
    assert.ok(codes.includes(defaultErrorCode(status)));
    assert.ok(html.includes(String(status)));
  }
  for (const code of ['invalid_json', 'not_found', 'payment_required']) assert.ok(html.includes(`&quot;${code}&quot;`));
  for (const schema of ['ErrorResponse', 'AnthropicErrorResponse', 'PaymentRequired402', 'RateLimited429']) assert.ok(html.includes(schema));
});
test('FAQPage matches every visible question and answer word for word', async () => {
  const html = await read('docs/faq/index.html');
  const questions = [...html.matchAll(/<dt><h3>([\s\S]*?)<\/h3><\/dt>/g)].map(m => text(m[1]));
  const answers = [...html.matchAll(/<dd class="faq-answer">([\s\S]*?)<\/dd>/g)].map(m => text(m[1]));
  assert.ok(questions.length >= 8 && questions.length <= 10);
  assert.equal(questions.length, answers.length);
  assert.deepEqual(nodes(html).find(n => n['@type'] === 'FAQPage').mainEntity.map(q => [q.name, q.acceptedAnswer.text]), questions.map((q, i) => [q, answers[i]]));
});
test('llms error guide uses current code metadata and all table codes exist', async () => {
  const errors = (await read('llms.txt')).split('## Errors\n')[1].split('## For developers')[0];
  assert.doesNotMatch(errors, /no universal|No uniform|may omit error.code/);
  for (const field of ['error.code', 'top-level code', 'accepts', 'x402Version', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After: 5']) assert.ok(errors.includes(field));
  const rows = errors.split('\n').filter(l => /^\| \d/.test(l));
  for (const row of rows) for (const code of row.split('|')[2].trim().split(', ')) assert.ok(ERROR_CODES.includes(code), code);
});

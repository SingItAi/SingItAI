import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const page = read('website/docs/quickstart/index.html');
const sources = read('docs/quickstart-sources.md');
const guide = read('docs/first-paid-call.md');
const decode = s => s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&amp;', '&');
test('quickstart metadata, structured data and sitemap', () => {
  const title = page.match(/<title>(.*?)<\/title>/)[1];
  assert.ok(title.length <= 60);
  assert.equal(title, 'Quickstart in 5 minutes | SingIt');
  const description = page.match(/name="description" content="([^"]+)"/)[1];
  assert.ok(description.length <= 155);
  const url = 'https://singitai.app/docs/quickstart/';
  assert.ok(page.includes(`<link rel="canonical" href="${url}">`));
  const graph = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
  assert.equal(graph.find(x => x['@type'] === 'WebPage').url, url);
  assert.equal(graph.find(x => x['@type'] === 'WebPage').description, description);
  assert.equal(graph.find(x => x['@type'] === 'BreadcrumbList').itemListElement.at(-1).item, url);
  assert.ok(read('website/sitemap.xml').includes(`<loc>${url}</loc>`));
  assert.equal((page.match(/data-website-id=/g) || []).length, 1);
});
test('quickstart text restrictions and local links', () => {
  assert.doesNotMatch(page, /video|no admin|0x[0-9a-fA-F]{40}/i);
  assert.doesNotMatch(page, /AgentAllowance/i);
  const allowed = ['/developers/', '/models/', '/pricing/', '/agent-spending-limits/'];
  for (const [, href] of page.matchAll(/href="([^"]+)"/g)) {
    if (href.startsWith('#')) {
      assert.ok(page.includes(`id="${href.slice(1)}"`));
    } else if (href.startsWith('/')) {
      const path = href.split(/[?#]/)[0];
      assert.ok(existsSync(new URL('../../website' + path + (path.endsWith('/') ? 'index.html' : ''), import.meta.url)), path);
      if (path.endsWith('/')) assert.ok(allowed.includes(path), path);
    }
  }
});
test('historically verified snippets are labelled and sourced; A stays verbatim', () => {
  const ids = [];
  for (const [, id, code] of page.matchAll(/<code id="([^"]+)" data-verified="true">([\s\S]*?)<\/code>/g)) {
    ids.push(id);
    assert.ok(sources.includes('`' + id + '`'), id);
    assert.ok(page.includes(`href="#${id}"`), 'visible verified label for ' + id);
    if (id !== 'cli-free') assert.ok(guide.includes(decode(code)), id + ' copied from guide');
  }
  assert.deepEqual(ids, ['unpaid-curl', 'decode-offers', 'install-a', 'paid-a', 'install-b', 'cli-free']);
  const install = guide.match(/npm install @coinbase[^\n]+/)[0];
  assert.ok(install.includes('@x402/extensions') && install.includes('@x402/svm'));
});
test('retry distinctions and B/C status remain explicit', () => {
  for (const text of ['payment_duplicate', 'stale_payment_permit', 'no PAYMENT-REQUIRED header', 'maxPerCall', 'billing.totalAtomic', 'X-SingIt-Receipt', 'curatedOnly:false', 'ERR_MODULE_NOT_FOUND', 'Node 24.22.1', 'What was run on 31.10.2026 (Prague)', 'Not run:']) assert.ok(page.includes(text), text);
  assert.doesNotMatch(page, /x402_post_https___ask_singitai_app_v1_chat_completions_[a-z0-9]/i);
});

test('the page has no double-escaped HTML entities', () => {
  const html = readFileSync(new URL('../docs/quickstart/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /&amp;(#\d+|#x[0-9a-f]+|quot|lt|gt|apos);/i);
});

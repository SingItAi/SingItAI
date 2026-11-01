import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(path.join(site, p), 'utf8');
const html = read('terms/index.html');
const canonical = 'https://singitai.app/terms/';
const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');

function pages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() && !['tests', 'node_modules'].includes(e.name) ? pages(path.join(dir, e.name))
      : e.isFile() && e.name.endsWith('.html') ? [path.join(dir, e.name)] : []);
}

test('terms page has metadata, schema and one sitemap entry', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Terms of Service \| SingIt<\/title>/);
  assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`));
  assert.ok(html.includes(`<meta property="og:url" content="${canonical}">`));
  const page = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(page.url, canonical);
  assert.equal(page.name, 'Terms of Service | SingIt');
  assert.equal(read('sitemap.xml').split(`<loc>${canonical}</loc>`).length - 1, 1);
});

test('terms page states the operator without inventing a company', () => {
  assert.match(text, /SingIt \(\s*&ldquo;SingIt&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;\s*\) operates this service from Prague, Czech Republic/);
  assert.doesNotMatch(text, /operated by (Kostiantyn|an individual)/i);
  assert.match(text, /not operated by a registered company/);
  assert.doesNotMatch(text, /\b(s\.r\.o|Ltd|LLC|Inc\.|GmbH|IČO|ICO|VAT)\b/i);
  assert.ok(!html.includes('⟦'), 'no unfilled placeholder');
  assert.ok(!/@proton\.me/.test(html));
});

test('no personal name appears on the terms or privacy pages or in agent-facing files', () => {
  const name = /kostiantyn|kostya|kostia|konstantin|zubarev|zubarov|зубарев|костя|костянтин|константин/i;
  for (const file of ['terms/index.html', 'privacy/index.html', 'llms.txt', 'llms-full.txt', 'llms-models.txt', 'SKILL.md']) {
    assert.doesNotMatch(read(file), name, `${file} names a person`);
  }
  assert.ok(html.includes('mailto:contact@singitai.app'));
});

test('terms page matches how SingIt works', () => {
  for (const phrase of [/USDC on Base or Solana/, /HTTP 402/, /cannot be reversed/, /&ldquo;as is&rdquo;/,
    /Acceptable use/, /18 and over/, /SPL delegate/, /limiter contract deployed for you enforces/]) assert.match(html, phrase);
  assert.ok(html.includes('href="/privacy/"'));
  assert.ok(html.includes('mailto:contact@singitai.app'));
});

test('terms allow lawful adult content and only prohibit illegal content', () => {
  assert.match(text, /Lawful adult \(18\+\) content is allowed/);
  assert.match(text, /CSAM/);
  assert.match(text, /without that person&rsquo;s consent/);
  assert.doesNotMatch(text, /No adult content/i);
  assert.doesNotMatch(text, /not a service for producing 18\+ content/i);
});

test('every page that links the privacy policy in its footer also links the terms', () => {
  let n = 0;
  for (const file of pages(site)) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('<a href="https://singitai.app/privacy/" target="_blank" rel="noopener">Privacy policy</a>')) continue;
    n += 1;
    assert.ok(src.includes('<a href="https://singitai.app/terms/" target="_blank" rel="noopener">Terms</a>'),
      `${path.relative(site, file)} has no Terms footer link`);
  }
  assert.ok(n > 200);
});

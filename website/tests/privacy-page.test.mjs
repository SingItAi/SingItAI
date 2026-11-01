import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(site, '..');
const read = (p) => readFileSync(path.join(site, p), 'utf8');
const html = read('privacy/index.html');
const terms = read('terms/index.html');
const canonical = 'https://singitai.app/privacy/';
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&ldquo;|&rdquo;/g, '"').replace(/&rsquo;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const text = strip(html);

// The operator is not named. The name is checked by hash so that it is not written into the repository.
const FORBIDDEN_WORD_HASHES = new Set([
  '17ceae2a49f7cbbf7c9c8cb374cbec8b4d803ebcc4ecab2a529209ea8838f94e',
  'ff7b29d02d7ac3c48c3bcb47d795c077da30b925b80417f6c4aaa112e6dcc590',
  '4a5a0c53b3fdf4ca02c13668726a89cd984c48bbd500cc09adb25fbdddfd5376',
  'c59d776342b32d404f2844445aa88fc281ae1eb56323451a6d9700e81ec74054',
]);
const OLD_EMAIL_HASH = '2adb065416d6a4628b24f5ccf9e8374e3a454b20d59446761390414ba289e749';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const words = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

test('privacy page has metadata, schema and one sitemap entry', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Privacy Policy \| SingIt<\/title>/);
  assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`));
  assert.ok(html.includes(`<meta property="og:url" content="${canonical}">`));
  const page = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(page.url, canonical);
  assert.equal(page.name, 'Privacy Policy | SingIt');
  assert.equal(read('sitemap.xml').split(`<loc>${canonical}</loc>`).length - 1, 1);
  assert.ok(!html.includes('⟦'), 'no unfilled placeholder');
});

test('privacy page uses the same chrome and footer as the terms page', () => {
  const part = (h, from, to) => h.slice(h.indexOf(from), h.indexOf(to));
  assert.equal(part(html, '<header', '<main'), part(terms, '<header', '<main'));
  assert.equal(html.slice(html.indexOf('</main>')), terms.slice(terms.indexOf('</main>')));
  assert.ok(html.includes('<a href="https://singitai.app/privacy/" target="_blank" rel="noopener">Privacy policy</a>'));
  assert.ok(html.includes('<a href="https://singitai.app/terms/" target="_blank" rel="noopener">Terms</a>'));
  assert.ok(html.includes('href="/terms/"') && html.includes('href="/data-deletion/"'));
});

test('operator is SingIt, contact is contact@singitai.app, and no person or old address appears', () => {
  assert.match(text, /SingIt \("SingIt", "we", "us"\) operates this service from Prague, Czech Republic/);
  assert.match(text, /not operated by a registered company/);
  assert.ok(html.includes('mailto:contact@singitai.app'));
  assert.doesNotMatch(text, /(operated|run|owned|controlled) by [A-Z][a-z]+ [A-Z][a-z]+/);
  assert.ok(!/@proton\.me/i.test(html));
  for (const file of ['privacy/index.html', 'data-deletion/index.html', 'terms/index.html']) {
    const src = read(file);
    assert.ok(!words(src).some((w) => FORBIDDEN_WORD_HASHES.has(sha(w))), `${file} names a person`);
    assert.ok(!words(src).some((w) => sha(w) === OLD_EMAIL_HASH), `${file} has the old contact address`);
    assert.ok(!/@proton\.me/i.test(src), `${file} has a proton.me address`);
  }
  const doc = readFileSync(path.join(root, 'docs/singit-privacy-policy.md'), 'utf8');
  assert.ok(!/@proton\.me/i.test(doc));
  assert.ok(!words(doc).some((w) => sha(w) === OLD_EMAIL_HASH));
});

test('data deletion page points at the same contact', () => {
  const del = read('data-deletion/index.html');
  assert.ok(del.includes('mailto:contact@singitai.app'));
  assert.match(strip(del), /wallet address/);
  assert.ok(del.includes('href="/privacy/"'));
});

test('privacy page describes the current product, not the July messaging-bot policy', () => {
  assert.doesNotMatch(text, /Effective July 10, 2026/);
  assert.doesNotMatch(text, /messaging-based wallet, payment, purchase/);
  assert.match(text, /Effective November 2, 2026/);
  for (const phrase of [/wallet address/, /singit_session/, /12 hours/, /only as hashes/, /Umami/, /without cookies/, /ask\.singitai\.app/,
    /app\.singitai\.app\/mcp/, /Telegram bot/, /not written to our database or logs|does not store your prompt/, /Surplus Intelligence/, /OpenRouter/, /TypeSafe/,
    /Exa/, /Bitrefill/, /Coinbase Developer Platform/, /Cloudflare/, /Reown/, /Base and Solana/, /public to anyone and permanent/,
    /30 days/, /We do not sell personal data/]) assert.match(text, phrase);
});

test('privacy page covers GDPR basics and the Czech authority', () => {
  for (const phrase of [/Art\. 6\(1\)\(b\)/, /Art\. 6\(1\)\(f\)/, /Art\. 6\(1\)\(c\)/, /Art\. 6\(1\)\(a\)/, /access to your data/, /deletion/, /portability/,
    /object/, /withdraw it at any time/, /within one month/, /Úřad pro ochranu osobních údajů \(ÚOOU\)/, /uoou\.gov\.cz/,
    /aged 18 and over/, /standard contractual clauses/]) assert.match(text, phrase);
});

test('privacy page does not claim what the code does not do', () => {
  assert.doesNotMatch(text, /Effective ⟦/);
  assert.doesNotMatch(text, /we never store|nothing is ever stored|deleted automatically after/i);
  // Retention is stated only where the code sets it.
  assert.match(text, /no automatic deletion for most account and payment records/);
  assert.match(text, /no fixed (period|expiry)/);
});

test('privacy page publishes no wallet, pay-to or limiter address', () => {
  for (const file of ['privacy/index.html', 'data-deletion/index.html']) {
    const src = strip(read(file));
    assert.doesNotMatch(src, /0x[0-9a-fA-F]{40}/, `${file} has an EVM address`);
    assert.doesNotMatch(src, /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/, `${file} has a Solana address`);
  }
});

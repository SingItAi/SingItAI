import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(path.join(site, p), 'utf8');

// The Telegram bot does not exist, so nothing the user sees in the app or on the developers page offers it.
test('the app and the developers page do not mention Telegram', () => {
  const files = readdirSync(path.join(site, 'app')).filter((f) => /\.(js|html|css|webmanifest)$/.test(f)).map((f) => `app/${f}`);
  files.push('developers/index.html');
  for (const file of files) assert.doesNotMatch(read(file), /telegram|link_telegram|linkCode|\/link\b/i, `${file} mentions Telegram`);
});

test('the developers page lists the app as live without Telegram', () => {
  assert.match(read('developers/index.html'), /<span class="status is-live">Live<\/span><b>SingIt app<\/b>/);
});

test('app navigation has no Telegram view and every view in the title and page maps agree', () => {
  const main = read('app/main.js');
  assert.doesNotMatch(main, /data-view="telegram"|view === "telegram"|renderTelegram/);
  const title = main.match(/: \{ allowance: "Allowance"[\s\S]*?\}\[state\.view\]/)[0];
  const page = main.match(/const page = \{[\s\S]*?\}\[state\.view\]/)[0];
  const keys = (src) => [...src.matchAll(/(\w+):/g)].map((m) => m[1]).filter((k) => !['page'].includes(k)).sort();
  assert.deepEqual(keys(title), ['allowance', 'keys', 'purchases', 'settings', 'usage']);
  assert.deepEqual(keys(page), ['allowance', 'keys', 'purchases', 'settings', 'usage']);
});

test('the web API client no longer exposes the Telegram link calls', () => {
  const api = read('app/api.js');
  assert.doesNotMatch(api, /Telegram|\/link\//);
  assert.doesNotMatch(read('app/main.js'), /api\.(link|unlink)\w*\(/);
});

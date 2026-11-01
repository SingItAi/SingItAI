import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { snapshot } from '../../scripts/ask-routes-snapshot.mjs';
import { renderLlms, taskRows, tasks } from '../../scripts/generate-llms.mjs';
import { price, visibleSnapshot } from '../../scripts/generate-model-pages.mjs';
const read = async name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const json = async name => JSON.parse(await read(name));

test('route snapshot validates and deterministically filters a local fixture', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/ask-openapi.json', import.meta.url), 'utf8'));
  const date = '2026-10-31T00:00:00.000Z';
  const result = snapshot(fixture, date);
  assert.deepEqual(result.routes.map(r => r.path), ['/health', '/private', '/v1/chat/completions']);
  assert.deepEqual(result.routes[0].price, { min: 0, max: 0, currency: 'USD' });
  assert.equal(result.routes[1].price, undefined);
  assert.deepEqual(result.routes[2].price, { min: '0.001', max: '3.5', currency: 'USD' });
  assert.equal(JSON.stringify(snapshot({ paths: Object.fromEntries(Object.entries(fixture.paths).reverse()) }, date)), JSON.stringify(result));
  for (const value of [-1, null, 'NaN', {}, '']) {
    const bad = structuredClone(fixture);
    bad.paths['/v1/chat/completions'].post['x-payment-info'].price.min = value;
    assert.throws(() => snapshot(bad, date), /Invalid payment price/);
  }
  assert.throws(() => snapshot(fixture, 'bad'), /Invalid/);
  const bad = structuredClone(fixture);
  bad.paths['/health'].get.summary = '';
  assert.throws(() => snapshot(bad, date), /summary/);
});

test('llms files derive route prices, fees, reference prices and all visible models from snapshots', async () => {
  const s = await json('data/models-snapshot.json');
  const routes = await json('data/ask-routes.json');
  const hold = JSON.parse(await readFile(new URL('../../scripts/hidden-models.json', import.meta.url), 'utf8'));
  const visible = visibleSnapshot(s, hold);
  const text = await read('llms.txt');
  const models = await read('llms-models.txt');
  const full = await read('llms-full.txt');
  const rendered = renderLlms(text, visible, routes, price);
  for (const [name, content] of rendered) assert.equal(await read(name), content, name);
  assert.match(text, /^# SingIt\n\n> /);
  assert.ok(Buffer.byteLength(text) < 14000);
  const top = text.indexOf('## I need to... -> Call -> Price');
  assert.ok(top > 0 && top < text.indexOf('## Money rules for agents'));
  const sections = ['## Money rules for agents', '## What it is', '## Products', '## Start here', '## First paid x402 call', '## Errors', '## For developers', '## Links', '## Models'];
  for (let i = 1; i < sections.length; i++) {
    assert.ok(text.indexOf(sections[i - 1]) < text.indexOf(sections[i]), `${sections[i - 1]} precedes ${sections[i]}`);
  }
  assert.ok(text.includes('settled at that flat price whatever length the answer turns out to be'));
  assert.doesNotMatch(text, /with no refund/);
  assert.ok(text.indexOf('`upto`') < text.indexOf('`exact`'));
  assert.match(text, /402.*PAYMENT-REQUIRED/);
  assert.match(text, /PAYMENT-SIGNATURE/);
  assert.match(text, /\| HTTP status \| code \| meaning \| charged\? \| what to do \|/);
  for (const row of taskRows(routes.routes, price)) assert.ok(text.includes(`| ${row.join(' | ')} |`));
  // Independently check the public ranges used by each task, including aggregate pinned routes.
  for (const [task, method, paths, free] of tasks) {
    const entries = paths.flatMap(p => p === '/v1/chat/{model}' ? routes.routes.filter(r => r.path.startsWith('/v1/chat/') && r.path !== '/v1/chat/completions' && r.method === method) : routes.routes.filter(r => r.path === p && r.method === method));
    const cell = free ? 'Free (limited daily allowance)' : entries.every(r => Number(r.price.max) === 0) ? 'Free' : `${price(Math.min(...entries.map(r => Number(r.price.min))))}..${price(Math.max(...entries.map(r => Number(r.price.max))))} USDC per call`;
    assert.ok(text.split('\n').find(line => line.startsWith(`| ${task} |`)).endsWith(`| ${cell} |`));
  }
  for (const n of ['base', 'solana']) assert.ok(text.includes(`$${price(s.fees.perAnswerUsd[s.networks[n].chain])}`));
  assert.ok(text.includes(`${s.fees.markupPct}% markup`));
  for (const m of visible.models) {
    assert.ok(models.includes(`](https://singitai.app/models/${m.id}/)`));
    if (m.singitUsdPerMillionTokens) for (const d of ['input', 'output']) assert.ok(models.includes(`$${price(m.singitUsdPerMillionTokens[d])}`));
    for (const n of ['base', 'solana']) for (const scheme of ['upto', 'exact']) assert.ok(models.includes(price(m[scheme][n].usd)));
  }
  for (const { id } of hold.hidden) assert.ok(!models.includes(`/models/${id}/`));
  const body = text.replace(/^<!-- generated:[^\n]+ -->\n/gm, '').trimEnd();
  assert.ok(full.startsWith(body + '\n\n'));
  assert.ok(full.includes(models.replace(/^# SingIt model pages/, '## Model pages with prices')));
  for (const content of [text, models, full]) assert.doesNotMatch(content, /video|AgentAllowance|no admin|0x[0-9a-fA-F]{40}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/i);
  assert.throws(() => taskRows([], price), /Missing priced route/);
  const changed = structuredClone(routes);
  changed.routes.find(r => r.path === '/v1/images/generations').price.max = '9.876543';
  assert.ok(renderLlms(text, visible, changed, price).get('llms.txt').includes('9.876543 USDC per call'));
  const headers = await read('_headers');
  for (const name of ['llms-models.txt', 'llms-full.txt']) {
    assert.ok(headers.includes(`/${name}\n  Content-Type: text/plain; charset=utf-8`));
    assert.ok(!(await read('sitemap.xml')).includes(name));
  }
});

test('renderer is offline and responds to changed snapshot data', async () => {
  const routes = tasks.flatMap(([, method, paths]) => paths.map(path => ({ method, path: path === '/v1/chat/{model}' ? '/v1/chat/fixture' : path, price: { min: 0, max: 1, currency: 'USD' } })));
  const s = { fees: { markupPct: 42, perAnswerUsd: { b: 0.003, s: 0.004 } }, networks: { base: { chain: 'b' }, solana: { chain: 's' } }, referenceRequest: { messages: 1, chars: 30, inputTokens: 12, maxOutputTokens: 800 }, models: [] };
  const text = '# SingIt\n\n> Summary\n\n<!-- generated:ask-guide:start -->\n<!-- generated:ask-guide:end -->\n<!-- generated:model-pages:start -->\n<!-- generated:model-pages:end -->\n';
  const result = renderLlms(text, s, { routes }, price);
  assert.match(result.get('llms.txt'), /42% markup/);
  assert.match(result.get('llms.txt'), /\$0.003 on Base or \$0.004 on Solana/);
  assert.deepEqual(renderLlms(result.get('llms.txt'), s, { routes }, price), result);
  assert.throws(() => renderLlms(text, s, { routes: routes.filter(r => r.path !== '/v1/messages') }, price), /Missing priced route/);
});

test('zero token prices read Not listed', async () => {
  const { renderModelList } = await import('../../scripts/generate-llms.mjs');
  const model = { id: 'zero', singitUsdPerMillionTokens: { input: 0, output: 0 },
    upto: { base: { usd: 1 }, solana: { usd: 1 } }, exact: { base: { usd: 1 }, solana: { usd: 1 } } };
  const text = renderModelList({ models: [model] }, price);
  assert.match(text, /Not listed \| Not listed/);
  assert.doesNotMatch(text, /\$0|100%/);
});

test('free list input keeps a positive SingIt output listed', async () => {
  const { renderModelList } = await import('../../scripts/generate-llms.mjs');
  const model = { id: 'free-input', usdPerMillionTokens: { input: 0, output: 2 },
    singitUsdPerMillionTokens: { input: 0, output: 0.2 },
    upto: { base: { usd: 1 }, solana: { usd: 1 } }, exact: { base: { usd: 1 }, solana: { usd: 1 } } };
  const text = renderModelList({ models: [model] }, price);
  assert.match(text, /\$0 \| \$0\.2 \|/);
  assert.doesNotMatch(text, /Not listed/);
});

test('200+ claim has at least 200 visible models and agent guides explain routing', async () => {
  const s = await json('data/models-snapshot.json');
  const hold = JSON.parse(await readFile(new URL('../../scripts/hidden-models.json', import.meta.url), 'utf8'));
  assert.ok(visibleSnapshot(s, hold).models.length >= 200);
  for (const file of ['llms.txt', 'SKILL.md', 'llms-full.txt']) {
    const text = await read(file);
    for (const term of ['singit/auto', 'min_tier', 'fallback_models']) assert.ok(text.includes(term), `${file}: ${term}`);
  }
});

test('agent card supplies discovery, security, examples and safe HTTPS links', async () => {
  const card = await json('.well-known/agent-card.json');
  for (const key of ['name', 'description', 'url', 'iconUrl', 'version', 'provider', 'documentationUrl', 'supportedInterfaces', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'securitySchemes', 'security', 'skills', 'links']) assert.ok(card[key], key);
  assert.deepEqual(card.capabilities, { streaming: false, pushNotifications: false, stateTransitionHistory: false });
  assert.deepEqual(card.defaultInputModes, ['application/json', 'text/plain']);
  assert.deepEqual(card.defaultOutputModes, card.defaultInputModes);
  assert.equal(card.url, 'https://ask.singitai.app');
  assert.equal(card.iconUrl, 'https://singitai.app/assets/icons/icon-512.png');
  assert.equal(card.securitySchemes.x402.name, 'PAYMENT-SIGNATURE');
  assert.equal(card.securitySchemes.bearer.scheme, 'bearer');
  assert.deepEqual(card.security, [{ x402: [] }, { bearer: [] }]);
  assert.equal(card.skills[0].id, 'key-spending-limits');
  for (const skill of card.skills) assert.equal(skill.examples.length, 1, skill.id);
  for (const name of ['llms', 'llmsFull', 'openapi', 'x402Manifest', 'skill', 'models', 'pricing', 'mcpKeyDocs']) assert.match(card.links[name], /^https:\/\//);
  const urls = JSON.stringify(card).match(/https:[^"\s]+/g);
  for (const url of urls) assert.doesNotMatch(url, /0x[a-fA-F0-9]{40}/);
});

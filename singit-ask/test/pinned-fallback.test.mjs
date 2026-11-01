import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choosePinnedFallback, AUTO_CONFIG } from '../src/auto-router.mjs';
import { chooseModel, readRequest, RequestError, ROUTE } from '../src/app.mjs';
import { UnknownModel } from '../src/catalogue.mjs';
import { ceilings } from '../src/metered.mjs';
import { BASE } from '../src/pricing.mjs';
import { CONFIG, catalogue, serve, post, pay, decode } from './auto-router-fixtures.mjs';
const [pinned, fallback] = AUTO_CONFIG.tiers.eco;
const body = (extra = {}) => ({ model: pinned, fallback_models: [fallback], messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, ...extra });
const unhealthy = { ...catalogue, isUnservable: id => id === pinned, canAnswer: async id => id !== pinned };
const choose = (cat, value = body()) => choosePinnedFallback(CONFIG, cat, readRequest(value), chooseModel, RequestError);

test('pinned fallback chooses deterministically, respects order and preserves the cost and tier bounds', async () => {
  const a = await choose(unhealthy);
  assert.equal(a.model, fallback);
  assert.equal(a.fallbackFrom, pinned);
  assert.deepEqual(await choose(unhealthy), a);
  const original = { ...readRequest(body()), isDefault: true };
  assert.ok(BigInt(ceilings(a.info, a).upto[BASE]) <= BigInt(ceilings(await catalogue.resolve(pinned), original).upto[BASE]));
  for (const cat of [
    { ...unhealthy, canAnswer: async () => false },
    { ...unhealthy, resolve: async id => ({ ...await catalogue.resolve(id), ...(id === fallback ? { completionUsdPerToken: 1 } : {}) }) },
    { ...unhealthy, resolve: async id => ({ ...await catalogue.resolve(id), ...(id === fallback ? { unpriced: true } : {}) }) },
    { ...unhealthy, resolve: async id => ({ ...await catalogue.resolve(id), ...(id === fallback ? { promptUsdPerToken: 0, completionUsdPerToken: 0 } : {}) }) },
  ]) await assert.rejects(choose(cat), e => e.status === 503);
  await assert.rejects(choose(unhealthy, body({ fallback_models: [AUTO_CONFIG.tiers.standard[0]] })), e => e.status === 503);
  const healthy = await choose(catalogue);
  assert.equal(healthy.model, pinned);
  assert.equal(healthy.fallbackFrom, undefined);
  await assert.rejects(chooseModel(CONFIG, unhealthy, readRequest({ model: pinned, messages: body().messages })), e => e.status === 503);
  await assert.rejects(choose({ ...unhealthy, resolve: async () => { throw new UnknownModel('missing'); } }), e => e.status === 400 && e.code === 'model_not_found');
});

test('non-tier pins use caller order, skipping unpriced and expensive candidates', async () => {
  const rates = { pin: .00001, expensive: 1, first: .000002, second: .000001 };
  const cat = { resolve: async id => ({ id, promptUsdPerToken: rates[id], completionUsdPerToken: rates[id] }),
    isUnservable: id => id === 'pin', canAnswer: async () => true };
  const value = body({ model: 'pin', fallback_models: ['expensive', 'first', 'second'] });
  assert.equal((await choose(cat, value)).model, 'first');
  assert.equal((await choose(cat, { ...value, fallback_models: ['unpriced', 'second'] })).model, 'second');
  assert.equal((await choose(cat, { ...value, fallback_models: ['second', 'first'] })).model, 'second');
  await assert.rejects(choose({ ...cat, resolve: async id => ({ id }) }, value), e => e.status === 503);
});

test('fallback validation rejects invalid arrays and trims ids', () => {
  for (const value of [null, '', {}, [], [1], [''], [' '], [pinned], ['singit/auto'], [fallback, ` ${fallback} `], ['a', 'b', 'c', 'd']]) {
    assert.throws(() => readRequest(body({ fallback_models: value })), e => e.status === 400 && /fallback_models/.test(e.message));
  }
  assert.deepEqual(readRequest(body({ fallback_models: [` ${fallback} `] })).fallbackModels, [fallback]);
});

test('pinned pre-payment price rejection uses the auto price-protection skip', async () => {
  const pin = AUTO_CONFIG.tiers.standard[0], next = AUTO_CONFIG.tiers.standard[1];
  const cat = { ...catalogue, guardShare: () => .25, isPriceRejected: id => id === pin,
    resolve: async id => ({ ...await catalogue.resolve(id), promptUsdPerToken: .00001, completionUsdPerToken: .00001 }) };
  assert.equal((await choose(cat, body({ model: pin, fallback_models: [next], max_tokens: 512 }))).model, next);
  // Minimum quotes cover list price and therefore have no discount floor to reject.
  assert.equal((await choose({ ...catalogue, guardShare: () => .25, isPriceRejected: () => true })).model, pinned);
});

test('pinned fallback quotes its own model, paid retry settles once with margin and exposes headers', async t => {
  const { url, facilitator, asked } = await serve(t, { catalogue: unhealthy });
  const challenge = await post(url + ROUTE, body());
  assert.equal(challenge.status, 402);
  assert.equal(challenge.headers.get('x-singit-model'), fallback);
  assert.equal(challenge.headers.get('x-singit-fallback-from'), pinned);
  assert.match(challenge.headers.get('access-control-expose-headers'), /X-SingIt-Fallback-From/i);
  const required = decode(challenge.headers.get('payment-required'));
  const selected = await choose(unhealthy);
  for (const offer of required.accepts) assert.equal(offer.amount, ceilings(selected.info, selected)[offer.scheme][offer.network]);
  const answer = await post(url + ROUTE, body(), pay(required, BASE));
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('x-singit-model'), fallback);
  assert.equal(answer.headers.get('x-singit-fallback-from'), pinned);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].model, fallback);
  const result = await answer.json();
  assert.ok(BigInt(result.billing.totalAtomic) >= 1130n);
  assert.deepEqual(facilitator.calls.settle, [[BASE, result.billing.totalAtomic]]);
});

for (const mode of ['no-opt-in', 'healthy', 'exhausted', 'invalid']) test(`pinned HTTP ${mode}`, async t => {
  const cat = mode === 'healthy' ? catalogue : mode === 'exhausted' ? { ...unhealthy, canAnswer: async () => false } : unhealthy;
  const { url, facilitator } = await serve(t, { catalogue: cat });
  const value = body();
  if (mode === 'no-opt-in') delete value.fallback_models;
  if (mode === 'invalid') value.fallback_models = [];
  const response = await post(url + ROUTE, value);
  assert.equal(response.status, mode === 'healthy' ? 402 : mode === 'invalid' ? 400 : 503);
  if (mode === 'healthy') {
    assert.equal(response.headers.get('x-singit-model'), null);
    assert.equal(response.headers.get('x-singit-fallback-from'), null);
  } else {
    assert.equal(response.headers.get('payment-required'), null);
    assert.equal((await response.json()).error.code, mode === 'invalid' ? 'invalid_request' : 'no_healthy_sellers');
  }
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle.length, 0);
});

test('a suspended fallback is skipped even when its backoff has expired', async () => {
  await assert.rejects(choose({ ...unhealthy, isSuspended: id => id === fallback,
    canAnswer: async () => true }), error => error.status === 503);
});

const defaultPin = 'gpt-6-luna', defaultNext = 'gpt-6-luna-pro';
const defaultBody = extra => ({ model: defaultPin, messages: body().messages, max_tokens: 32, ...extra });
const defaultCat = (options = {}) => ({ ...catalogue,
  resolve: async id => [defaultPin, defaultNext].includes(id)
    ? { id, promptUsdPerToken: .00001, completionUsdPerToken: id === defaultPin ? .00002 : .00001 }
    : catalogue.resolve(id),
  isUnservable: id => id === defaultPin, canAnswer: async id => id !== defaultPin, ...options });

test('reviewed default quotes and settles the selected model with policy disclosure', async t => {
  const cat = defaultCat();
  const { url, facilitator } = await serve(t, { catalogue: cat });
  const challenge = await post(url + ROUTE, defaultBody());
  assert.equal(challenge.status, 402);
  const required = decode(challenge.headers.get('payment-required'));
  const selected = await choosePinnedFallback(CONFIG, cat, readRequest(defaultBody({ fallback_models: [defaultNext] })), chooseModel, RequestError);
  const pin = { ...readRequest(defaultBody()), info: await cat.resolve(defaultPin), isDefault: false };
  for (const offer of required.accepts) {
    assert.equal(offer.amount, ceilings(selected.info, selected)[offer.scheme][offer.network]);
    assert.ok(BigInt(offer.amount) <= BigInt(ceilings(pin.info, pin)[offer.scheme][offer.network]));
  }
  const answer = await post(url + ROUTE, defaultBody(), pay(required, BASE));
  assert.equal(answer.status, 200);
  for (const response of [challenge, answer]) {
    assert.equal(response.headers.get('x-singit-model'), defaultNext);
    assert.equal(response.headers.get('x-singit-fallback-from'), defaultPin);
    assert.equal(response.headers.get('x-singit-fallback-policy'), 'default');
    assert.match(response.headers.get('access-control-expose-headers'), /X-SingIt-Fallback-Policy/i);
  }
  const result = await answer.json();
  assert.equal(result.model, defaultNext);
  assert.equal(result.singit_fallback_from, defaultPin);
  assert.equal(facilitator.calls.settle.length, 1);
  assert.ok(BigInt(result.billing.totalAtomic) <= BigInt(required.accepts.find(a => a.network === BASE && a.scheme === 'upto').amount));
});

for (const mode of ['header', 'config', 'healthy', 'expensive', 'suspended', 'explicit', 'default-model']) test(`reviewed default ${mode}`, async t => {
  const cat = defaultCat(mode === 'healthy' ? { isUnservable: () => false, canAnswer: async () => true }
    : mode === 'suspended' ? { isSuspended: id => id === defaultNext }
    : mode === 'expensive' ? { resolve: async id => ({ id, promptUsdPerToken: id === defaultNext ? 1 : .00001, completionUsdPerToken: .00001 }) } : {});
  const config = { ...CONFIG, ...(mode === 'config' ? { defaultFallbacks: false } : {}), ...(mode === 'default-model' ? { model: defaultPin } : {}) };
  const { url, facilitator } = await serve(t, { catalogue: cat, config });
  const response = await post(url + ROUTE, defaultBody(mode === 'explicit' ? { fallback_models: [fallback] } : {}), mode === 'header' ? { 'X-SingIt-Fallback': ' OFF ' } : {});
  assert.equal(response.status, ['healthy', 'explicit'].includes(mode) ? 402 : 503);
  assert.equal(response.headers.get('x-singit-fallback-policy'), mode === 'explicit' ? 'request' : null);
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle.length, 0);
});

test('reviewed default config validation', async () => {
  const { validateAutoConfig } = await import('../src/auto-router.mjs');
  for (const map of [[], null, { pin: [] }, { pin: ['pin'] }, { pin: ['singit/auto'] }, { pin: ['image-model'] }, { pin: ['a','a'] }, { 'BAD': ['a'] }, { pin: ['a','b','c','d'] }]) {
    assert.throws(() => validateAutoConfig({ ...AUTO_CONFIG, pinnedDefaultFallbacks: map }));
  }
  validateAutoConfig({ ...AUTO_CONFIG, pinnedDefaultFallbacks: { pin: ['unknown'] } });
});

for (const path of ['/v1/chat/gpt-6-luna', '/v1/messages', '/v1/responses']) test(`reviewed default stays out of ${path}`, async t => {
  const { url, facilitator } = await serve(t, { catalogue: defaultCat() });
  const response = await post(url + path, { ...defaultBody(), input: 'hi' });
  assert.ok([404, 503].includes(response.status));
  assert.equal(response.headers.get('x-singit-fallback-from'), null);
  assert.equal(response.headers.get('payment-required'), null);
  assert.equal(facilitator.calls.verify, 0);
});

test('quoted route receives the strict chooser and parser', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(source, /addSolanaQuotedRoute\(app, config, \{ facilitatorClient, catalogue, readRequest: readOtherRequest, choose,/);
});

test('model discovery lists the default fallback only for the reviewed pair and only while enabled', async t => {
  const cat = defaultCat({ list: async () => [await defaultCat().resolve(defaultPin)], isUnservable: () => false, canAnswer: async () => true });
  const { url } = await serve(t, { catalogue: cat });
  const models = await (await fetch(url + '/v1/models')).json();
  assert.deepEqual(models.data.find(m => m.id === defaultPin).defaultFallback, [defaultNext]);
  assert.equal(models.data.find(m => m.id === 'singit/auto').defaultFallback, undefined);
  const off = await serve(t, { catalogue: cat, config: { ...CONFIG, defaultFallbacks: false } });
  const offModels = await (await fetch(off.url + '/v1/models')).json();
  assert.equal(offModels.data.find(m => m.id === defaultPin).defaultFallback, undefined);
});

for (const model of [undefined, 'singit/auto']) test(`reviewed defaults leave ${model ?? 'omitted'} selection unchanged`, async t => {
  const { url } = await serve(t, { catalogue: defaultCat() });
  const response = await post(url + ROUTE, defaultBody({ model }));
  assert.equal(response.status, 402);
  assert.equal(response.headers.get('x-singit-fallback-from'), null);
  assert.equal(response.headers.get('x-singit-fallback-policy'), null);
});

test('request list still works with default opt-outs', async t => {
  const { url } = await serve(t, { catalogue: defaultCat(), config: { ...CONFIG, defaultFallbacks: false } });
  const response = await post(url + ROUTE, defaultBody({ fallback_models: [defaultNext] }), { 'X-SingIt-Fallback': 'off' });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get('x-singit-fallback-policy'), 'request');
});

test('a substitute that is dearer on any network or scheme is refused, even when its Base upto ceiling is not', async () => {
  const rates = { pin: 3e-6, same: 3e-6, base_equal_solana_dearer: 3.8e-6, cheaper: 2e-6 };
  const cat = { resolve: async id => ({ id, promptUsdPerToken: 1e-9, completionUsdPerToken: rates[id] }),
    isUnservable: id => id === 'pin', canAnswer: async () => true };
  const value = fallbacks => body({ model: 'pin', fallback_models: fallbacks, max_tokens: 100 });
  const pin = await choose(cat, value(['same']));
  const dear = await choose({ ...cat, resolve: cat.resolve }, value(['cheaper']));
  assert.equal(pin.model, 'same');
  assert.equal(dear.model, 'cheaper');
  const pinned = ceilings(await cat.resolve('pin'), readRequest(value(['same'])));
  const wide = ceilings(await cat.resolve('base_equal_solana_dearer'), readRequest(value(['same'])));
  assert.equal(wide.upto[BASE], pinned.upto[BASE], 'the fixture must tie on Base upto');
  assert.ok(Object.entries(wide).some(([scheme, nets]) => Object.entries(nets).some(([net, amount]) => BigInt(amount) > BigInt(pinned[scheme][net]))));
  await assert.rejects(choose(cat, value(['base_equal_solana_dearer'])), e => e.status === 503);
});

test('the substitute comparison uses the configured exact fraction', async () => {
  // Chosen so the substitute is not dearer at the default exact fraction but is dearer at 0.65 (exact prices
  // output at the fraction and input at chars/4, upto prices both in full).
  const rates = { pin: [1e-6, 1e-6], next: [5e-7, 3e-6] };
  const cat = { resolve: async id => ({ id, promptUsdPerToken: rates[id][0], completionUsdPerToken: rates[id][1] }),
    isUnservable: id => id === 'pin', canAnswer: async () => true };
  const value = { ...body({ model: 'pin', fallback_models: ['next'], max_tokens: 400 }), messages: [{ role: 'user', content: 'x'.repeat(3000) }] };
  const run = exactOutputFraction => choosePinnedFallback({ ...CONFIG, exactOutputFraction }, cat, readRequest(value), chooseModel, RequestError);
  const chosen = await run(undefined);
  assert.equal(chosen.model, 'next');
  const pinned = ceilings(await cat.resolve('pin'), readRequest(value));
  for (const [scheme, nets] of Object.entries(ceilings(chosen.info, chosen))) for (const [net, amount] of Object.entries(nets)) assert.ok(BigInt(amount) <= BigInt(pinned[scheme][net]));
  await assert.rejects(run(.65), e => e.status === 503);
});

for (const header of ['off', 'OFF, off', 'on, off', ' off ']) test(`default opt-out header ${JSON.stringify(header)}`, async t => {
  const { url, facilitator } = await serve(t, { catalogue: defaultCat() });
  const response = await post(url + ROUTE, defaultBody(), { 'X-SingIt-Fallback': header });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('payment-required'), null);
  assert.equal(facilitator.calls.verify, 0);
});

test('validation accepts a config without pinnedDefaultFallbacks', async () => {
  const { validateAutoConfig } = await import('../src/auto-router.mjs');
  const { pinnedDefaultFallbacks, ...without } = AUTO_CONFIG;
  validateAutoConfig(without);
  assert.deepEqual(AUTO_CONFIG.pinnedDefaultFallbacks, { 'gpt-6-luna': ['gpt-6-luna-pro'] });
});

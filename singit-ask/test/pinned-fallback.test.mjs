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

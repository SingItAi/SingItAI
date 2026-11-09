// A pinned model refused after payment without a billable result may be answered once by an equivalent model
// (auto-router.mjs attachPaidAlternates, metered.mjs). One payment: one answer, at most one settlement.
// Stub facilitator and seller: no network, keys or payments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, models, catalogue, post, decode, fakeFacilitator } from './auto-router-fixtures.mjs';
import { AUTO_CONFIG } from '../src/auto-router.mjs';
import { createApp, UpstreamError, ROUTE } from '../src/app.mjs';
import { BASE } from '../src/pricing.mjs';
import { reservations } from '../src/media-payment-replay.mjs';
import { canRetryPaidFallback, relaxMinDiscount } from '../src/metered.mjs';

const [CHEAP, PINNED, DEAR] = AUTO_CONFIG.tiers.eco;  // deepseek-v4.1-flash, claude-haiku-5.5, gemini-3.8-flash
const OUTSIDE = 'mistral-outside-1';
const encode = v => Buffer.from(JSON.stringify(v)).toString('base64');
const tick = () => new Promise(r => setImmediate(r));
function gate() { let open; const opened = new Promise(r => { open = r; }); return { opened, open }; }

// Like a real facilitator, one signed payment settles at most once.
async function serve(t, { upstream, cat = catalogue }) {
  const facilitator = fakeFacilitator(), settled = new Set();
  const settle = facilitator.settle;
  let settledOk = 0;
  facilitator.settle = async (payload, requirements) => {
    const id = JSON.stringify(payload.payload);
    if (settled.has(id)) return { success: false, errorReason: 'invalid_transaction_state', transaction: '', network: requirements.network };
    settled.add(id); settledOk++;
    return settle(payload, requirements);
  };
  const app = createApp(CONFIG, { facilitatorClient: facilitator, upstream, log: () => {}, catalogue: cat });
  const listener = await new Promise((resolve, reject) => { const l = app.listen(0, '127.0.0.1', e => e ? reject(e) : resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}${ROUTE}`, facilitator, settledOk: () => settledOk };
}
const pay = (required, network, scheme, signature = '0xsigned') => ({ 'PAYMENT-SIGNATURE': encode({ x402Version: 2, resource: required.resource,
  accepted: required.accepts.find(a => a.network === network && a.scheme === scheme), payload: { signature }, extensions: required.extensions }) });
const body = (model, extra = {}) => ({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, ...extra });
const answer = model => ({ content: model, finishReason: 'stop', usage: { buyer_cost_micro: 100 } });
const refused = (status = 503, code = 'upstream_error') => new UpstreamError('refused', { status, code });

test('paid fallback allowlist accepts availability failures only', () => {
  for (const status of [404, 429, 500, 503, 599]) assert.equal(canRetryPaidFallback(refused(status)), true);
  assert.equal(canRetryPaidFallback(refused(404, 'minimum_discount_not_met')), true);
  assert.equal(canRetryPaidFallback(refused(0, 'no_healthy_sellers')), true);
  for (const status of [0, 200, 400, 401, 403, 409, 413, 422, 600]) {
    assert.equal(canRetryPaidFallback(refused(status)), false);
  }
  for (const status of [400, 413, 422]) assert.equal(canRetryPaidFallback(refused(status, 'no_healthy_sellers')), false);
  assert.equal(canRetryPaidFallback({ name: 'Error', status: 503, code: 'no_healthy_sellers' }), false);
});

// Quote, then pay that quote.
async function paid(url, request, { network = BASE, scheme = 'upto', headers = {}, signature } = {}) {
  const challenge = await post(url, request, headers);
  assert.equal(challenge.status, 402);
  const required = decode(challenge.headers.get('payment-required'));
  const signed = required.accepts.find(a => a.network === network && a.scheme === scheme).amount;
  return { signed, response: await post(url, request, { ...headers, ...pay(required, network, scheme, signature) }) };
}

for (const scheme of ['upto', 'exact']) for (const status of [404, 503]) {
  test(`pinned ${scheme}: HTTP ${status} after payment, the cheaper same-tier model answers once, one settlement`, async t => {
    const asked = [];
    const { url, facilitator } = await serve(t, { upstream: async (_c, _m, _n, _f, model) => {
      asked.push(model);
      if (asked.length === 1) throw refused(status);
      return answer(model);
    } });
    const { signed, response } = await paid(url, body(PINNED), { scheme });
    assert.equal(response.status, 200);
    assert.deepEqual(asked, [PINNED, CHEAP]);
    assert.equal(facilitator.calls.settle.length, 1);
    assert.equal(response.headers.get('x-singit-model'), CHEAP);
    assert.equal(response.headers.get('x-singit-fallback-from'), PINNED);
    assert.equal(response.headers.get('x-singit-fallback-policy'), 'paid');
    const result = await response.json();
    assert.equal(result.model, CHEAP);
    assert.equal(result.singit_fallback_from, PINNED);
    assert.ok(BigInt(result.billing.totalAtomic) <= BigInt(signed));
    assert.ok(BigInt(facilitator.calls.settle[0][1]) <= BigInt(signed));
  });
}

for (const scheme of ['upto', 'exact']) for (const status of [400, 413, 422]) {
  test(`pinned ${scheme}: HTTP ${status} never reaches the cheaper same-tier alternate`, async t => {
    const asked = [];
    const { url, facilitator } = await serve(t, { upstream: async (_c, _m, _n, _f, model) => {
      asked.push(model);
      if (asked.length === 1) throw refused(status);
      return answer(model);
    } });
    const { response } = await paid(url, body(PINNED), { scheme });
    assert.ok(response.status >= 400);
    assert.deepEqual(asked, [PINNED]);
    assert.equal(facilitator.calls.settle.length, 0);
    assert.equal(response.headers.get('x-singit-fallback-from'), null);
    assert.equal(response.headers.get('x-singit-fallback-policy'), null);
    assert.equal((await response.json()).singit_fallback_from, undefined);
  });
}

test('pinned: a first answer is used, no second model and no fallback headers', async t => {
  const asked = [];
  const { url, facilitator } = await serve(t, { upstream: async (_c, _m, _n, _f, model) => { asked.push(model); return answer(model); } });
  const { response } = await paid(url, body(PINNED));
  assert.equal(response.status, 200);
  assert.deepEqual(asked, [PINNED]);
  assert.equal(facilitator.calls.settle.length, 1);
  for (const name of ['x-singit-model', 'x-singit-fallback-from', 'x-singit-fallback-policy']) assert.equal(response.headers.get(name), null);
  assert.equal((await response.json()).singit_fallback_from, undefined);
});

// A 200 without text may already be billed; an unreachable seller may have answered after the timeout.
for (const [failure, error, expected] of [
  ['no_text', refused(200, 'no_text'), 503],
  ['max_tokens_spent_reasoning', refused(200, 'max_tokens_spent_reasoning'), 422],
  ['unreachable', refused(0, 'unreachable'), 503],
]) test(`pinned: ${failure} is not retried on another model and nothing settles`, async t => {
  let calls = 0;
  const { url, facilitator } = await serve(t, { upstream: async () => { calls++; throw error; } });
  const { response } = await paid(url, body(PINNED));
  assert.equal(response.status, expected);
  assert.equal(calls, 1);
  assert.equal(facilitator.calls.settle.length, 0);
});

test('pinned: an alternate whose ceiling is above the signed amount is skipped', async t => {
  // The alternate's price rises after the quote: the paid route checks it against what was actually signed.
  const cheap = { ...models.find(m => m.id === CHEAP) };
  const cat = { ...catalogue, resolve: async id => id === CHEAP ? cheap : catalogue.resolve(id) };
  let calls = 0;
  const { url, facilitator } = await serve(t, { cat, upstream: async () => {
    calls++; cheap.completionUsdPerToken = 1; throw refused(404, 'minimum_discount_not_met');
  } });
  for (const scheme of ['upto', 'exact']) {
    calls = 0; cheap.completionUsdPerToken = models.find(m => m.id === CHEAP).completionUsdPerToken;
    const { response } = await paid(url, body(PINNED), { scheme, signature: `0x${scheme}` });
    assert.equal(response.status, 503, scheme);
    assert.equal(calls, 1, scheme);
  }
  assert.equal(facilitator.calls.settle.length, 0);
});

test('pinned: a dearer same-tier model is never an alternate', async t => {
  let calls = 0;
  const { url, facilitator } = await serve(t, { upstream: async () => { calls++; throw refused(); } });
  // The cheapest eco model has no cheaper peer; the dearest one is never attached for it.
  const { response } = await paid(url, body(CHEAP, { fallback_models: [DEAR] }));
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
  assert.equal(facilitator.calls.settle.length, 0);
});

test('pinned: two refusals are final, two model calls, nothing settles', async t => {
  const asked = [];
  const { url, facilitator } = await serve(t, { upstream: async (_c, _m, _n, _f, model) => { asked.push(model); throw refused(); } });
  const { response } = await paid(url, body(PINNED));
  assert.equal(response.status, 503);
  assert.deepEqual(asked, [PINNED, CHEAP]);
  assert.equal(facilitator.calls.settle.length, 0);
});

test('X-SingIt-Fallback: off keeps a pinned model strictly pinned after payment', async t => {
  let calls = 0;
  const { url, facilitator } = await serve(t, { upstream: async () => { calls++; throw refused(); } });
  const { response } = await paid(url, body(PINNED), { headers: { 'X-SingIt-Fallback': 'off' } });
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
  assert.equal(facilitator.calls.settle.length, 0);
});

for (const off of [false, true]) test(`explicit fallback_models are the only candidates, header off=${off}`, async t => {
  const asked = [];
  const { url, facilitator } = await serve(t, { upstream: async (_c, _m, _n, _f, model) => { asked.push(model); throw refused(); } });
  // DEAR's peers are CHEAP and PINNED; only PINNED is listed.
  const { response } = await paid(url, body(DEAR, { fallback_models: [PINNED] }), { headers: off ? { 'X-SingIt-Fallback': 'off' } : {} });
  assert.equal(response.status, 503);
  assert.deepEqual(asked, [DEAR, PINNED]);
  assert.equal(facilitator.calls.settle.length, 0);
});

test('explicit fallback_models: the listed model answers with policy paid', async t => {
  const asked = [];
  const { url, facilitator } = await serve(t, { upstream: async (_c, _m, _n, _f, model) => {
    asked.push(model); if (asked.length === 1) throw refused(429, 'rate_limited'); return answer(model);
  } });
  const { response } = await paid(url, body(DEAR, { fallback_models: [PINNED] }));
  assert.equal(response.status, 200);
  assert.deepEqual(asked, [DEAR, PINNED]);
  assert.equal(response.headers.get('x-singit-fallback-policy'), 'paid');
  assert.equal(facilitator.calls.settle.length, 1);
});

test('a substitute quoted before payment keeps the unused fallback_models for one paid retry', async t => {
  const cat = { ...catalogue, canAnswer: async id => id !== DEAR };
  const asked = [];
  const { url, facilitator } = await serve(t, { cat, upstream: async (_c, _m, _n, _f, model) => {
    asked.push(model); if (asked.length === 1) throw refused(); return answer(model);
  } });
  const { response } = await paid(url, body(DEAR, { fallback_models: [PINNED, CHEAP] }));
  assert.equal(response.status, 200);
  assert.deepEqual(asked, [PINNED, CHEAP]);
  assert.equal(response.headers.get('x-singit-model'), CHEAP);
  assert.equal(response.headers.get('x-singit-fallback-from'), DEAR);
  assert.equal(response.headers.get('x-singit-fallback-policy'), 'paid');
  assert.equal(facilitator.calls.settle.length, 1);
});

test('a model outside every auto tier, with no fallback_models, gets no invented alternate', async t => {
  const outside = { id: OUTSIDE, promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 };
  const cat = { ...catalogue, resolve: async id => id === OUTSIDE ? outside : catalogue.resolve(id) };
  let calls = 0;
  const { url, facilitator } = await serve(t, { cat, upstream: async () => { calls++; throw refused(); } });
  const { response } = await paid(url, body(OUTSIDE));
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
  assert.equal(facilitator.calls.settle.length, 0);
});

test('singit/auto keeps its own alternates; nothing extra is attached', async t => {
  const asked = [];
  const { url, facilitator } = await serve(t, { upstream: async (_c, _m, _n, _f, model) => { asked.push(model); throw refused(); } });
  const { response } = await paid(url, body('singit/auto'));
  assert.equal(response.status, 503);
  assert.deepEqual(asked, AUTO_CONFIG.tiers.eco.slice(0, 2));
  assert.equal(facilitator.calls.settle.length, 0);
});

// Base only: this fixture's stub payload cannot open a Solana upto escrow (payment-reservation.test.mjs covers Solana).
for (const scheme of ['upto', 'exact']) test(`RACE ${scheme}: the same payment during a fallback is 409 before verification and starts no model`, async t => {
  const g = gate();
  const asked = [];
  const { url, facilitator, settledOk } = await serve(t, { upstream: async (_c, _m, _n, _f, model) => {
    asked.push(model);
    if (asked.length === 1) { await g.opened; throw refused(); }
    return answer(model);
  } });
  const request = body(PINNED);
  const challenge = await post(url, request);
  const required = decode(challenge.headers.get('payment-required'));
  const header = pay(required, BASE, scheme, '0xrace');
  const first = post(url, request, header);
  t.after(g.open);
  while (asked.length < 1) await tick();
  const verified = facilitator.calls.verify;
  // Same payment, a different body of the same price.
  for (const copy of [request, body(PINNED, { messages: [{ role: 'user', content: 'yo' }] })]) {
    const twin = await post(url, copy, header);
    assert.equal(twin.status, 409);
    assert.equal((await twin.json()).error.code, 'payment_duplicate');
  }
  assert.equal(asked.length, 1);
  assert.equal(facilitator.calls.verify, verified, 'the copies are refused before verification');
  g.open();
  const response = await first;
  assert.equal(response.status, 200);
  assert.deepEqual(asked, [PINNED, CHEAP]);
  assert.equal(facilitator.calls.settle.length, 1);
  assert.equal(settledOk(), 1);
  assert.equal(reservations.size, 0, 'released once answered');
  // A later replay is no longer in flight: the facilitator refuses the second settlement.
  const again = await post(url, request, header);
  assert.notEqual(again.status, 409);
  assert.equal(settledOk(), 1);
  assert.equal(reservations.size, 0);
});

test('RACE: two different payments fall back independently, each settles once', async t => {
  const g = gate();
  const asked = [];
  const { url, facilitator } = await serve(t, { upstream: async (_c, _m, _n, _f, model) => {
    asked.push(model);
    if (model === PINNED) { await g.opened; throw refused(); }
    return answer(model);
  } });
  const request = body(PINNED);
  const required = decode((await post(url, request)).headers.get('payment-required'));
  t.after(g.open);
  const both = ['0xone', '0xtwo'].map(signature => post(url, request, pay(required, BASE, 'upto', signature)));
  while (asked.length < 2) await tick();
  assert.deepEqual(asked, [PINNED, PINNED]);
  g.open();
  const responses = await Promise.all(both);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.deepEqual(asked.filter(m => m === CHEAP).length, 2);
  assert.equal(facilitator.calls.settle.length, 2);
  assert.equal(reservations.size, 0);
});


function guardedCatalogue(learned = []) {
  return {
    ...catalogue,
    guardShare: () => 0.01,
    markPriceRejected(id, info) { learned.push([id, info]); },
  };
}

test('relaxMinDiscount only lowers a floor that was actually sent', () => {
  const input = { minDiscount: 98, share: 0.02, info: models.find(m => m.id === CHEAP), chars: 2, maxTokens: 800, messageCount: 1 };
  assert.equal(relaxMinDiscount(input, refused(404, 'minimum_discount_not_met'), { exact: true, network: BASE, maxChargeAtomic: '1500' }), null);
  assert.equal(relaxMinDiscount({ ...input, minDiscount: null }, Object.assign(refused(404, 'minimum_discount_not_met'), { bestDiscountPct: 91.3189 }),
    { exact: true, network: BASE, maxChargeAtomic: '1500' }), null);
  const ok = relaxMinDiscount(input, Object.assign(refused(404, 'minimum_discount_not_met'), { bestDiscountPct: 91.3189 }),
    { exact: true, network: BASE, maxChargeAtomic: '1500' });
  assert.equal(ok.minDiscount, 91.3189);
  assert.equal(ok.share, (100 - 91.3189) / 100);
  const tooDear = relaxMinDiscount(input, Object.assign(refused(404, 'minimum_discount_not_met'), { bestDiscountPct: 0 }),
    { exact: false, network: BASE, maxChargeAtomic: '1500' });
  assert.equal(tooDear, null);
});

for (const scheme of ['upto', 'exact']) {
  test(`default model ${scheme}: minimum_discount_not_met retries the same model at the live discount`, async t => {
    const learned = [];
    const asked = [];
    const { url, facilitator } = await serve(t, {
      cat: guardedCatalogue(learned),
      upstream: async (_c, _m, _n, _f, model, options) => {
        asked.push({ model, minDiscount: options?.minDiscount });
        if (asked.length === 1) throw Object.assign(refused(404, 'minimum_discount_not_met'), { bestDiscountPct: 91.3189 });
        return answer(model);
      },
    });
    const { response } = await paid(url, body(CHEAP, { max_tokens: 800 }), { scheme });
    assert.equal(response.status, 200);
    assert.deepEqual(asked.map(a => a.model), [CHEAP, CHEAP]);
    assert.equal(asked[0].minDiscount, 98);
    assert.equal(asked[1].minDiscount, 91.3189);
    assert.equal(facilitator.calls.settle.length, 1);
    assert.equal(response.headers.get('x-singit-fallback-from'), null);
    assert.deepEqual(learned, [[CHEAP, { bestDiscountPct: 91.3189 }]]);
  });
}

test('default model: a live discount whose ceiling exceeds the signed amount is not retried', async t => {
  const learned = [];
  let calls = 0;
  const { url, facilitator } = await serve(t, {
    cat: guardedCatalogue(learned),
    upstream: async () => {
      calls++;
      throw Object.assign(refused(404, 'minimum_discount_not_met'), { bestDiscountPct: 0 });
    },
  });
  const { response } = await paid(url, body(CHEAP, { max_tokens: 800 }), { scheme: 'upto' });
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
  assert.equal(facilitator.calls.settle.length, 0);
  assert.deepEqual(learned, [[CHEAP, { bestDiscountPct: 0 }]]);
});

test('pinned: a fitting live discount is preferred over switching models', async t => {
  const asked = [];
  const { url, facilitator } = await serve(t, {
    cat: guardedCatalogue(),
    upstream: async (_c, _m, _n, _f, model) => {
      asked.push(model);
      if (asked.length === 1) throw Object.assign(refused(404, 'minimum_discount_not_met'), { bestDiscountPct: 91.3189 });
      return answer(model);
    },
  });
  const { response } = await paid(url, body(PINNED, { max_tokens: 800 }), { scheme: 'exact' });
  assert.equal(response.status, 200);
  assert.deepEqual(asked, [PINNED, PINNED]);
  assert.equal(response.headers.get('x-singit-fallback-from'), null);
  assert.equal(facilitator.calls.settle.length, 1);
});

// Test-only hook (metered.mjs forceFailA): SINGIT_ASK_TEST_FORCE_FAIL_A=1 plus X-SingIt-Test-Force-Fail-A: 1 from an
// own payer refuses the first paid model once, so the R2 paid fallback can be exercised. Never for anyone else.
// Stub facilitator and seller: no network, keys or payments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, catalogue, post, decode, fakeFacilitator } from './auto-router-fixtures.mjs';
import { AUTO_CONFIG } from '../src/auto-router.mjs';
import { createApp, ROUTE } from '../src/app.mjs';
import { BASE } from '../src/pricing.mjs';
import { HealthStats } from '../src/health-stats.mjs';
import { canRetryPaidFallback, forceFailA } from '../src/metered.mjs';

const [CHEAP, PINNED] = AUTO_CONFIG.tiers.eco;
const PAYER = '0x2222222222222222222222222222222222222222';  // what fakeFacilitator verifies
const OTHER = '0x' + '9'.repeat(40);
const HEADER = { 'X-SingIt-Test-Force-Fail-A': '1' };
const ENV = 'SINGIT_ASK_TEST_FORCE_FAIL_A';
const encode = v => Buffer.from(JSON.stringify(v)).toString('base64');
const body = model => ({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 });

function withEnv(t, value) {
  const before = process.env[ENV];
  if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
  t.after(() => { if (before === undefined) delete process.env[ENV]; else process.env[ENV] = before; });
}

async function serve(t, { ownPayers, cat = catalogue }) {
  const facilitator = fakeFacilitator(), asked = [], lines = [], marked = [];
  const app = createApp({ ...CONFIG, ownPayers }, { facilitatorClient: facilitator, log: line => lines.push(line),
    catalogue: { ...cat, noteSellerFailure: model => marked.push(model) },
    upstream: async (_c, _m, _n, _f, model) => {
      asked.push(model);
      return { content: model, finishReason: 'stop', usage: { buyer_cost_micro: 100 } };
    } });
  const listener = await new Promise((resolve, reject) => { const l = app.listen(0, '127.0.0.1', e => e ? reject(e) : resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}${ROUTE}`, facilitator, asked, lines, marked };
}

async function paid(url, request, headers = {}) {
  const challenge = await post(url, request, headers);
  assert.equal(challenge.status, 402);
  const required = decode(challenge.headers.get('payment-required'));
  const accepted = required.accepts.find(a => a.network === BASE && a.scheme === 'upto');
  const signature = { 'PAYMENT-SIGNATURE': encode({ x402Version: 2, resource: required.resource, accepted,
    payload: { signature: '0xsigned' }, extensions: required.extensions }) };
  return { signed: accepted.amount, response: await post(url, request, { ...headers, ...signature }) };
}

async function notForced(t, { env, ownPayers, headers = HEADER }) {
  withEnv(t, env);
  const { url, facilitator, asked } = await serve(t, { ownPayers });
  const { response } = await paid(url, body(PINNED), headers);
  assert.equal(response.status, 200);
  assert.deepEqual(asked, [PINNED]);
  assert.equal(facilitator.calls.settle.length, 1);
  assert.equal(response.headers.get('x-singit-fallback-from'), null);
}

test('isOwn: only a known payer on a non-empty own list, normalized; never the inverse of isExternal for unknowns', () => {
  const none = new HealthStats({});
  assert.equal(none.isOwn(PAYER), false);
  const s = new HealthStats({ ownPayers: [PAYER] });
  assert.equal(s.isOwn(PAYER), true);
  assert.equal(s.isOwn(PAYER.toUpperCase().replace('0X', '0x')), true);
  for (const p of [OTHER, '', ' ', null, undefined, 42]) assert.equal(s.isOwn(p), false, String(p));
  assert.equal(s.isExternal(null), false);
});

test('forceFailA needs env exactly "1", an own payer and the header', () => {
  const req = (own, header) => ({ singitOwnPayer: own, get: name => name.toLowerCase() === 'x-singit-test-force-fail-a' ? header : undefined });
  assert.equal(forceFailA(req(true, '1'), { [ENV]: '1' }), true);
  for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '1 ']) assert.equal(forceFailA(req(true, '1'), { [ENV]: value }), false, String(value));
  for (const own of [false, undefined, 'true', 1]) assert.equal(forceFailA(req(own, '1'), { [ENV]: '1' }), false, String(own));
  for (const header of [undefined, '', '0', 'true']) assert.equal(forceFailA(req(true, header), { [ENV]: '1' }), false, String(header));
  assert.equal(forceFailA({ singitOwnPayer: true }, { [ENV]: '1' }), false);
  assert.equal(forceFailA(undefined, { [ENV]: '1' }), false);
});

test('env off: an own payer with the header is answered by model A, no fallback', t =>
  notForced(t, { env: undefined, ownPayers: [PAYER] }));

test('env "0": an own payer with the header is answered by model A', t =>
  notForced(t, { env: '0', ownPayers: [PAYER] }));

test('env on, external payer (non-empty own list): the header is ignored', t =>
  notForced(t, { env: '1', ownPayers: [OTHER] }));

test('env on, empty own-payer list: the header is ignored', t =>
  notForced(t, { env: '1', ownPayers: [] }));

test('env on, own payer, no header: model A answers', t =>
  notForced(t, { env: '1', ownPayers: [PAYER], headers: {} }));

test('env on, own payer, header: A is force-failed once, B answers, one settle within what was signed', async t => {
  withEnv(t, '1');
  const { url, facilitator, asked, lines, marked } = await serve(t, { ownPayers: [PAYER] });
  const { signed, response } = await paid(url, body(PINNED), HEADER);
  assert.equal(response.status, 200);
  assert.deepEqual(asked, [CHEAP], 'A is never asked; B is asked for real');
  assert.equal(facilitator.calls.settle.length, 1);
  assert.equal(response.headers.get('x-singit-model'), CHEAP);
  assert.equal(response.headers.get('x-singit-fallback-from'), PINNED);
  assert.equal(response.headers.get('x-singit-fallback-policy'), 'paid');
  const result = await response.json();
  assert.equal(result.singit_fallback_from, PINNED);
  assert.ok(BigInt(result.billing.totalAtomic) <= BigInt(signed));
  assert.ok(BigInt(facilitator.calls.settle[0][1]) <= BigInt(signed));
  assert.deepEqual(marked, [], 'a forced failure never marks the real model unservable');
  assert.ok(lines.some(l => l.includes(`paid fallback from=${PINNED} to=${CHEAP}`)));
  assert.ok(!lines.join('\n').toLowerCase().includes(PAYER.slice(2)), 'no payer address in logs');
});

test('env on, own payer, header, no eligible alternate: 503 no_billable_answer, nothing settles', async t => {
  withEnv(t, '1');
  const { url, facilitator, asked, marked } = await serve(t, { ownPayers: [PAYER] });
  // X-SingIt-Fallback: off leaves the pinned model without alternates.
  const { response } = await paid(url, body(PINNED), { ...HEADER, 'X-SingIt-Fallback': 'off' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'no_billable_answer');
  assert.deepEqual(asked, []);
  assert.equal(facilitator.calls.settle.length, 0);
  assert.deepEqual(marked, []);
});

test('the forced failure is an allowlisted availability failure', () => {
  // Same shape canRetryPaidFallback accepts for a real seller 503.
  assert.equal(canRetryPaidFallback({ name: 'UpstreamError', status: 503, code: 'upstream_unavailable' }), true);
});

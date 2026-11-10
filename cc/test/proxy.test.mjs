import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NETWORKS } from '@singitai/sdk';
import { startMerchant } from './helpers/merchant.mjs';
import { startProxy, VERSION } from '../src/server.js';
import { readLedger } from '../src/ledger.js';
import { assertNetworkAllowed } from '../src/config.js';
const offer = { scheme: 'upto', network: NETWORKS.base.caip, asset: NETWORKS.base.asset, payTo: NETWORKS.base.payTo,
  amount: '9000', maxTimeoutSeconds: 120, extra: { facilitatorAddress: `0x${'0'.repeat(39)}2`, assetTransferMethod: 'permit2',
    name: 'USD Coin', version: '2', billing: { mode: 'actual_usage', maxChargeAtomic: '9000' } } };
async function fixture(t, { funded = true, flags = {}, intercept, extraEnv = {} } = {}) {
  const merchant = await startMerchant({ offer, funded });
  t.after(() => merchant.close());
  const home = mkdtempSync(path.join(tmpdir(), 'singit-cc-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { SINGIT_HOME: home, SINGIT_ASK_URL: merchant.url, SINGIT_CC_PORT: '0', ...extraEnv };
  const fetchImpl = intercept ? (input, init) => intercept(input, init, merchant) : fetch;
  const proxy = await startProxy({ env, flags, fetchImpl });
  t.after(() => new Promise(resolve => proxy.server.close(resolve)));
  return { merchant, env, proxy, url: `http://127.0.0.1:${proxy.config.port}` };
}
const post = (url, body = {}, route = '/v1/messages') => fetch(url + route, { method: 'POST', headers: {
  'content-type': 'application/json', authorization: 'Bearer must-not-reach-ask', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Hello' }], ...body }) });
for (const route of ['/api/v1/messages', '/v1/messages']) test(`${route} pays exactly once and records billing`, async t => {
  const { url, merchant, env } = await fixture(t);
  const response = await post(url, {}, route);
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(answer.type, 'message');
  assert.equal(answer.content[0].text, 'Hello back.');
  assert.deepEqual(merchant.requests.map(r => r.status), [402, 200]);
  assert.equal(merchant.requests[0].headers['payment-signature'], undefined);
  assert.ok(merchant.requests[1].headers['payment-signature']);
  for (const r of merchant.requests) {
    assert.equal(r.headers['x-singit-client'], `singit-cc/${VERSION}`);
    assert.equal(r.headers.authorization, undefined);
    assert.equal(r.headers['anthropic-version'], '2023-06-01');
    assert.equal(r.body.max_tokens, 8192);
  }
  assert.equal(readLedger(env).totalAtomic, 4500);
  const { privateKey, address } = JSON.parse(readFileSync(path.join(env.SINGIT_HOME, 'session')));
  for (const route of ['/', '/health', '/wallet', '/api/v1/models', '/v1/models']) {
    const raw = await (await fetch(url + route)).text();
    assert.ok(!raw.includes(privateKey.slice(2)));
    if (['/', '/health'].includes(route)) assert.ok(!raw.includes(address));
  }
  assert.ok(!JSON.stringify(answer).includes(privateKey.slice(2)));
});
test('refused payment is an Anthropic 402 error, no third request or ledger entry', async t => {
  const { url, merchant, env } = await fixture(t, { funded: false });
  const response = await post(url, { stream: true });
  assert.equal(response.status, 402);
  const body = await response.json();
  assert.equal(body.type, 'error'); assert.equal(body.error.type, 'payment_required');
  assert.deepEqual(merchant.requests.map(r => r.status), [402, 402]);
  assert.equal(readLedger(env).calls, 0);
});
test('client SSE is buffered from paid JSON; stream_options is dropped', async t => {
  const { url, merchant, env } = await fixture(t);
  const response = await post(url, { stream: true, stream_options: { include_usage: true } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const sse = await response.text();
  assert.match(sse, /event: message_start/); assert.match(sse, /event: message_stop/);
  assert.match(sse, /Hello back/);
  for (const r of merchant.requests) { assert.equal(r.body.stream, false); assert.equal(r.body.stream_options, undefined); }
  assert.equal(readLedger(env).calls, 1);
});
for (const max_tokens of [32000, 100000]) test(`clamps ${max_tokens} tokens`, async t => {
  const { url, merchant } = await fixture(t);
  assert.equal((await post(url, { max_tokens })).status, 200);
  assert.ok(merchant.requests.every(r => r.body.max_tokens === 8192));
});
test('Solana gates fail closed, including when the success gate is open', async () => {
  for (const pct of [undefined, 94, 95, 100]) {
    const fetchImpl = async () => Response.json({ paid_call_success: { last_7d: { solana: { success_pct: pct } } } });
    await assert.rejects(assertNetworkAllowed('solana', { askUrl: 'http://mock', fetchImpl }), pct >= 95 ? /Base wallet/ : /at least 95%/);
    await assert.rejects(startProxy({ env: { SINGIT_NETWORK: 'solana' }, fetchImpl }), /Solana/);
  }
});
test('unsigned model-not-found fallback can be disabled', async t => {
  for (const disabled of [false, true]) {
    const seen = [];
    const { url } = await fixture(t, { flags: { 'no-fallback': disabled }, intercept: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.clone().json(); seen.push({ body, headers: request.headers });
      if (body.model === 'missing') return Response.json({ error: { code: 'model_not_found' } }, { status: 400 });
      return Response.json({ type: 'message', content: [{ type: 'text', text: 'free' }] });
    } });
    const response = await post(url, { model: 'missing' });
    assert.equal(response.status, disabled ? 400 : 200);
    assert.equal(seen.length, disabled ? 1 : 2);
    assert.ok(seen.every(r => !r.headers.has('payment-signature')));
    if (!disabled) assert.equal(seen[1].body.model, 'free/deepseek-v4.1-flash');
  }
});
test('daily cap downgrades only an unsigned new request', async t => {
  const { url, merchant } = await fixture(t, { extraEnv: { SINGIT_MAX_PER_DAY_USD: '0' }, intercept: async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.method === 'POST' && (await req.clone().json()).model.startsWith('free/')) {
      assert.equal(req.headers.has('payment-signature'), false);
      return Response.json({ type: 'message', content: [{ type: 'text', text: 'free' }] });
    }
    return fetch(input, init);
  } });
  assert.equal((await post(url)).status, 200);
  assert.deepEqual(merchant.requests.map(r => r.status), [402]);
});
test('signed 400 model_not_found never falls back', async t => {
  let signed = 0;
  const { url, merchant } = await fixture(t, { intercept: (input, init) => {
    if (input instanceof Request && input.headers.has('payment-signature')) {
      signed++; return Promise.resolve(Response.json({ error: { code: 'model_not_found' } }, { status: 400 }));
    }
    return fetch(input, init);
  } });
  assert.equal((await post(url)).status, 502);
  assert.equal(signed, 1); assert.equal(merchant.requests.length, 1);
});
test('model aliases and auto honor the selected model; custom token cap is bounded', async t => {
  const { url, merchant } = await fixture(t, { flags: { model: 'selected-model', 'max-tokens': '32000' } });
  for (const model of ['auto', 'sonnet', 'opus', 'haiku']) {
    assert.equal((await post(url, { model, max_tokens: 100000 })).status, 200);
  }
  for (const r of merchant.requests) { assert.equal(r.body.model, 'selected-model'); assert.equal(r.body.max_tokens, 32000); }
});
test('no-fallback daily cap and per-call cap refuse before signing', async t => {
  for (const extraEnv of [{ SINGIT_MAX_PER_DAY_USD: '0' }, { SINGIT_MAX_PER_CALL_USD: '0.0001' }]) {
    const { url, merchant } = await fixture(t, { extraEnv, flags: { 'no-fallback': true } });
    const response = await post(url);
    assert.equal(response.status, 402); assert.equal((await response.json()).type, 'error');
    assert.deepEqual(merchant.requests.map(r => r.status), [402]);
    assert.equal(merchant.requests[0].headers['payment-signature'], undefined);
  }
});

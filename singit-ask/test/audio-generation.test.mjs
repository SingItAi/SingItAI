import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { addAudioGenerationRoutes, AUDIO_ROUTES, audioExample, audioPrices } from '../src/audio-generation.mjs';
import { BASE, SOLANA } from '../src/pricing.mjs';
const config = { payToBase: '0x' + '1'.repeat(40), payToSolana: '1'.repeat(32), surplusUrl: 'https://surplus.test', surplusKey: 'our-key' };
const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
let sequence = 0;
const encode = p => Buffer.from(JSON.stringify(p)).toString('base64');
const decode = p => JSON.parse(Buffer.from(p, 'base64'));
function fixture(mode = 'success') {
  const calls = [], settled = [];
  const facilitatorClient = {
    async getSupported() { return { kinds: [ { x402Version: 2, scheme: 'upto', network: BASE, extra: { facilitatorAddress: '0x' + '3'.repeat(40) } }, { x402Version: 2, scheme: 'upto', network: SOLANA, extra: { feePayer: '1'.repeat(32), receiverAuthorizer: '1'.repeat(32) } }, { x402Version: 2, scheme: 'exact', network: BASE }, { x402Version: 2, scheme: 'exact', network: SOLANA, extra: { feePayer: '1'.repeat(32) } } ], extensions: ['bazaar'], signers: {} }; },
    async verify() { return { isValid: true, payer: '0x' + '2'.repeat(40) }; },
    async settle(_payment, offer) { settled.push(offer); return { success: true, transaction: '0x' + 'a'.repeat(64), network: offer.network }; },
  };
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (init.method === 'POST') {
      assert.equal(init.headers.Authorization, 'Bearer our-key');
      if (mode === 'credit') return Response.json({ error: { code: 'insufficient_credit' } }, { status: 402 });
      if (mode === 'timeout') return new Promise(() => {});
      return Response.json({ id: 'job123', status: 'succeeded' });
    }
    if (mode === 'private') return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/file' } });
    return new Response(mode === 'invalid' ? '{}' : mode === 'oversize' ? Buffer.alloc(101) : 'ID3audio');
  };
  const app = express(); app.locals.paidRoutes = new Set(); app.use(express.json());
  addAudioGenerationRoutes(app, { ...config, mediaJobOptions: { resolve, artifactFetch: fetchImpl, timeoutMs: mode === 'timeout' ? 10 : 1000, maxBytes: 100, sleep: async () => {} } }, { facilitatorClient, fetchImpl, log: () => {}, open: (_q, _s, next) => next() });
  return { app, calls, settled, facilitatorClient };
}
// Direct handler checks supplement actual x402 settlement tests below when the sandbox denies listeners.
for (const route of AUDIO_ROUTES) test(`${route} validation and paid result handler without sockets`, async () => {
  for (const mode of ['success', 'credit', 'timeout', 'invalid', 'oversize', 'private']) {
    const { app, calls } = fixture(mode);
    const layers = app.router.stack.filter(l => l.route?.path === route && l.route.methods.post);
    const validate = layers[0].route.stack[0].handle;
    const handler = layers.at(-1).route.stack[0].handle;
    let status = 200, sent, passed = false;
    const res = { set() { return this; }, status(s) { status = s; return this; }, json(v) { sent = v; return this; }, send(v) { sent = v; return this; } };
    const req = { body: { text: '', prompt: '' }, headers: {}, get: () => undefined };
    validate(req, res, () => { passed = true; });
    assert.equal(status, 422); assert.equal(passed, false); assert.deepEqual(calls, []);
    req.body = audioExample(route.endsWith('sound-effects') ? 'sound-effects' : 'music');
    const header = encode({ accepted: { network: BASE }, payload: { signature: `audio-${++sequence}` } });
    req.headers = { 'payment-signature': header }; req.get = () => header;
    validate(req, res, () => { passed = true; }); assert.equal(passed, true);
    status = 200; await handler(req, res);
    assert.equal(status, mode === 'success' ? 200 : 503);
    if (status === 200) assert.equal(sent.toString(), 'ID3audio');
    assert.ok(!calls.some(u => u.includes('127.0.0.1')));
  }
});
for (const route of AUDIO_ROUTES) for (const network of [BASE, SOLANA]) test(`${route} x402 settlement on ${network}`, async t => {
  for (const mode of ['success', 'credit', 'timeout', 'invalid', 'oversize', 'private']) {
    const { app, settled, calls } = fixture(mode);
    const listener = await new Promise((resolve, reject) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); l.once('error', reject); });
    t.after(() => listener.close());
    const url = `http://127.0.0.1:${listener.address().port}${route}`;
    const body = audioExample(route.endsWith('sound-effects') ? 'sound-effects' : 'music');
    const post = headers => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const challenge = await post({}); assert.equal(challenge.status, 402);
    const required = decode(challenge.headers.get('payment-required'));
    assert.ok(required.accepts.every(a => a.scheme === 'exact'));
    const expected = audioPrices().find(m => m.route === route).exact[network === BASE ? 'base' : 'solana'].ceilingAtomic;
    assert.equal(required.accepts.find(a => a.network === network).amount, expected);
    assert.deepEqual(calls, []);
    const signature = encode({ x402Version: 2, resource: required.resource, accepted: required.accepts.find(a => a.network === network), payload: { signature: `audio-${++sequence}` }, extensions: required.extensions });
    const response = await post({ 'payment-signature': signature });
    assert.equal(response.status, mode === 'success' ? 200 : 503);
    await response.arrayBuffer();
    assert.equal(settled.length, mode === 'success' ? 1 : 0);
  }
});

test('audio discovery, OpenAPI and flat pricing agree without sockets; video stays hidden', async () => {
  const { createApp } = await import('../src/app.mjs');
  const { generateOpenapi } = await import('../scripts/generate-openapi.mjs');
  const { readFile } = await import('node:fs/promises');
  const app = createApp(config, { facilitatorClient: fixture().facilitatorClient, catalogue: { async list() { return []; }, async resolve() { throw new Error('unavailable'); } }, log: () => {}, fetchImpl: () => { throw new Error('no upstream expected'); } });
  const invoke = async path => {
    const layer = app.router.stack.find(l => l.route?.path === path);
    let result;
    await layer.route.stack.at(-1).handle({ protocol: 'https', get: () => 'ask.singitai.app' }, { json(v) { result = v; } });
    return result;
  };
  const discovery = await invoke('/.well-known/x402');
  for (const route of AUDIO_ROUTES) assert.ok(discovery.resources.includes(`https://ask.singitai.app${route}`));
  assert.ok(!discovery.resources.some(r => r.includes('/video/')));
  const pricing = await invoke('/pricing.json');
  for (const model of audioPrices()) assert.deepEqual(pricing.models.find(m => m.id === model.id).exact, model.exact);
  const doc = await generateOpenapi();
  const resources = JSON.parse(await readFile(new URL('../../scripts/bazaar-resources.json', import.meta.url)));
  assert.equal(resources.resources.length, 27);
  for (const route of AUDIO_ROUTES) {
    assert.ok(resources.resources.some(r => r.url.endsWith(route)));
    assert.deepEqual(Object.keys(doc.paths[route].post.responses).map(Number), [200, 400, 402, 409, 413, 422, 503]);
  }
});

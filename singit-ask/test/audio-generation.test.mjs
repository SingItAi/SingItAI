import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { addAudioGenerationRoutes, AUDIO_ROUTES, audioExample, audioPrices, availableAudioPrices, surplusAudioRequest, readAudioGeneration } from '../src/audio-generation.mjs';
import { BASE, SOLANA } from '../src/pricing.mjs';
const config = { audioSold: true, audioDiscoverable: true, payToBase: '0x' + '1'.repeat(40), payToSolana: '1'.repeat(32), surplusUrl: 'https://surplus.test', surplusKey: 'our-key', audioGenerationReady: () => true };
const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
let sequence = 0;
const encode = p => Buffer.from(JSON.stringify(p)).toString('base64');
const decode = p => JSON.parse(Buffer.from(p, 'base64'));
function fixture(mode = 'success') {
  const calls = [], settled = [], logs = [];
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
      if (mode === 'unavailable') return Response.json({ error: { code: 'no_healthy_sellers', message: 'secret Surplus error message our-key' } }, { status: 503 });
      if (mode === 'failed') return Response.json({ id: 'job123', status: 'failed', job_token: 'secret-job-token' });
      if (mode === 'timeout') return new Promise(() => {});
      return Response.json({ id: 'job123', status: 'succeeded' });
    }
    if (mode === 'private') return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/file' } });
    return new Response(mode === 'invalid' ? '{}' : mode === 'oversize' ? Buffer.alloc(101) : 'ID3audio');
  };
  const app = express(); app.locals.paidRoutes = new Set(); app.use(express.json());
  addAudioGenerationRoutes(app, { ...config, mediaJobOptions: { resolve, artifactFetch: fetchImpl, timeoutMs: mode === 'timeout' ? 10 : 1000, maxBytes: 100, sleep: async () => {} } }, { facilitatorClient, fetchImpl, log: line => logs.push(line), open: (_q, _s, next) => next() });
  return { app, calls, settled, facilitatorClient, logs };
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
for (const route of AUDIO_ROUTES) for (const network of [BASE]) test(`${route} x402 settlement on ${network}`, async t => {
  for (const mode of ['success', 'credit', 'timeout', 'invalid', 'oversize', 'private']) {
    const { app, settled, calls } = fixture(mode);
    const listener = await new Promise((resolve, reject) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); l.once('error', reject); });
    t.after(() => listener.close());
    const url = `http://127.0.0.1:${listener.address().port}${route}`;
    const body = audioExample(route.endsWith('sound-effects') ? 'sound-effects' : 'music');
    const post = headers => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const challenge = await post({}); assert.equal(challenge.status, 402);
    const required = decode(challenge.headers.get('payment-required'));
    assert.deepEqual(required.extensions.bazaar.info.output, { type: 'audio/mpeg', format: 'binary' });
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
  const doc = await generateOpenapi({ audioSold: true, audioDiscoverable: true });
  const resources = JSON.parse(await readFile(new URL('../../scripts/bazaar-resources.json', import.meta.url)));
  assert.equal(resources.resources.length, 62);
  for (const route of AUDIO_ROUTES) {
    assert.ok(resources.resources.some(r => r.url.endsWith(route)));
    assert.deepEqual(Object.keys(doc.paths[route].post.responses).map(Number), [200, 400, 402, 409, 413, 422, 503]);
  }
});

test('readiness hides audio from all lists and refuses requests before payment', async () => {
  const { createApp } = await import('../src/app.mjs');
  let ready = false;
  const f = fixture();
  const app = createApp({ ...config, model: 'default', audioGenerationReady: () => ready }, {
    facilitatorClient: f.facilitatorClient,
    catalogue: { async list() { return []; }, async resolve() { throw new Error('unavailable'); },
      isUnservable(id) { return id === 'venice-minimax-music-v26'; } },
    fetchImpl: () => { throw new Error('no upstream expected'); }, log: () => {},
  });
  const invoke = async path => {
    const layer = app.router.stack.find(l => l.route?.path === path);
    let result;
    await layer.route.stack.at(-1).handle({ protocol: 'https', get: () => 'ask.singitai.app' }, { json(v) { result = v; } });
    return result;
  };
  const ids = doc => (doc.data ?? doc.models).map(m => m.id);
  for (const path of ['/v1/models', '/pricing.json', '/v1/audio/generation-models']) {
    assert.ok(!ids(await invoke(path)).some(id => id.includes('music') || id.includes('sound-effects')));
  }
  assert.ok(!(await invoke('/.well-known/x402')).resources.some(r => AUDIO_ROUTES.some(p => r.endsWith(p))));
  const gate = app.router.stack.find(l => l.name === '<anonymous>' && !l.route && l.handle.toString().includes('availableAudioPrices')).handle;
  let status, passed = false;
  gate({ body: audioExample('music') }, { status(n) { status = n; return this; }, json() {} }, () => { passed = true; });
  assert.equal(status, 503); assert.equal(passed, false);
  ready = true;
  for (const path of ['/v1/models', '/pricing.json', '/v1/audio/generation-models']) {
    const listed = ids(await invoke(path));
    assert.ok(listed.includes('minimax/music-2'));
    assert.ok(!listed.includes('minimax/music-2.6'), 'unservable model stays hidden');
  }
  assert.ok((await invoke('/.well-known/x402')).resources.includes('https://ask.singitai.app/v1/audio/generations'));
});

for (const route of AUDIO_ROUTES) test(`${route} refuses Solana before starting a job`, async () => {
  const { app, calls, settled } = fixture();
  const layers = app.router.stack.filter(l => l.route?.path === route && l.route.methods.post);
  const header = encode({ accepted: { network: SOLANA }, payload: { signature: 'unused' } });
  let status;
  await layers.at(-1).route.stack[0].handle({ get: () => header }, {
    status(n) { status = n; return this; }, json() {},
  });
  assert.equal(status, 402); assert.deepEqual(calls, []); assert.deepEqual(settled, []);
  assert.ok(audioPrices().every(m => !Object.hasOwn(m.exact, 'solana')));
});


test('unknown credit/readiness, missing credentials and idle seller snapshots fail closed', () => {
  assert.deepEqual(availableAudioPrices({ ...config, audioGenerationReady: undefined }), []);
  assert.deepEqual(availableAudioPrices({ ...config, surplusKey: '' }), []);
  assert.deepEqual(availableAudioPrices({ ...config, audioGenerationReady() { throw new Error('stale'); } }), []);
  assert.equal(availableAudioPrices(config, { served: new Set(['chat-only']) }).length, 5);
  assert.deepEqual(availableAudioPrices({ ...config, audioSold: undefined }), []);
  assert.deepEqual(availableAudioPrices(config, { isSuspended: () => true }), []);
});

test('official Surplus fields and limits', () => {
  assert.deepEqual(surplusAudioRequest({ model: 'elevenlabs/sound-effects-v2', text: 'Rain', response_format: 'wav' }), { model: 'venice-elevenlabs-sound-effects-v2', prompt: 'Rain' });
  assert.deepEqual(surplusAudioRequest({ model: 'minimax/music-2.6', prompt: 'Jazz', lyrics: '', instrumental: true, duration_seconds: 60 }), { model: 'venice-minimax-music-v26', prompt: 'Jazz', lyrics_prompt: '', force_instrumental: true, duration_seconds: 60 });
  assert.throws(() => readAudioGeneration({ prompt: 'x'.repeat(2001), lyrics: 'Song' }, 'music'), { status: 422 });
  assert.throws(() => readAudioGeneration({ prompt: 'Song', lyrics: 'x'.repeat(5001) }, 'music'), { status: 422 });
});

test('sold and discovery switches are independent of ready models', async () => {
  const { createApp } = await import('../src/app.mjs');
  for (const sold of [undefined, false, true]) for (const discoverable of [undefined, false, true]) {
    const app = createApp({ ...config, audioSold: sold, audioDiscoverable: discoverable }, {
      catalogue: { async list() { return []; }, async resolve() { throw new Error('unavailable'); }, served: new Set(['chat-only']) },
      facilitatorClient: fixture().facilitatorClient, log: () => {}, fetchImpl: () => { throw new Error('no network'); },
    });
    let result;
    const layer = app.router.stack.find(l => l.route?.path === '/.well-known/x402');
    await layer.route.stack.at(-1).handle({ protocol: 'https', get: () => 'ask.singitai.app' }, { json(v) { result = v; } });
    assert.equal(result.resources.some(r => AUDIO_ROUTES.some(p => r.endsWith(p))), sold === true && discoverable === true);
    assert.equal(availableAudioPrices({ ...config, audioSold: sold }).length, sold ? 5 : 0);
    let doc;
    await app.router.stack.find(l => l.route?.path === '/openapi.json').route.stack.at(-1).handle(
      { protocol: 'https', get: () => 'ask.singitai.app' }, { json(v) { doc = v; } });
    for (const route of AUDIO_ROUTES) assert.equal(Boolean(doc.paths[route]), sold === true && discoverable === true);
    assert.equal(Boolean(doc.paths['/v1/audio/generation-models']), sold === true);
    if (sold) assert.deepEqual(doc.paths['/v1/audio/generation-models'].get.security, []);
    if (!sold) {
      for (const route of AUDIO_ROUTES) {
        const gate = app.router.stack.find(l => !l.route && l.handle.toString().includes('availableAudioPrices')).handle;
        let status;
        gate({ body: audioExample(route.endsWith('sound-effects') ? 'sound-effects' : 'music') }, { status(n) { status = n; return this; }, json() {} }, () => assert.fail('payment must not start'));
        assert.equal(status, 503);
      }
    }
  }
});


for (const route of AUDIO_ROUTES) for (const mode of ['failed', 'unavailable']) test(`${route} ${mode} logs safe diagnostics and keeps the buyer response unchanged`, async () => {
  const { app, logs } = fixture(mode);
  const kind = route.endsWith('sound-effects') ? 'sound-effects' : 'music';
  const model = kind === 'music' ? 'minimax/music-2' : 'sonilo/sound-effects-1.0';
  const layers = app.router.stack.filter(l => l.route?.path === route && l.route.methods.post);
  const header = encode({ accepted: { network: BASE }, payload: { signature: `secret-payment-${++sequence}` } });
  const req = { body: { ...audioExample(kind), model, text: 'secret prompt', prompt: 'secret prompt' }, get: () => header };
  let status, body;
  const res = { set() { return this; }, status(n) { status = n; return this; }, json(v) { body = v; return this; } };
  layers[0].route.stack[0].handle(req, res, () => {});
  await layers.at(-1).route.stack[0].handle(req, res);
  assert.equal(status, 503);
  assert.equal(body.error.code, 'no_billable_answer');
  assert.equal(logs.length, 1);
  assert.ok(logs[0].startsWith(`audio job fail ${kind} ${model} `));
  assert.match(logs[0], mode === 'unavailable'
    ? /code=submit_failed job=unknown last=unknown http=503 upstream=no_healthy_sellers ms=\d+$/
    : /code=(?:job_failed|timeout) job=job123 last=failed http=unknown upstream=unknown ms=\d+$/);
  for (const secret of ['secret Surplus error message', 'our-key', 'secret-job-token', 'secret-payment', header, config.payToBase, 'secret prompt']) assert.ok(!logs[0].includes(secret));
});

test('sold audio model list explicitly has free OpenAPI security', async t => {
  const { createApp } = await import('../src/app.mjs');
  const app = createApp({ ...config, model: 'default' }, { facilitatorClient: fixture().facilitatorClient, catalogue: { async list() { return []; }, async resolve() { throw new Error('unavailable'); } }, log: () => {} });
  const listener = await new Promise(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/openapi.json`);
  assert.equal(response.status, 200);
  const doc = await response.json();
  assert.ok(doc.paths['/v1/audio/generation-models']);
  assert.deepEqual(doc.paths['/v1/audio/generation-models'].get.security, []);
});

test('video OpenAPI paid path follows sold and discoverable switches', async () => {
  const { createApp } = await import('../src/app.mjs');
  for (const sold of [undefined, false, true]) for (const discoverable of [undefined, false, true]) {
    const app = createApp({ ...config, videoSold: sold, videoDiscoverable: discoverable }, {
      catalogue: { async list() { return []; }, async resolve() { throw new Error('unavailable'); } }, facilitatorClient: fixture().facilitatorClient, log: () => {},
    });
    const invoke = async path => {
      let result;
      await app.router.stack.find(l => l.route?.path === path).route.stack.at(-1).handle(
        { protocol: 'https', get: () => 'ask.singitai.app' }, { json(v) { result = v; } });
      return result;
    };
    const doc = await invoke('/openapi.json');
    const discovery = await invoke('/.well-known/x402');
    const advertised = sold === true && discoverable === true;
    assert.equal(Boolean(doc.paths['/v1/video/generations']), advertised);
    assert.equal(discovery.resources.some(r => r.endsWith('/v1/video/generations')), advertised);
  }
});

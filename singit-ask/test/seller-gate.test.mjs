import test from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { ModelCatalogue, markUnservable, SELLER_FAILURE_CODES } from '../src/catalogue.mjs';
import { createApp } from '../src/app.mjs';
import { formatRequestBody, FORMAT_ROUTES } from '../src/formats.mjs';
import { HealthStats, healthBody } from '../src/health-stats.mjs';
import { CONFIG, fakeFacilitator } from './auto-router-fixtures.mjs';
const log = () => {};
const failure = (c, id, error = { code: 'minimum_discount_not_met' }) => markUnservable(c, id, error, log);
// Exercise Express and x402 without opening sockets or contacting any service.
export function request(app, path, body, method = 'POST', headers = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    const req = new IncomingMessage(socket);
    req.url = path; req.method = method; req.headers = { host: 'offline.test', ...headers }; req.body = body;
    const res = new ServerResponse(req); res.assignSocket(socket);
    res.on('finish', () => resolve({ status: res.statusCode, headers: res.getHeaders(), raw: Buffer.concat(chunks).toString() }));
    res.on('error', reject);
    app.handle(req, res); req.push(null);
  });
}
test('seller classification, streak window, reset and immediate no sellers', () => {
  assert.deepEqual(SELLER_FAILURE_CODES, ['no_healthy_sellers', 'minimum_discount_not_met', 'unreachable']);
  for (const error of [{ code: 'minimum_discount_not_met' }, { code: 'unreachable' }, { name: 'UpstreamError', status: 500 }, { name: 'NoAnswer', status: 503 }]) {
    let now = 0;
    const c = new ModelCatalogue({ url: 'unused', now: () => now });
    failure(c, 'm', error); failure(c, 'm', error);
    assert.equal(c.isUnservable('m'), false);
    now += 86400001; failure(c, 'm', error);
    assert.equal(c.isUnservable('m'), false);
    failure(c, 'm', error); failure(c, 'm', error);
    assert.equal(c.isUnservable('m'), true);
    assert.equal(c.unservableSnapshot().get('m').reason, 'recent_failures');
    c.noteAnswered('m'); assert.equal(c.isUnservable('m'), false);
    failure(c, 'm', error); assert.equal(c.isUnservable('m'), false);
  }
  for (const code of ['model_not_found', 'max_tokens_spent_reasoning', 'no_text', 'ceiling_exceeded']) {
    const c = new ModelCatalogue({ url: 'unused' });
    for (let n = 0; n < 6; n++) failure(c, 'm', { name: 'UpstreamError', status: code === 'model_not_found' ? 404 : 503, code });
    assert.equal(c.isUnservable('m'), false);
  }
  for (const status of [400, 413, 422]) {
    const c = new ModelCatalogue({ url: 'unused' });
    for (let n = 0; n < 6; n++) failure(c, 'm', { name: 'UpstreamError', status });
    assert.equal(c.isUnservable('m'), false);
  }
  const c = new ModelCatalogue({ url: 'unused' }); failure(c, 'm', { code: 'no_healthy_sellers' });
  assert.equal(c.isUnservable('m'), true);
});
test('all four quote paths and probes gate before 402, expire, rearm and recover', async () => {
  for (const backbone of [false, true]) {
    let now = 1000;
    const id = CONFIG.model;
    const c = new ModelCatalogue({ url: 'unused', now: () => now, unservableTtlMs: 1000, neverHide: backbone ? [id] : [] });
    c.models = new Map([[id, { id, promptUsdPerToken: .000001, completionUsdPerToken: .000001 }]]);
    c.rawModels = c.models; c.loadedAt = now;
    const app = createApp(CONFIG, { catalogue: c, facilitatorClient: fakeFacilitator(), fetchImpl: async () => { throw new Error('external fetch forbidden'); }, log });
    // Test an ordinary model too: createApp intentionally protects the configured default.
    if (!backbone) c.neverHide.delete(id);
    const paths = [
      ['/v1/chat/completions', { model: id, messages: [{ role: 'user', content: 'hi' }] }],
      [`/v1/chat/${id}`, { messages: [{ role: 'user', content: 'hi' }] }],
      ['/v1/messages', { model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 300 }],
      ['/v1/responses', { model: id, input: 'hi', max_output_tokens: 300 }],
    ];
    for (let n = 0; n < 3; n++) failure(c, id);
    for (const [path, body] of paths) {
      const r = await request(app, path, body);
      assert.equal(r.status, 503, path); assert.ok(r.headers['retry-after']);
      assert.equal(r.headers['payment-required'], undefined); assert.match(r.raw, /no_healthy_sellers/);
    }
    for (const method of ['GET', 'HEAD', 'POST']) for (const path of [`/v1/chat/${id}`, '/v1/responses']) assert.equal((await request(app, path, {}, method)).status, 503);
    const h = healthBody(new HealthStats({ now: () => now }), null, id, c.unservableSnapshot());
    assert.equal(h.models[id].reason, 'recent_failures'); assert.ok(h.models[id].retryAfterSeconds > 0);
    now += 1000;
    for (const [path, body] of paths) assert.equal((await request(app, path, body)).status, 402, path);
    failure(c, id); assert.equal(c.unservable.get(id) - now, 2000);
    failure(c, id); assert.equal(c.isSuspended(id), !backbone);
    c.noteAnswered(id); assert.equal(c.isSuspended(id), false); assert.equal(c.isUnservable(id), false);
  }
});
test('every format discovery example uses a createApp never-hide model', () => {
  const c = new ModelCatalogue({ url: 'unused' });
  createApp(CONFIG, { catalogue: c, facilitatorClient: fakeFacilitator(), log });
  for (const route of Object.keys(FORMAT_ROUTES)) assert.ok(c.neverHide.has(formatRequestBody(route).content['application/json'].example.model), route);
});

test('format paid errors preserve status and discount, gate, and recover on a successful trial', async () => {
  for (const route of Object.keys(FORMAT_ROUTES)) for (const kind of ['minimum_discount_not_met', 'unreachable', 'http_500', 'no_healthy_sellers']) {
    let now = 1000, succeeding = false;
    const id = CONFIG.model;
    const c = new ModelCatalogue({ url: 'unused', now: () => now, unservableTtlMs: 1000 });
    c.models = new Map([[id, { id, promptUsdPerToken: .000001, completionUsdPerToken: .000001 }]]);
    c.rawModels = c.models; c.loadedAt = now; c.guardShares.set(id, .05);
    const fetchImpl = async () => {
      if (succeeding) return Response.json(route === '/v1/messages'
        ? { content: [{ type: 'text', text: 'answer' }], usage: { buyer_cost_micro: 1 } }
        : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }], usage: { buyer_cost_micro: 1 } });
      if (kind === 'unreachable') throw new Error('offline');
      return Response.json({ error: { code: kind === 'http_500' ? 'upstream_error' : kind,
        message: 'Best otherwise-eligible estimated discount is 93.75%' } }, { status: kind === 'http_500' || kind === 'no_healthy_sellers' ? 503 : 404 });
    };
    const app = createApp(CONFIG, { catalogue: c, facilitatorClient: fakeFacilitator(), fetchImpl, log });
    const body = route === '/v1/messages' ? { model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 300 }
      : { model: id, input: 'hi', max_output_tokens: 300 };
    const paid = async () => {
      const quote = await request(app, route, body);
      assert.equal(quote.status, 402);
      const required = JSON.parse(Buffer.from(quote.headers['payment-required'], 'base64').toString());
      const accepted = required.accepts.find(a => a.scheme === 'upto' && a.network.startsWith('eip155:'));
      return request(app, route, body, 'POST', { 'payment-signature': Buffer.from(JSON.stringify({ x402Version: 2,
        resource: required.resource, accepted, payload: { signature: 'test-only' }, extensions: required.extensions })).toString('base64') });
    };
    for (let n = 0; n < (kind === 'no_healthy_sellers' ? 1 : 3); n++) {
      assert.equal((await paid()).status, 503);
      if (kind === 'minimum_discount_not_met') assert.equal(c.guardShare(id), .0625);
    }
    assert.equal(c.isUnservable(id), true, `${route} ${kind}`);
    assert.equal((await request(app, route, body)).status, 503);
    now += 1000; succeeding = true;
    assert.equal((await paid()).status, 200);
    assert.equal(c.isUnservable(id), false);
    assert.equal(c.guardShare(id), .05);
    assert.equal(c.rejections.has(id), false);
  }
});

test('audio list marks all six transcription ids as not payable over x402', async () => {
  const { parseVoiceModels } = await import('../src/catalogue.mjs');
  const ids = ['venice-xai-stt-v1', 'venice-whisper-1', 'venice-whisper-large-v3', 'venice-parakeet-asr', 'fal-wizper', 'elevenlabs-scribe-v2'];
  const c = new ModelCatalogue({ url: 'unused' });
  c.voice = parseVoiceModels({ data: [
    ...ids.map(id => ({ id, architecture: { modality: 'audio->text' }, pricing: { image: .01, media_unit: 'minute' } })),
    { id: 'test-tts', architecture: { modality: 'text->audio' }, pricing: { image: .01, media_unit: '1K characters' } },
  ] });
  c.models = new Map(); c.loadedAt = Date.now();
  const app = createApp(CONFIG, { catalogue: c, facilitatorClient: fakeFacilitator(), log });
  const response = await request(app, '/v1/audio/models', {}, 'GET');
  assert.equal(response.status, 200);
  assert.equal(c.voice.transcription.size, 6);
  const data = JSON.parse(response.raw.slice(response.raw.indexOf('{'))).data;
  for (const id of ids) {
    const row = data.find(m => m.id === id);
    assert.equal(row.kind, 'transcription'); assert.equal(row.x402, false); assert.equal(row.route, null);
  }
  const tts = data.find(m => m.id === 'test-tts');
  assert.equal(tts.x402, true); assert.equal(tts.route, '/v1/audio/speech');
});

test('backbone models stay listed while their paid routes are gated', async () => {
  const c = new ModelCatalogue({ url: 'unused' });
  const id = CONFIG.model;
  c.models = new Map([[id, { id, promptUsdPerToken: .000001, completionUsdPerToken: .000001 }]]);
  c.loadedAt = Date.now(); c.prices = new Map(); c.pricesAt = Date.now();
  const app = createApp(CONFIG, { catalogue: c, facilitatorClient: fakeFacilitator(), log });
  failure(c, id, { code: 'no_healthy_sellers' });
  const list = await request(app, '/v1/models', {}, 'GET');
  assert.equal(list.status, 200); assert.match(list.raw, new RegExp(id)); assert.match(list.raw, /singit-ask/);
  assert.equal(await c.listable(id), true);
});

test('a half-open no-sellers gate rearms immediately on a different seller failure', () => {
  let now = 0;
  const c = new ModelCatalogue({ url: 'unused', now: () => now, unservableTtlMs: 1000 });
  failure(c, 'm', { code: 'no_healthy_sellers' }); now += 1000;
  assert.equal(c.isUnservable('m'), false);
  failure(c, 'm', { code: 'unreachable' });
  assert.equal(c.isUnservable('m'), true); assert.equal(c.unservable.get('m') - now, 2000);
});

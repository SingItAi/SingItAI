import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { ServerResponse } from 'node:http';
import { createApp, BASE, SOLANA } from '../src/app.mjs';
import { errorCodesMiddleware } from '../src/errors.mjs';
import { spendLimitMiddleware } from '../src/spend-limit.mjs';
import { addPriceRoutes } from '../src/prices.mjs';
import { FreeAllowance, addFreeRoute } from '../src/free.mjs';
import { UnknownModel } from '../src/catalogue.mjs';
import express from 'express';

// Exercise Express and its body parser without binding a socket or making network calls.
function request(app, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    Object.assign(req, { method, url: path, headers: { host: 'ask.test', ...headers }, httpVersionMajor: 1,
      httpVersionMinor: 1, httpVersion: '1.1', socket: { remoteAddress: '127.0.0.1' } });
    if (body !== undefined) req.headers['content-length'] = String(Buffer.byteLength(body));
    const res = new ServerResponse(req);
    const chunks = [];
    const socket = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    res.assignSocket(socket);
    res.on('error', reject);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      const text = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      try { resolve({ status: res.statusCode, headers: res.getHeaders(), body: text ? JSON.parse(text) : null }); }
      catch (e) { reject(new Error(text, { cause: e })); }
    });
    app.handle(req, res);
  });
}
const config = { payToBase: '0x' + '1'.repeat(40), payToSolana: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  surplusKey: 'inf_test', model: 'deepseek-v4.1-flash' };
const facilitator = { async getSupported() { return { kinds: [
  { x402Version: 2, scheme: 'exact', network: BASE },
  { x402Version: 2, scheme: 'exact', network: SOLANA, extra: { feePayer: config.payToSolana } },
  { x402Version: 2, scheme: 'upto', network: BASE, extra: { facilitatorAddress: config.payToBase } },
  { x402Version: 2, scheme: 'upto', network: SOLANA, extra: { feePayer: config.payToSolana, receiverAuthorizer: config.payToSolana } },
], extensions: [], signers: {} }; } };
const never = () => { throw new Error('unexpected external call'); };
const catalogue = { resolve: async () => { throw new UnknownModel('That model is not available.'); }, list: async () => [], canAnswer: async () => true };
const app = createApp(config, { facilitatorClient: facilitator, catalogue, fetchImpl: never, upstream: never, log: () => {} });

test('parser errors preserve messages and types and add precise codes across formats', async () => {
  for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) {
    for (const [body, status, code, message] of [['{', 400, 'invalid_json', 'Send valid JSON.'],
      [JSON.stringify({ x: 'x'.repeat(130 * 1024) }), 413, 'payload_too_large', 'The request body is too large.']]) {
      const result = await request(app, path, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
      assert.equal(result.status, status);
      assert.deepEqual(result.body.error, { type: 'invalid_request_error', message, code });
      if (path === '/v1/messages') assert.equal(result.body.type, 'error');
    }
  }
});
test('unknown routes return a JSON code and model errors keep format envelopes', async () => {
  assert.equal((await request(app, '/missing')).body.error.code, 'not_found');
  const chat = await request(app, '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'missing', messages: [{ role: 'user', content: 'hello' }] }) });
  assert.equal(chat.status, 400); // Preserve chat's existing status for an unknown model.
  assert.deepEqual(chat.body.error, { type: 'invalid_request_error', message: 'That model is not available.', code: 'model_not_found' });
  for (const path of ['/v1/messages', '/v1/responses']) {
    const result = await request(app, path, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'missing', max_tokens: 40, messages: [{ role: 'user', content: 'hello' }], input: 'hello' }) });
    assert.equal(result.status, 404);
    assert.deepEqual(result.body.error, { type: path === '/v1/messages' ? 'not_found_error' : 'invalid_request_error',
      message: 'That model is not available.', code: 'model_not_found' });
  }
});
test('402 body mirrors the header and middleware leaves header bytes intact', async () => {
  const result = await request(app, '/v1/chat/completions', { method: 'POST' });
  assert.equal(result.status, 402);
  const challenge = JSON.parse(Buffer.from(result.headers['payment-required'], 'base64'));
  assert.deepEqual(result.body.accepts, challenge.accepts);
  assert.equal(result.body.x402Version, challenge.x402Version);
  assert.equal(result.body.code, 'payment_required');
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: 'exact' }] }, null, 2)).toString('base64');
  const small = express();
  small.use(errorCodesMiddleware, spendLimitMiddleware());
  small.get('/', (_req, res) => res.status(402).set('PAYMENT-REQUIRED', header).json({}));
  assert.equal((await request(small, '/')).headers['payment-required'], header);
});
test('fallback adds codes without changing existing fields or success bodies', async () => {
  for (const [status, original, code] of [[409, { error: { type: 'invalid_request_error', message: 'This payment was already used.' } }, 'payment_duplicate'],
    [503, { error: { type: 'upstream_error', message: 'No answer', code: 'no_billable_answer' } }, 'no_billable_answer'],
    [503, { error: 'verification_unavailable' }, 'verification_unavailable'],
    [500, { error: 'Internal Server Error' }, 'internal_error'],
    [400, { error: { message: 'old', type: 'old', code: 'legacy_code' } }, 'legacy_code']]) {
    const small = express(); small.use(errorCodesMiddleware);
    small.get('/', (_req, res) => res.status(status).json(original));
    const result = await request(small, '/');
    assert.equal(typeof original.error === 'string' ? result.body.code : result.body.error.code, code);
    for (const [key, value] of Object.entries(original.error)) if (typeof original.error !== 'string') assert.equal(result.body.error[key], value);
  }
  const small = express(); small.use(errorCodesMiddleware); small.get('/', (_req, res) => res.json({ error: 'success data' }));
  assert.deepEqual((await request(small, '/')).body, { error: 'success data' });
});
test('daily free allowance headers follow its clock; busy advertises only retry timing', async () => {
  const now = () => Date.UTC(2026, 9, 31, 23, 59, 30);
  const terms = { models: ['test'], perVisitorPerDay: 1, perDay: 10, concurrent: 1, chars: 100, maxTokens: 10 };
  for (const busy of [false, true]) {
    const allowance = new FreeAllowance(terms, now);
    if (busy) allowance.running = 1;
    else { allowance.take('127.0.0.0/24'); allowance.done(); }
    const small = express(); small.use(errorCodesMiddleware, express.json());
    addFreeRoute(small, '/', { config: {}, terms, allowance, readRequest: () => ({ chars: 1 }), RequestError: Error, upstream: never });
    const result = await request(small, '/', { method: 'POST', body: '{"model":"free/test"}', headers: { 'content-type': 'application/json' } });
    assert.equal(result.status, 429);
    assert.equal(result.body.error.code, busy ? 'free_tier_busy' : 'free_tier_exhausted');
    assert.equal(result.body.error.type, 'rate_limit_error');
    assert.equal(result.headers['retry-after'], busy ? '5' : '30');
    assert.equal(result.headers['x-ratelimit-limit'], busy ? undefined : '1');
    if (!busy) {
      assert.equal(result.headers['x-ratelimit-remaining'], '0');
      assert.equal(Number(result.headers['x-ratelimit-reset']), now() / 1000 + 30);
    }
  }
});
test('price limiter headers describe the actual minute window and allowance', async () => {
  let clock = 120_250;
  const now = () => clock;
  const small = express(); small.use(errorCodesMiddleware);
  addPriceRoutes(small, { now, book: { list: async () => ({}) }, open: (_req, _res, next) => next() });
  for (let i = 0; i < 60; i++) assert.equal((await request(small, '/v1/prices')).status, 200);
  const result = await request(small, '/v1/prices');
  assert.equal(result.status, 429);
  assert.equal(result.body.error.code, 'rate_limited');
  assert.equal(result.headers['x-ratelimit-limit'], '60');
  assert.equal(result.headers['x-ratelimit-remaining'], '0');
  assert.equal(result.headers['x-ratelimit-reset'], '180');
  assert.equal(result.headers['retry-after'], '60');
  assert.ok(Number(result.headers['x-ratelimit-reset']) - Math.floor(now() / 1000) <= Number(result.headers['retry-after']));
  clock = 180_000;
  assert.equal((await request(small, '/v1/prices')).status, 200);
});
test('OpenAPI error refs resolve, including every nested ref', async () => {
  const { body: doc } = await request(app, '/openapi.json');
  for (const name of ['ErrorResponse', 'AnthropicErrorResponse', 'PaymentRequired402', 'RateLimited429']) assert.ok(doc.components.schemas[name]);
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) assert.ok(value.$ref.slice(2).split('/').reduce((v, key) => v?.[key], doc), value.$ref);
    Object.values(value).forEach(walk);
  }
  walk(doc);
  assert.equal(doc.paths['/v1/messages'].post.responses[400].content['application/json'].schema.$ref, '#/components/schemas/AnthropicErrorResponse');
});

test('paid image duplicate and no-billable-answer errors preserve their existing messages', async () => {
  const { parseImageModels } = await import('../src/catalogue.mjs');
  const images = parseImageModels({ data: [{ id: 'venice-test', name: 'test', provider: 'venice', metering: 'per_image', pricing: { image: '0.01' },
    architecture: { modality: 'text->image', input_modalities: ['text'], output_modalities: ['image'] } }] });
  const body = JSON.stringify({ model: 'venice-test', prompt: 'a tree' });
  for (const empty of [false, true]) {
    let settlements = 0;
    const client = { ...facilitator, verify: async () => ({ isValid: true, payer: config.payToBase }),
      settle: async (_payload, requirements) => { settlements++; return { success: true, transaction: '0x' + 'a'.repeat(64), network: requirements.network }; } };
    const paidApp = createApp({ ...config, surplusUrl: 'https://surplus.invalid' }, {
      facilitatorClient: client, catalogue: { ...catalogue, imageModels: async () => images, resolveImage: async id => images.get(id) },
      fetchImpl: async () => new Response(JSON.stringify({ data: empty ? [] : [{ b64_json: 'aW1hZ2U=' }] }), { headers: { 'content-type': 'application/json' } }), log: () => {} });
    const options = { method: 'POST', body, headers: { 'content-type': 'application/json' } };
    const unpaid = await request(paidApp, '/v1/images/generations', options);
    const required = JSON.parse(Buffer.from(unpaid.headers['payment-required'], 'base64'));
    options.headers['payment-signature'] = Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource,
      accepted: required.accepts.find(a => a.network === BASE), payload: { signature: '0xsigned' }, extensions: required.extensions })).toString('base64');
    const paid = await request(paidApp, '/v1/images/generations', options);
    if (empty) {
      assert.equal(paid.status, 503);
      assert.deepEqual(paid.body.error, { type: 'upstream_error', message: 'No image was made. You were not charged.', code: 'no_billable_answer' });
      assert.equal(settlements, 0);
    } else {
      assert.equal(paid.status, 200);
      const duplicate = await request(paidApp, '/v1/images/generations', options);
      assert.equal(duplicate.status, 409);
      assert.deepEqual(duplicate.body.error, { type: 'invalid_request_error', message: 'This payment was already used.', code: 'payment_duplicate' });
      assert.equal(settlements, 1);
    }
  }
});

test('402 challenge keeps existing limiter metadata and header unchanged', async () => {
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: 'exact' }] })).toString('base64');
  const small = express();
  small.use(errorCodesMiddleware, spendLimitMiddleware({ reader: { read: async () => ({ v: 1, error: 'unreadable' }) } }));
  small.get('/', (_req, res) => res.status(402).set('PAYMENT-REQUIRED', header).json({}));
  const result = await request(small, '/', { headers: { 'x-singit-limiter': 'test' } });
  assert.equal(result.headers['payment-required'], header);
  assert.deepEqual(result.body.singitSpendLimit, { v: 1, error: 'unreadable' });
  assert.deepEqual(JSON.parse(result.headers['x-singit-spend-limit']), result.body.singitSpendLimit);
  assert.deepEqual(result.body.accepts, [{ scheme: 'exact' }]);
});

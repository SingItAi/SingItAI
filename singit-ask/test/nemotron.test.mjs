import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseModels, ModelCatalogue, canServe, cheapestShare } from '../src/catalogue.mjs';
import { createApp, BASE, SOLANA } from '../src/app.mjs';
import { request } from './helpers/http-request.mjs';
import { invoke, answeredFormat } from './helpers/reasoning-routes.mjs';
import { DEFAULT_FREE_MODELS } from '../src/free.mjs';

const entry = JSON.parse(readFileSync(new URL('./fixtures/surplus-nemotron-3-5-lightning.json', import.meta.url)));
const id = 'nemotron-3.5-lightning';
const models = parseModels({ data: [entry] });
const info = models.get(id);
const config = { model: 'deepseek-v4.1-flash', surplusUrl: 'https://surplus.invalid', surplusKey: 'test',
  payToBase: '0x1111111111111111111111111111111111111111',
  payToSolana: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', observedFile: '/nonexistent/m3-observed.json' };
const catalogue = { models, list: async () => [...models.values()], resolve: async key => {
  if (!models.has(key)) throw new Error('unknown'); return models.get(key);
}, canAnswer: async () => true };
const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64');
const decode = header => JSON.parse(Buffer.from(header, 'base64').toString());
function fixture(fetchImpl) {
  const settlements = [];
  const facilitatorClient = {
    getSupported: async () => ({ kinds: [BASE, SOLANA].flatMap(network => ['upto', 'exact'].map(scheme => ({
      x402Version: 2, scheme, network, extra: network === SOLANA ? {
        feePayer: 'Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88',
        receiverAuthorizer: '9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox',
      } : { facilitatorAddress: '0x' + '3'.repeat(40) },
    }))), extensions: [], signers: {} }),
    verify: async () => ({ isValid: true, payer: '0x' + '2'.repeat(40) }),
    settle: async (_payload, requirements) => { settlements.push({ type: _payload.payload.type, amount: requirements.amount }); return { success: true, transaction: '0x' + 'a'.repeat(64), network: requirements.network }; },
  };
  return { app: createApp(config, { catalogue, facilitatorClient, fetchImpl, log() {} }), settlements: () => settlements };
}
const body = JSON.stringify({ model: id, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 400 });
const post = (app, path, headers = {}) => request(app, path, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

test('Nemotron metadata has one public id, paid list rates, and a narrow missing-cap exception', () => {
  assert.equal(models.size, 1);
  assert.equal(info.name, 'NVIDIA Nemotron 3.5 Lightning');
  assert.equal(info.provider, 'NVIDIA');
  assert.equal(info.contextLength, 1000000);
  assert.equal(info.promptUsdPerToken, 0.07e-6);
  assert.equal(info.completionUsdPerToken, 0.20e-6);
  assert.ok(!info.params.includes('temperature'));
  assert.ok(!info.params.includes('max_tokens'));
  assert.equal(parseModels({ data: [{ ...entry, id: 'unreviewed-model' }] }).size, 0);
  assert.ok(!DEFAULT_FREE_MODELS.includes(id));
});

test('Nemotron marketplace reads use upstream id and match upstream book/offer ids', async () => {
  const book = { model: entry.id, offers: [{ model: entry.id, trusted: true, healthy: true, available: true, discount_pct: 10 }] };
  assert.equal(canServe(book, new Set(), id), true);
  assert.equal(cheapestShare(book, new Set(), id), 0.9);
  assert.equal(canServe({ ...book, model: 'different' }, new Set(), id), false);
  const urls = [];
  const cat = new ModelCatalogue({ url: config.surplusUrl, fetchImpl: async url => {
    urls.push(url);
    return Response.json(url.endsWith('/v1/models') ? { data: [entry] }
      : url.endsWith('/api/marketplace') ? { data: { markets: [{ model: entry.id, best_trusted_offer_discount_pct: 10 }] } } : book);
  } });
  await cat.all(); await cat.loadServed();
  assert.ok(urls.includes(`${config.surplusUrl}/api/markets/${entry.id}`));
  assert.equal(await cat.canAnswer(id), true);
  assert.deepEqual((await cat.market()).get(id), { trustedShare: 0.9 });
  assert.equal(await cat.liveDiscount(id), 0.9);
});

test('Nemotron is listed with paid prices and in OpenAPI and x402 discovery', async () => {
  const { app } = fixture(async () => { throw new Error('unexpected upstream'); });
  const listing = await request(app, '/v1/models');
  const model = listing.body.data.find(m => m.id === id);
  assert.equal(model.usdPerMillionTokens.input, 0.07);
  assert.ok(Math.abs(model.usdPerMillionTokens.output - 0.2) < 1e-12);
  assert.ok(!listing.body.data.some(m => m.id === entry.id));
  const spec = await request(app, '/openapi.json');
  assert.ok(spec.body.paths[`/v1/chat/${id}`]);
  const discovery = await request(app, '/.well-known/x402');
  assert.match(JSON.stringify(discovery.body), /\/v1\/chat\/nemotron-3.5-lightning/);
});

for (const path of [`/v1/chat/${id}`, '/v1/chat/completions']) {
  for (const network of [BASE, SOLANA]) {
    for (const scheme of ['upto', 'exact']) {
      for (const status of [200, 400, 503]) {
        test(`Nemotron ${path} ${network} ${scheme}: upstream ${status}, charge only success`, async () => {
          const sent = [];
          const { app, settlements } = fixture(async (_url, init) => {
            sent.push(JSON.parse(init.body));
            return Response.json(status === 200 ? { choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 2, completion_tokens: 3, buyer_cost_micro: 1 } }
              : { error: { code: 'request_rejected', message: 'Provider refused' } }, { status });
          });
          const challenge = await post(app, path);
          assert.equal(challenge.status, 402);
          const required = decode(challenge.headers['payment-required']);
          const accepted = required.accepts.find(a => a.network === network && a.scheme === scheme);
          assert.ok(BigInt(accepted.amount) > 0n);
          assert.equal(accepted.extra.billing.markupBps, 3000);
          assert.equal(accepted.extra.billing.settlementFeeAtomic, network === BASE ? '1000' : '2000');
          const result = await post(app, path, { 'payment-signature': encode({ x402Version: 2,
            resource: required.resource, accepted, payload: { signature: '0xsigned' }, extensions: required.extensions }) });
          assert.equal(sent.length, 1);
          assert.equal(sent[0].model, entry.id);
          assert.equal(sent[0].max_tokens, 656);
          assert.ok(!Object.hasOwn(sent[0], 'temperature'));
          // Since #219 the general chat route reads requests as agent conversations: a seller that rejects
          // the request (HTTP 400) is a 400 upstream_rejected_request, uncharged. That is the documented
          // contract (singit-ask/ERRORS.md: "upstream_rejected_request — The upstream provider rejected the
          // request"; src/metered.mjs; test/agent-chat.test.mjs). The per-model route keeps the 503
          // no_billable_answer. Either way nothing settles or is charged, checked below.
          const rejected = status === 400 && path === '/v1/chat/completions';
          assert.equal(result.status, status === 200 ? 200 : rejected ? 400 : 503);
          if (status !== 200) assert.deepEqual([result.body.error.type, result.body.error.code], rejected
            ? ['invalid_request_error', 'upstream_rejected_request'] : ['upstream_error', 'no_billable_answer']);
          if (network === SOLANA && scheme === 'upto') {
            // Existing Solana escrow protocol deposits first, then claims zero to refund on error.
            assert.equal(settlements().length, 2);
            assert.equal(settlements()[0].type, 'deposit');
            assert.equal(settlements()[1].type, 'claim');
            assert.equal(BigInt(settlements()[1].amount) > 0n, status === 200);
          } else assert.equal(settlements().length, status === 200 ? 1 : 0);
        });
      }
    }
  }
}

for (const route of ['/v1/messages', '/v1/responses']) {
  test(`Nemotron ${route} maps the upstream body too`, async () => {
    let sent;
    const { app } = fixture(async (_url, init) => {
      sent = JSON.parse(init.body);
      return Response.json({ ...answeredFormat(route), usage: { buyer_cost_micro: 1 } });
    });
    const result = await invoke(app, info, route);
    assert.equal(result.statusCode, 200);
    assert.equal(sent.model, entry.id);
  });
}

import { lintChallenge, challengeWithBodyExtensions } from '../../scripts/bazaar-lint.mjs';
import { BASE, SOLANA, MIN_CEILING_ATOMIC } from '../src/pricing.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serve, CONFIG, request as fetch } from './fixtures/listing-harness.mjs';
import { readRequest, chooseModel } from '../src/app.mjs';
import { readFormatRequest } from '../src/formats.mjs';
import { ceilings, probeInput } from '../src/metered.mjs';
import { priceGuard } from '../src/catalogue.mjs';
import { MODEL_ROUTES, modelExample, chooseModelRoute } from '../src/model-routes.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/listing-prices.json', import.meta.url)));
const baseline = JSON.parse(readFileSync(new URL('./fixtures/listing-baseline.json', import.meta.url)));
const models = Object.entries(fixture).map(([id, p]) => ({ id, promptUsdPerToken: p.input / 1e6,
  completionUsdPerToken: p.output / 1e6 }));
let share;
const catalogue = {
  async resolve(id) { const m = models.find(m => m.id === id); if (!m) throw Error('unknown model'); return m; },
  async list() { return models; }, async canAnswer() { return true; },
  guardShare(id) { return share ?? fixture[id]?.guardShare ?? null; },
};
const decode = response => JSON.parse(Buffer.from(response.headers.get('payment-required'), 'base64'));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const buckets = q => Object.fromEntries(q.accepts.map(a => [`${a.scheme}:${a.network}`, Number(a.amount)]));
const ge = (upper, lower, context) => {
  for (const key of Object.keys(lower)) assert.ok(upper[key] >= lower[key], `${context} ${key}: ${upper[key]} >= ${lower[key]}`);
};
const mismatches = ['claude-sonnet-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gemini-3.1-pro-preview',
  'gemini-3.8-flash', 'kimi-k3', 'claude-opus-5.5', 'gpt-5.5', 'qwen3.8-max-0902'];

test('list probes bound every audit mismatch across live shares, verbs, networks and schemes; real quotes stay unchanged', async t => {
  const { url, facilitator } = await serve(t, catalogue, { probeShare: 'list' });
  const doc = await (await fetch(url + '/openapi.json')).json();
  const paths = [...mismatches.map(id => '/v1/chat/' + id), '/v1/chat/completions', '/v1/messages', '/v1/responses'];
  for (const path of paths) {
    const op = doc.paths[path].post;
    const example = op.requestBody.content['application/json'].example;
    const baselineQuote = buckets(decode(await post(url + path, example)));
    assert.deepEqual(baselineQuote, baseline[path], path + ": main 2be6464 real quote");
    const probes = [];
    for (const method of ['GET', 'HEAD', 'POST']) {
      const response = await fetch(url + path, { method });
      assert.equal(response.status, 402);
      const challenge = decode(response);
      assert.ok(challenge.resource.description.length <= 500);
      const full = await (method === "HEAD" ? await fetch(url + path) : response).json();
      assert.match(full.extensions.bazaar.schema.properties.input.properties.body.description, /Listed price = ceiling for the example/);
      probes.push(buckets(challenge));
    }
    assert.deepEqual(probes[0], probes[1]); assert.deepEqual(probes[0], probes[2]);
    for (const liveShare of [0.3, 0.5, 0.7, 0.9, 1]) {
      share = liveShare;
      const real = buckets(decode(await post(url + path, example)));
      ge(probes[0], real, path);
      // Baseline POST formula: unchanged parser + chooser/guard + ceilings, independent of probe policy.
      const input = path === '/v1/messages' || path === '/v1/responses'
        ? readFormatRequest(path, example) : readRequest(example);
      const chosen = path === '/v1/chat/completions' ? await chooseModel(CONFIG, catalogue, input)
        : path.startsWith('/v1/chat/') ? await chooseModelRoute(catalogue, example.model, 1, input)
          : { ...input, info: await catalogue.resolve(input.model), ...priceGuard(catalogue, input.model, 1) };
      const expected = ceilings(chosen.info, chosen);
      for (const a of decode(await post(url + path, example)).accepts) {
        assert.equal(a.amount, expected[a.scheme][a.network]);
        assert.ok(Number(op['x-payment-info'].price.max) * 1e6 >= probes[0][`${a.scheme}:${a.network}`]);
      }
    }
    share = undefined;
  }
  assert.equal(facilitator.calls.verify, 0); assert.deepEqual(facilitator.calls.settle, []);
});

test('1200 probe budget bounds verifier 2000 requests; default listing only promises example sizes', async t => {
  const normal = await serve(t, catalogue, { probeShare: 'list' });
  const raised = await serve(t, catalogue, { probeShare: 'list', probeMaxTokens: 1200 });
  share = 1;
  for (const id of ['claude-opus-5.5', 'gpt-5.5', 'qwen3.8-max-0902']) {
    const path = '/v1/chat/' + id;
    const example = modelExample(MODEL_ROUTES.find(m => m.id === id));
    const real = buckets(decode(await post(normal.url + path, { ...example, max_tokens: 2000 })));
    const probe = buckets(decode(await fetch(normal.url + path)));
    assert.ok(Object.keys(real).some(k => real[k] > probe[k]), id);
    ge(buckets(decode(await fetch(raised.url + path))), real, id);
    const op = (await (await fetch(normal.url + '/openapi.json')).json()).paths[path].post;
    assert.match(op['x-payment-info'].notes, /above 1200 counts as 1200/);
    assert.equal(readRequest({ ...example, max_tokens: 2000 }).maxTokens, 1200);
  }
  share = undefined;
});

test('live mode reproduces tight snapshot probes; list policy does not mutate the real input', async t => {
  const { url } = await serve(t, catalogue, { probeShare: 'live' });
  for (const path of [...mismatches.map(id => '/v1/chat/' + id), '/v1/messages', '/v1/responses']) {
    const probe = decode(await fetch(url + path));
    assert.deepEqual(buckets(probe), buckets(decode(await post(url + path, probe.extensions.bazaar.info.input.body))));
  }
  const original = { maxTokens: 400, share: .3, minDiscount: 70, isDefault: true };
  assert.deepEqual(probeInput(original), { ...original, share: 1, minDiscount: null });
  assert.equal(original.share, .3);
  assert.equal(probeInput(original, { probeMaxTokens: 2000 }).maxTokens, 1200);
  const expensive = { id: 'fixture', promptUsdPerToken: 1, completionUsdPerToken: 1 };
  const clamped = ceilings(expensive, probeInput({ ...original, chars: 40, messageCount: 1 }));
  for (const scheme of ['upto', 'exact']) for (const network of [BASE, SOLANA]) {
    assert.equal(clamped[scheme][network], '3000', 'standing default ceiling remains');
    const floor = ceilings({ ...expensive, promptUsdPerToken: 0, completionUsdPerToken: 0 },
      probeInput({ ...original, chars: 0, messageCount: 1, isDefault: false }));
    assert.ok(BigInt(floor[scheme][network]) >= BigInt(MIN_CEILING_ATOMIC));
  }

});

test('formats retain the same guard at equal model, prompt length and output budget', async t => {
  const { url } = await serve(t, catalogue, { probeShare: 'list' });
  for (const model of ['claude-opus-5.5', 'grok-4.7', 'kimi-k3']) {
    const messages = [{ role: 'user', content: 'Say hi.' }];
    const chat = readRequest({ model, messages, max_tokens: 400 });
    const message = readFormatRequest('/v1/messages', { model, messages, max_tokens: 400 });
    const response = readFormatRequest('/v1/responses', { model, input: 'Say hi.', max_output_tokens: 400 });
    const info = await catalogue.resolve(model);
    const guard = priceGuard(catalogue, model, 1);
    const audit = { 'claude-opus-5.5': '18270', 'grok-4.7': '8106', 'kimi-k3': '8811' };
    assert.equal(ceilings(info, { ...message, share: 1 }).upto['eip155:8453'], audit[model], 'audit exactly reproduces list share, not a larger output budget');
    const quote = input => ceilings(info, { ...input, ...guard });
    // Messages additionally prices the serialized envelope; Responses text has the same size as chat.
    assert.ok(message.chars > chat.chars);
    assert.deepEqual(quote(chat), quote(response));
    assert.deepEqual(quote(chat), quote({ ...message, chars: chat.chars }));
    for (const [path, body, input] of [
      ['/v1/chat/' + model, { model, messages, max_tokens: 400 }, chat],
      ['/v1/messages', { model, messages, max_tokens: 400 }, message],
      ['/v1/responses', { model, input: 'Say hi.', max_output_tokens: 400 }, response],
    ]) {
      const required = decode(await post(url + path, body));
      for (const a of required.accepts) assert.equal(a.amount, quote(input)[a.scheme][a.network]);
    }
  }
});


test('all 22 audit route probe prices match the comparison fixture and pass Bazaar challenge lint', async t => {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/listing-probes.json', import.meta.url)));
  assert.equal(rows.length, 22);
  for (const policy of ['live', 'list']) {
    const { url, facilitator } = await serve(t, catalogue, { probeShare: policy });
    for (const row of rows) {
      const response = await fetch(url + row.route, { headers: { host: 'ask.singitai.app', 'x-forwarded-proto': 'https' } });
      const challenge = decode(response);
      const amount = challenge.accepts.find(a => a.network === BASE).amount;
      assert.equal(Number(amount), policy === 'live' ? row.before : row.after, row.route);
      const findings = lintChallenge(challengeWithBodyExtensions(challenge, await response.json()), { route: row.route, networks: [BASE, SOLANA],
        payTo: { [BASE]: CONFIG.payToBase, [SOLANA]: CONFIG.payToSolana } });
      assert.deepEqual(findings.filter(f => f.level === 'FAIL').map(f => f.check), [], row.route);
    }
    assert.equal(facilitator.calls.verify, 0); assert.deepEqual(facilitator.calls.settle, []);
  }
});

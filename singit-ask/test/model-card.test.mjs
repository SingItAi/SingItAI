import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve, request } from './fixtures/listing-harness.mjs';

const id = 'vendor/model';
const model = { id, name: 'Fixture', contextLength: 8192, inputs: ['text', 'image'],
  promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000012 };
const map = (...models) => new Map(models.map(m => [m.id, m]));
const fixture = { list: async () => [model], resolve: async () => model,
  editModels: async () => map({ id: 'qwen-image-2-edit', metering: 'per_image', imageUsd: 0.01 }),
  embeddingModels: async () => map({ id: 'vendor/embed', usdPerMillionTokens: 0.1, limits: { maxInputs: 10 } }),
};

test('model cards and list share catalog membership, prices and safe examples without payment', async t => {
  const { url, facilitator } = await serve(t, fixture, { freeModels: [id] });
  const get = async path => {
    const response = await request(url + path);
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const catalog = await get('/v1/catalog');
  const list = await get('/v1/models');
  const prices = await get('/pricing.json');
  assert.equal(list.data.length, catalog.data.length);
  assert.deepEqual(list.data.map(m => m.id).sort(), catalog.data.map(m => m.id).sort());
  for (const entry of list.data) {
    const card = await get('/v1/models/' + encodeURIComponent(entry.id));
    assert.equal(card.id, entry.id);
    assert.deepEqual(card.price, entry.price);
    assert.deepEqual(card.schemas, entry.schemas);
    assert.equal(card.schemas.openapi, '/openapi.json');
    assert.equal(card.schemas.route, entry.route);
    const openapi = await get(card.schemas.openapi);
    for (const field of ['input', 'output']) {
      const pointer = card.schemas[field].split('#/')[1].split('/')
        .map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
      assert.ok(pointer.reduce((value, key) => value?.[key], openapi), card.schemas[field]);
    }
    for (const field of ['usdPerMillionTokens', 'expectedUsdPerMillionTokens', 'settlementFee', 'singitUsdPerMillionTokens', 'savingsVsListPct']) {
      assert.deepEqual(card[field], entry[field], field);
    }
    if (entry.modality === 'chat' && !entry.router) {
      assert.deepEqual(card.usdPerMillionTokens, { input: model.promptUsdPerToken * 1e6, output: model.completionUsdPerToken * 1e6 });
      assert.deepEqual(card.schemas.requiredBodyFields, ['messages']);
    }
    assert.equal(card.modality, entry.modality);
    assert.ok(card.inputModalities.length);
    assert.ok(card.outputModalities.length);
    assert.equal(card.exampleCall.method, 'POST');
    assert.equal(card.exampleCall.body.model, entry.id);
    assert.ok(Object.keys(card.exampleCall.body).length > 1);
    if (entry.modality === 'image') assert.equal(typeof card.exampleCall.body.prompt, 'string');
    if (entry.modality === 'speech') assert.equal(typeof card.exampleCall.body.input, 'string');
    assert.doesNotMatch(JSON.stringify(card.exampleCall), /0x[a-f0-9]{40}|sk_|Bearer|PAYMENT-SIGNATURE|fixture|wallet|payer/i);
    assert.ok(card.price.currency);
    assert.ok(card.price.unit);
    const priced = prices.models.find(m => m.id === entry.id);
    if (priced?.exact) assert.deepEqual(card.price.exact, priced.exact);
    if (priced?.upto) assert.deepEqual(card.price.upto, priced.upto);
    if (entry.free) assert.equal(card.limits.maxTokens, list.free.maxTokens);
    if (entry.modality === 'speech') assert.equal(card.limits.maxChars, 4096);
    if (entry.id === 'vendor/embed') assert.deepEqual(card.limits, { maxInputs: 10 });
  }
  const raw = await get('/v1/models/' + id);
  assert.deepEqual(raw, await get('/v1/models/' + encodeURIComponent(id)));
  assert.equal(raw.contextLength, 8192);
  assert.deepEqual(raw.context, { length: 8192 });
  assert.deepEqual(raw.inputModalities, ['text', 'image']);
  const old = list.data.find(m => m.id === id);
  assert.equal(old.object, 'model');
  assert.deepEqual(old.usdPerMillionTokens, { input: 3, output: 12 });
  const op = (await get('/openapi.json')).paths['/v1/models/{id}'].get;
  assert.match((await get('/.well-known/x402')).instructions, /\/v1\/models\/\{id\}/);
  assert.ok(op.responses[200].content['application/json'].schema.properties.schemas);
  assert.deepEqual(op.security, []);
  assert.ok(!op.responses[402]);
  assert.equal(facilitator.calls.verify, 0);
  assert.deepEqual(facilitator.calls.settle, []);
});

test('unknown model returns the JSON API error envelope without payment', async t => {
  const { url, facilitator } = await serve(t, fixture);
  const response = await request(url + '/v1/models/unknown%2Fmodel');
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();
  assert.deepEqual(facilitator.calls.settle, []);
  assert.equal(body.error.code, 'not_found');
  assert.equal(typeof body.error.message, 'string');
  assert.equal(typeof body.error.type, 'string');
  assert.equal(facilitator.calls.verify, 0);
});

test('unavailable media does not hide chat; retained models have no invented quote', async t => {
  const { url } = await serve(t, { ...fixture, canAnswer: async () => false,
    resolve: async () => { throw new Error('unavailable'); }, neverHide: new Set([id]),
    imageModels: async () => { throw new Error('unavailable'); },
  });
  const catalog = await (await request(url + '/v1/catalog')).json();
  const list = await (await request(url + '/v1/models')).json();
  assert.deepEqual(list.data.map(m => m.id).sort(), catalog.data.map(m => m.id).sort());
  const response = await request(url + '/v1/models/' + encodeURIComponent(id));
  assert.equal(response.status, 200);
  const card = await response.json();
  assert.equal(card.available, false);
  assert.equal(card.price.mode, 'unavailable');
  assert.equal(card.price.exact, undefined);
});

test('cards preserve known expected prices and savings from the list', async t => {
  const { url, facilitator } = await serve(t, { ...fixture,
    market: async () => new Map([[id, { trustedShare: 0.5 }]]),
  }, { freeModels: [id] });
  const list = await (await request(url + '/v1/models')).json();
  for (const modelId of [id, 'free/' + id]) {
    const card = await (await request(url + '/v1/models/' + encodeURIComponent(modelId))).json();
    const entry = list.data.find(m => m.id === modelId);
    assert.deepEqual(card.expectedUsdPerMillionTokens, { input: 1.5, output: 6, basis: 'trusted', n: 0, window: 20 });
    assert.equal(card.settlementFee.base.usd, 0.001);
    assert.equal(card.settlementFee.solana.usd, 0.002);
    assert.equal(entry.settlementFee.base.usd, 0.001);
    assert.equal(entry.settlementFee.solana.usd, 0.002);
    for (const field of ['usdPerMillionTokens', 'expectedUsdPerMillionTokens', 'settlementFee', 'singitUsdPerMillionTokens', 'savingsVsListPct', 'schemas']) {
      assert.deepEqual(card[field], entry[field], field);
    }
    assert.ok(card.singitUsdPerMillionTokens.input > 1.5);
    assert.equal(typeof card.savingsVsListPct, 'number');
  }
  assert.equal(facilitator.calls.verify, 0);
  assert.deepEqual(facilitator.calls.settle, []);
});

test('unlisted audio and API-key transcription cards retain usable schema definitions', async t => {
  const { url } = await serve(t, { ...fixture, voiceModels: async () => ({
    speech: new Map(), transcription: map({ id: 'vendor/transcribe', usdPerUnit: 0.02 }),
  }) }, { audioDiscoverable: false });
  const list = await (await request(url + '/v1/models')).json();
  for (const entry of list.data.filter(m => ['music', 'sound_effects', 'transcription'].includes(m.modality))) {
    const card = await (await request(url + '/v1/models/' + encodeURIComponent(entry.id))).json();
    assert.deepEqual(card.schemas, entry.schemas);
    if (entry.modality === 'transcription') {
      const { readFile } = await import('node:fs/promises');
      const spec = JSON.parse(await readFile(new URL('../../website/openapi-keys.json', import.meta.url)));
      for (const field of ['input', 'output']) {
        const pointer = card.schemas[field].split('#/')[1].split('/')
          .map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
        assert.ok(pointer.reduce((value, key) => value?.[key], spec));
      }
    } else {
      assert.ok(card.schemas.input.content['application/json'].schema);
      assert.ok(card.schemas.output.description);
    }
  }
});

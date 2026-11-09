import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, BASE, SOLANA } from '../src/app.mjs';
import { parseEditModels, parseEmbeddingModels, UnknownModel } from '../src/catalogue.mjs';
import { paymentDigest, reservations } from '../src/media-payment-replay.mjs';
import { readEditRequest } from '../src/image-edits-request.mjs';
import { readEmbeddingRequest, listAtomic } from '../src/embeddings-request.mjs';
const CONFIG = { payToBase: '0x' + '1'.repeat(40), payToSolana: '1'.repeat(32), surplusUrl: 'https://surplus.test', surplusKey: 'test', model: 'test' };
const EDIT = { id: 'qwen-image-2-edit', metering: 'per_image', pricing: { image: '0.01' } };
const EMBED = { id: 'venice-embed-1', architecture: { modality: 'embedding' }, pricing: { image: '0.1625' }, media_unit: '1M tokens' };
const edits = parseEditModels({ data: [EDIT] }), embeddings = parseEmbeddingModels({ data: [EMBED] });
const resolve = models => async id => { if (!models.has(id)) throw new UnknownModel('Unavailable model'); return models.get(id); };
const catalogue = { list: async () => [], editModels: async () => edits, embeddingModels: async () => embeddings,
  resolveEdit: resolve(edits), resolveEmbedding: resolve(embeddings), imageModels: async () => new Map() };
let paymentSequence = 0;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const decode = value => JSON.parse(Buffer.from(value, 'base64'));
function fakeFacilitator() {
  const calls = { verify: [], settle: [] };
  return { calls,
    async getSupported() {
      return { kinds: [
        { x402Version: 2, scheme: "exact", network: BASE },
        { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "1".repeat(32) } },
        { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
        { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "1".repeat(32),
          receiverAuthorizer: "1".repeat(32) } },
      ], extensions: ["bazaar"], signers: {} };
    },
    async verify(...args) { calls.verify.push(args); return { isValid: true, payer: "0x" + "2".repeat(40) }; },
    async settle(_payload, requirements) {
      calls.settle.push([requirements.network, requirements.amount]);
      return { success: true, transaction: "0x" + "a".repeat(64), network: requirements.network };
    } };
}


const OUTPUT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
// Real fixtures generated offline with ffmpeg: 16x16 testsrc JPEG, 2x2 white VP8,
// and 2x2 testsrc lossless VP8L. PNG above is a real 1x1 image.
const OUTPUT_JPEG = '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xAByAAEBAAAAAAAAAAAAAAAAAAAFBgEBAAMBAAAAAAAAAAAAAAAABgIDAQQQAAICAQQABQUBAAAAAAAAAAMEAgUBEQcSBiIhFAATFiQjMUEVEQABBAEEAQUBAAAAAAAAAAACBQQDAQYHERMSABQhIhYyFf/AABEIABAAEAMBEgACEgADEgD/2gAMAwEAAhEDEQA/AJmVRa7e7V0TSdgdOxskl7SbVe0cM4Beku0oKBIRASEoKucWIx1xksiY5zhiOfdDbq9e7htp1sX1LVowRq6uqMX5ljxhlJZNaJSfdiwP5pKS0HLPhzLMeUuPmp02wTEV176xYR2CxJKJhYKUEb1sI7FWwtnAm333gAqkKO5BvtQnVXt4c071cX07JRQ2uCqakY9iuWGdz24tzopuIEqW6AOYOxd+tb1vfv5qWsT5E1zRu+hbF9JaoLbHpQjsZ2n992bpTn5LK7udzxwwd660DeLpHQ8k1yc+Ws3umX3A01q4y2DLRSJInDOI4Ym0KDKMEswFCL4XMZTOIYpCEoxhkkAbsrKq8V7z3FfZrtiNjVV6alWFpf8A0EEkVoRImT0o2PTiHJaMWIiZORf8ox5PmOS8o64yJu3V9j3Gv7GoBQ2yuRcOBRKNO5NpgEvCOIA/uIOXlKXlLX+exmm+ZZYuxXGrrqqrDN+7UXk78/hc9j1kdnLIH5HfoQ9qEaLeqrxJhelWMoSASqm5+kL5wB2kas42tkFnctAJlCrObGysiodw97C9vL0NFYLb/UF8oU4cy4n9b+uATx5TVI/sgYKPpmYTi0r1YiNy9oS+Vd62L38npQqpSu4zNmsqDLGH+Uigl6BQcQxu2NpAFJY8Lk2ss/NGXf8AEXGNb/KvP//Z';
const OUTPUT_WEBP = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAIAAgA0JaQAA3AA/vuUAAA=';
const OUTPUT_WEBP_LOSSLESS = 'UklGRioAAABXRUJQVlA4TB4AAAAvAUAAABcw/wKCIv9Hm//5DzQLCtu2QWFxENH/yAM=';
function webpChunk(type, payload) {
  const bytes = Buffer.alloc(20 + payload.length + payload.length % 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WEBP', 8);
  bytes.write(type, 12); bytes.writeUInt32LE(payload.length, 16); payload.copy(bytes, 20);
  return bytes;
}
const EMPTY_SCAN_JPEG = Buffer.from('ffd8ffc00008080001000100ffda000600000000ffd9', 'hex');
const SHORT_VP8L = webpChunk('VP8L', Buffer.from('2f0000000000', 'hex'));
const image = 'data:image/png;base64,iVBORw0KGgo=';
const edit = { model: EDIT.id, prompt: 'Change background', image };
const embedding = { model: EMBED.id, input: 'Hello' };
async function serve(t, { status = 200, config = {}, invalid = false, unreachable = false, output, upstreamResponse } = {}) {
  const facilitator = fakeFacilitator(), calls = [], logs = [];
  const app = createApp({ ...CONFIG, ...config }, { facilitatorClient: facilitator, catalogue, log: line => logs.push(line),
    fetchImpl: async (url, init) => {
      if (upstreamResponse) return upstreamResponse();
      const body = JSON.parse(init.body); calls.push({ url, body });
      if (unreachable) throw new Error('private upstream details');
      assert.equal(facilitator.calls.settle.length, 0, 'upstream precedes settlement');
      const data = url.endsWith('/embeddings') ? [].concat(body.input).map((_, index) => ({ object: 'embedding', index, embedding: [0.1, 0.2] })) : [{ b64_json: OUTPUT_PNG }];
      return Response.json({ data: output ?? (invalid ? [] : data) }, { status });
    } });
  const listener = await new Promise(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}`, facilitator, calls, logs };
}
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
function payment(required, network) {
  return { 'payment-signature': encode({ x402Version: 2, resource: required.resource,
    accepted: required.accepts.find(a => a.network === network), payload: { signature: `test-${++paymentSequence}`, authorization: { from: '0x' + 'ab'.repeat(20), nonce: `0x${paymentSequence.toString(16).padStart(64, '0')}` } }, extensions: required.extensions }) };
}
for (const [path, body] of [['/v1/images/edits', edit], ['/v1/images/edits', { ...edit, mask: image }],
  ['/v1/images/image2image', edit], ['/v1/embeddings', embedding], ['/v1/embeddings', { ...embedding, input: ['Hello', 'world'] }]]) {
  for (const network of [BASE, SOLANA]) test(`${path} success with ${Array.isArray(body.input) ? 'array' : body.mask ? 'mask' : 'single input'} on ${network}`, async t => {
    const { url, facilitator, calls, logs } = await serve(t);
    const challenge = await post(url + path, body);
    assert.equal(challenge.status, 402);
    const required = decode(challenge.headers.get('payment-required'));
    assert.deepEqual(required.accepts.map(a => a.network), [BASE, SOLANA]);
    assert.ok((await challenge.json()).extensions.bazaar.schema.properties.output.properties.example);
    const headers = payment(required, network);
    assert.equal((await post(url + path, body, headers)).status, 200);
    assert.equal(facilitator.calls.settle.length, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, path.includes('image') ? { ...body, n: 1 } : { ...body, encoding_format: 'float' });
    assert.ok(logs.every(line => !line.includes(image) && !line.includes(edit.prompt) && !line.includes(embedding.input)));
    assert.equal(calls[0].url, CONFIG.surplusUrl + (path.includes('image') ? '/v1/images/edits' : path));
    assert.equal((await post(url + path, body, headers)).status, 409);
    const reformatted = { 'payment-signature': Buffer.from(JSON.stringify(decode(headers['payment-signature']), null, 2)).toString('base64') };
    assert.equal((await post(url + path, body, reformatted)).status, 409);
    assert.equal(facilitator.calls.settle.length, 1);
    assert.equal(calls.length, 1);
  });
}
for (const [path, body, expected, config] of [
  ['/v1/images/edits', { ...edit, image: 'bad' }, 422],
  ['/v1/images/edits', { ...edit, image: [image, image], mask: image }, 422],
  ['/v1/images/edits', edit, 413, { maxEditImageBytes: 4 }],
  ['/v1/embeddings', { ...embedding, input: '' }, 422],
  ['/v1/embeddings', { ...embedding, input: [] }, 422],
  ['/v1/embeddings', embedding, 413, { maxEmbeddingBytes: 2 }],
]) test(`${path} validation ${expected}`, async t => {
  const { url, facilitator, calls } = await serve(t, { config });
  assert.equal((await post(url + path, body)).status, expected);
  assert.equal(calls.length, 0); assert.equal(facilitator.calls.settle.length, 0);
});
for (const [path, body] of [['/v1/images/edits', edit], ['/v1/embeddings', embedding]]) {
  for (const options of [{ status: 500 }, { invalid: true }, { unreachable: true }]) test(`${path} upstream failure never settles ${JSON.stringify(options)}`, async t => {
    const { url, facilitator } = await serve(t, options);
    const required = decode((await post(url + path, body)).headers.get('payment-required'));
    const response = await post(url + path, body, payment(required, BASE));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '30');
    assert.equal(facilitator.calls.settle.length, 0);
  });
}
test('E1 and E5 catalogue filtering and conservative embedding quote', () => {
  assert.equal(edits.size, 1); assert.equal(embeddings.size, 1);
  assert.equal(parseEditModels({ data: [{ ...EDIT, id: 'generation' }] }).size, 0);
  assert.equal(parseEmbeddingModels({ data: [{ ...EMBED, media_unit: 'image' }] }).size, 0);
  assert.equal(listAtomic(embeddings.get(EMBED.id), { input: 'Hello' }), 3);
  assert.throws(() => readEditRequest({ ...edit, n: 2 }, edits.get(EDIT.id)), { status: 422 });
  assert.throws(() => readEmbeddingRequest({ ...embedding, input: [''] }, embeddings.get(EMBED.id)), { status: 422 });
});

test('E1 validation is independent of the payment middleware', () => {
  const model = edits.get(EDIT.id);
  assert.equal(readEditRequest(edit, model).image, image);
  assert.equal(readEditRequest({ ...edit, mask: image }, model).mask, image);
  assert.deepEqual(readEditRequest({ ...edit, image: [image, image] }, model).image, [image, image]);
  for (const body of [{ ...edit, image: 'bad' }, { ...edit, image: 'data:image/gif;base64,R0lG' },
    { ...edit, image: 'data:image/png;base64,YWJjZA==' }, { ...edit, image: [image, image], mask: image }]) {
    assert.throws(() => readEditRequest(body, model), { status: 422 });
  }
  assert.throws(() => readEditRequest(edit, model, { maxEditImageBytes: 4 }), { status: 413 });
});
test('E5 validation accepts strings and batches and bounds their combined bytes', () => {
  const model = embeddings.get(EMBED.id);
  assert.equal(readEmbeddingRequest(embedding, model).input, 'Hello');
  assert.deepEqual(readEmbeddingRequest({ ...embedding, input: ['a', 'b'] }, model).input, ['a', 'b']);
  for (const input of ['', [], [''], [3], null]) {
    assert.throws(() => readEmbeddingRequest({ ...embedding, input }, model), { status: 422 });
  }
  assert.throws(() => readEmbeddingRequest(embedding, model, { maxEmbeddingBytes: 2 }), { status: 413 });
});

test('discovery advertises E1 and E5 schemas and catalogue capability markers', async () => {
  const app = createApp(CONFIG, { facilitatorClient: fakeFacilitator(), catalogue, log: () => {} });
  const invoke = async path => {
    let result;
    const route = app.router.stack.find(layer => layer.route?.path === path).route;
    await route.stack.at(-1).handle({ protocol: 'https', get: () => 'ask.singitai.app' }, { json: value => { result = value; } });
    return result;
  };
  const discovery = await invoke('/.well-known/x402');
  for (const path of ['/v1/images/edits', '/v1/images/image2image', '/v1/embeddings']) {
    assert.ok(discovery.resources.includes('https://ask.singitai.app' + path));
    const detail = discovery.resourceDetails.find(d => d.resource.endsWith(path));
    assert.deepEqual(detail.networks, [BASE, SOLANA]);
    assert.equal(detail.outputSchema.type, 'object');
  }
  const imageModels = await invoke('/v1/images/models');
  assert.equal(imageModels.data.find(m => m.id === EDIT.id).edits, true);
  const models = await invoke('/v1/models');
  assert.equal(models.data.find(m => m.id === EMBED.id).embedding, true);
});


test('replay identity ignores serialization, metadata and EVM signature changes', () => {
  const original = { accepted: { network: BASE }, payload: { signature: 'a', authorization: { nonce: 'unique', value: '10' } } };
  const changed = { accepted: { network: BASE }, resource: { description: 'changed' }, payload: { authorization: { value: '10', nonce: 'unique' }, signature: 'b' } };
  assert.equal(paymentDigest(original), paymentDigest(changed));
  assert.notEqual(paymentDigest(original), paymentDigest({ ...original, accepted: { network: SOLANA } }));
});

test('E1 admits four 8 MiB decoded images and rejects any byte above the limit', () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  const full = 'data:image/png;base64,' + bytes.toString('base64');
  const model = edits.get(EDIT.id);
  assert.equal(readEditRequest({ ...edit, image: [full, full, full, full] }, model).image.length, 4);
  assert.equal(readEditRequest({ ...edit, image: full, mask: full }, model).mask, full);
  const oversized = 'data:image/png;base64,' + Buffer.concat([bytes, Buffer.alloc(1)]).toString('base64');
  assert.throws(() => readEditRequest({ ...edit, image: oversized }, model), { status: 413 });
});

for (const [path, body] of [['/v1/images/edits', edit], ['/v1/embeddings', embedding]]) {
  test(`${path} list-price ceiling rejects before verification`, async t => {
    const { url, facilitator, calls } = await serve(t);
    const challenge = await post(url + path, body);
    assert.equal(challenge.status, 402);
    const headers = payment(decode(challenge.headers.get('payment-required')), BASE);
    const models = path.includes('image') ? edits : embeddings;
    const model = models.get(body.model);
    const field = path.includes('image') ? 'imageUsd' : 'usdPerMillionTokens';
    // The ceiling follows the model price and input bound. Force the quote itself
    // beyond safe integer precision; merely increasing a valid price still fits.
    const original = model[field]; model[field] = 1e16;
    try {
      if (path === '/v1/embeddings') assert.equal(Number.isSafeInteger(listAtomic(model, body)), false);
      for (const paymentHeaders of [{}, headers]) {
        const response = await post(url + path, body, paymentHeaders);
        assert.equal(response.status, 422);
        assert.equal((await response.json()).error.message, 'This request exceeds the price ceiling.');
      }
      assert.equal(facilitator.calls.verify.length, 0);
      assert.equal(facilitator.calls.settle.length, 0);
      assert.equal(calls.length, 0);
    } finally { model[field] = original; }
  });
}

for (const path of ['/v1/images/edits', '/v1/images/image2image']) {
  test(`${path} JSON parser admits an 8 MiB decoded image`, async t => {
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
    const { url, facilitator, calls } = await serve(t);
    const response = await post(url + path, { ...edit, image: 'data:image/png;base64,' + bytes.toString('base64') });
    assert.equal(response.status, 402);
    assert.equal(facilitator.calls.settle.length, 0);
    assert.equal(calls.length, 0);
  });
}

test('media ceilings follow input bounds and the dearest priced model', async () => {
  const { catalogueCeiling: embeddingCeiling, MAX_INPUT_BYTES } = await import('../src/embeddings-request.mjs');
  const { catalogueCeiling: editCeiling } = await import('../src/image-edits-request.mjs');
  const { imagePrice } = await import('../src/images.mjs');
  const embeddingList = await embeddingCeiling(catalogue);
  assert.equal(embeddingList, 16250);
  assert.equal(listAtomic(embeddings.get(EMBED.id), { input: 'x'.repeat(MAX_INPUT_BYTES - 8) }), embeddingList);
  assert.equal(await embeddingCeiling(catalogue, { maxEmbeddingBytes: 200_000 }), 32500);
  assert.equal(imagePrice(embeddingList, SOLANA).totalAtomic, '23125');
  const editList = await editCeiling({ editModels: async () => new Map([...edits,
    ['dearest-edit', { id: 'dearest-edit', metering: 'per_image', imageUsd: 0.36 }]]) });
  assert.equal(editList, 360000);
  assert.equal(imagePrice(editList, SOLANA).totalAtomic, '470000');
});

test('new media Bazaar fields all describe their input', async () => {
  for (const name of ['image-edits', 'embeddings']) {
    const { INPUT_SCHEMA } = await import(`../src/${name}-request.mjs`);
    for (const [field, definition] of Object.entries(INPUT_SCHEMA.properties)) {
      assert.ok(definition.description, `${name}.${field}`);
    }
  }
});

for (const result of [{ b64_json: true }, { b64_json: '' }, { b64_json: 'garbage!' },
  { b64_json: 'YWJjZA==' }, { b64_json: EMPTY_SCAN_JPEG.toString('base64') },
  { b64_json: SHORT_VP8L.toString('base64') }, { url: true }, { url: '/relative' }, { url: 'http://example.test/a.png' }]) {
  test(`invalid edit output never settles: ${JSON.stringify(result)}`, async t => {
    const { url, facilitator } = await serve(t, { output: [result] });
    const required = decode((await post(url + '/v1/images/edits', edit)).headers.get('payment-required'));
    assert.equal((await post(url + '/v1/images/edits', edit, payment(required, BASE))).status, 503);
    assert.equal(facilitator.calls.settle.length, 0);
  });
}
for (const vector of ['AQ==', '', '!!!!', Buffer.from([0, 0, 128, 127]).toString('base64'), Buffer.from([0, 0, 192, 127]).toString('base64')]) {
  test(`invalid base64 embedding never settles: ${vector}`, async t => {
    const body = { ...embedding, encoding_format: 'base64' };
    const { url, facilitator } = await serve(t, { output: [{ index: 0, embedding: vector }] });
    const required = decode((await post(url + '/v1/embeddings', body)).headers.get('payment-required'));
    assert.equal((await post(url + '/v1/embeddings', body, payment(required, BASE))).status, 503);
    assert.equal(facilitator.calls.settle.length, 0);
  });
}
test('embedding batch cap rejects before payment, with configurable limit', async t => {
  const { url, facilitator } = await serve(t);
  assert.equal((await post(url + '/v1/embeddings', { ...embedding, input: Array(257).fill('a') })).status, 422);
  assert.equal((await post(url + '/v1/embeddings', { ...embedding, input: Array(256).fill('a') })).status, 402);
  assert.equal(facilitator.calls.verify.length, 0);
  assert.throws(() => readEmbeddingRequest({ ...embedding, input: ['a', 'b'] }, embeddings.get(EMBED.id), { maxEmbeddingInputs: 1 }), { status: 422 });
});
test('replay identity normalizes EVM network, asset, signer and nonce, ignoring other authorization fields', () => {
  const p = { accepted: { network: 'eip155:8453', asset: '0xABCD' }, payload: { authorization: { from: '0xABCDEF', nonce: '0xAB', value: '1' } } };
  assert.equal(paymentDigest(p), paymentDigest({ accepted: { network: 'EIP155:08453', asset: '0xabcd' }, payload: { authorization: { from: '0xabcdef', nonce: '0xab', value: '2' } } }));
  for (const field of ['asset', 'network']) assert.notEqual(paymentDigest(p), paymentDigest({ ...p, accepted: { ...p.accepted, [field]: field === 'asset' ? '0x1234' : 'eip155:1' } }));
  const sol = { accepted: { network: SOLANA }, payload: { transaction: 'signed-tx' } };
  assert.equal(paymentDigest(sol), paymentDigest({ ...sol, resource: 'other' }));
  assert.notEqual(paymentDigest(sol), paymentDigest({ ...sol, payload: { transaction: 'another-tx' } }));
});
test('concurrent edits and embeddings share reservations across app instances', async t => {
  // 61,530 input bytes plus 8 overhead quote 10,000 atomic units, matching the edit.
  const equalPriceEmbedding = { ...embedding, input: 'a'.repeat(61_530) };
  const a = await serve(t), b = await serve(t);
  const r = decode((await post(a.url + '/v1/images/edits', edit)).headers.get('payment-required'));
  const s = decode((await post(b.url + '/v1/embeddings', equalPriceEmbedding)).headers.get('payment-required'));
  assert.equal(r.accepts.find(x => x.network === BASE).amount, s.accepts.find(x => x.network === BASE).amount);
  const h = payment(r, BASE), p = decode(h['payment-signature']);
  const other = { ...p, accepted: s.accepts.find(x => x.network === BASE), resource: s.resource, extensions: s.extensions,
    payload: { ...p.payload, authorization: { ...p.payload.authorization, from: '0x' + p.payload.authorization.from.slice(2).toUpperCase() } } };
  const results = await Promise.all([post(a.url + '/v1/images/edits', edit, h), post(b.url + '/v1/embeddings', equalPriceEmbedding, { 'payment-signature': encode(other) })]);
  assert.deepEqual(results.map(x => x.status).sort(), [200, 409]);
  assert.equal(a.calls.length + b.calls.length, 1);
  assert.ok(reservations.has(paymentDigest(p)));
});
for (const [path, body, setting] of [['/v1/images/edits', edit, 'maxEditResponseBytes'], ['/v1/embeddings', embedding, 'maxEmbeddingResponseBytes']]) {
  for (const status of [200, 500]) test(`${path} cancels oversized streamed ${status} without settlement`, async t => {
    let cancelled = false, pulls = 0;
    const { url, facilitator } = await serve(t, { config: { [setting]: 100 }, upstreamResponse: () => new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(60)); }, cancel() { cancelled = true; },
    }), { status }) });
    const r = decode((await post(url + path, body)).headers.get('payment-required'));
    assert.equal((await post(url + path, body, payment(r, BASE))).status, 503);
    assert.equal(facilitator.calls.settle.length, 0);
    assert.ok(cancelled); assert.ok(pulls < 5);
  });
}
test('media pricing entries match reference-request offers', async t => {
  const { url } = await serve(t);
  const prices = await (await fetch(url + '/pricing.json')).json();
  for (const [id, path] of [[EDIT.id, '/v1/images/edits'], [EMBED.id, '/v1/embeddings']]) {
    const entry = prices.models.find(m => m.id === id);
    assert.equal(entry.route, path);
    assert.ok(entry.priceDescription);
    const required = decode((await post(url + path, entry.referenceRequest)).headers.get('payment-required'));
    for (const [name, network] of [['base', BASE], ['solana', SOLANA]]) assert.equal(entry.exact[name].ceilingAtomic, required.accepts.find(a => a.network === network).amount);
  }
});
test('valid image formats, HTTPS URLs and finite float32 embeddings pass validation', async () => {
  const { validImage, validEmbedding, readBoundedJson } = await import('../src/media-response.mjs');
  for (const bytes of [Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from([255,216,255]), Buffer.from('RIFF0000WEBP')]) assert.equal(validImage({ b64_json: bytes.toString('base64') }), false);
  for (const b64_json of [OUTPUT_PNG, OUTPUT_JPEG, OUTPUT_WEBP, OUTPUT_WEBP_LOSSLESS]) {
    assert.ok(validImage({ b64_json }));
  }
  const corrupt = Buffer.from(OUTPUT_PNG, 'base64'); corrupt[corrupt.length - 1] ^= 1;
  assert.equal(validImage({ b64_json: corrupt.toString('base64') }), false);
  assert.ok(validImage({ url: 'https://example.test/image.png' }));
  const bytes = Buffer.alloc(8); bytes.writeFloatLE(0.5); bytes.writeFloatLE(-1, 4);
  assert.ok(validEmbedding(bytes.toString('base64'), 'base64'));
  assert.deepEqual(await readBoundedJson(Response.json({ a: 1 }), 7), { a: 1 });
});

test('JPEG requires dimensions and at least 16 entropy bytes; WebP requires image headers and payload', async () => {
  const { validImage } = await import('../src/media-response.mjs');
  const rejects = bytes => assert.equal(validImage({ b64_json: bytes.toString('base64') }), false);
  rejects(EMPTY_SCAN_JPEG);
  rejects(SHORT_VP8L);
  // Keep EOI intact while varying only the entropy-coded scan length.
  for (const length of [1, 15]) {
    rejects(Buffer.concat([EMPTY_SCAN_JPEG.subarray(0, -2), Buffer.alloc(length, 1), Buffer.from([255, 217])]));
  }
  for (const offset of [7, 9]) {
    const jpeg = Buffer.from(EMPTY_SCAN_JPEG); jpeg.writeUInt16BE(0, offset);
    rejects(Buffer.concat([jpeg.subarray(0, -2), Buffer.alloc(16, 1), jpeg.subarray(-2)]));
  }
  for (const offset of [23, 26, 28]) {
    const webp = Buffer.from(OUTPUT_WEBP, 'base64');
    // Missing start code, or a zero 14-bit dimension despite nonzero scale bits.
    if (offset === 23) webp[offset] = 0;
    else webp.writeUInt16LE(0xc000, offset);
    rejects(webp);
  }
  const lossless = Buffer.from(OUTPUT_WEBP_LOSSLESS, 'base64'); lossless[20] = 0;
  rejects(lossless);
});

test('paid media handlers validate responses and stream caps in process without sockets', async () => {
  let responseFactory;
  const app = createApp(CONFIG, { facilitatorClient: fakeFacilitator(), catalogue, log: () => {},
    fetchImpl: async () => responseFactory() });
  for (const [path, body, outputs] of [
    ['/v1/images/edits', edit, [[{ b64_json: 'iVBORw0KGgo=' }], [{ b64_json: true }], [{ b64_json: 'YWJjZA==' }], [{ url: 'http://invalid.test' }], [{ b64_json: EMPTY_SCAN_JPEG.toString('base64') }], [{ b64_json: SHORT_VP8L.toString('base64') }],
      ...[OUTPUT_PNG, OUTPUT_JPEG, OUTPUT_WEBP, OUTPUT_WEBP_LOSSLESS].map(b64_json => [{ b64_json }]), [{ url: 'https://example.test/a' }]]],
    ['/v1/embeddings', { ...embedding, encoding_format: 'base64' }, [[{ index: 0, embedding: 'AQ==' }], [{ index: 0, embedding: 'AACAfw==' }], [{ index: 0, embedding: 'AAAAPw==' }]]],
  ]) {
    const layers = app.router.stack.filter(layer => layer.route && [].concat(layer.route.path).includes(path) && layer.route.methods.post);
    const validate = layers.find(layer => /resolveEdit|resolveEmbedding/.test(layer.route.stack[0].handle.toString())).route.stack[0].handle;
    const handler = layers.at(-1).route.stack.at(-1).handle;
    for (const data of outputs) {
      const req = { body, get: () => encode({ accepted: { network: BASE, asset: 'USDC' }, payload: { authorization: { from: 'test', nonce: `in-process-${++paymentSequence}` } } }) };
      let status = 200, result;
      const res = { set() { return this; }, status(value) { status = value; return this; }, json(value) { result = value; } };
      await validate(req, res, () => {});
      responseFactory = () => Response.json({ data });
      await handler(req, res);
      const good = [OUTPUT_PNG, OUTPUT_JPEG, OUTPUT_WEBP, OUTPUT_WEBP_LOSSLESS].includes(data[0].b64_json) || data[0].url?.startsWith('https:') || data[0].embedding === 'AAAAPw==';
      assert.equal(status, good ? 200 : 503);
      assert.ok(good ? result.billing : result.error);
    }
  }
  let pricing;
  const route = app.router.stack.find(layer => layer.route?.path === '/pricing.json').route;
  await route.stack.at(-1).handle({}, { json(value) { pricing = value; } });
  for (const id of [EDIT.id, EMBED.id]) {
    const entry = pricing.models.find(m => m.id === id);
    assert.ok(entry.exact.base.ceilingAtomic);
    assert.equal(typeof entry.exact.base.usd, 'number');
    assert.ok(entry.referenceRequest);
  }
});
test('stream reader cancels oversized bodies with no Content-Length, including errors', async () => {
  const { readBoundedJson } = await import('../src/media-response.mjs');
  for (const status of [200, 500]) {
    let cancelled = false, pulls = 0;
    const response = new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(60)); }, cancel() { cancelled = true; } }), { status });
    await assert.rejects(readBoundedJson(response, 100), /too large/);
    assert.ok(cancelled); assert.ok(pulls < 5);
  }
});

test('batch limit and shared replay store work without sockets', async () => {
  const model = embeddings.get(EMBED.id);
  assert.throws(() => readEmbeddingRequest({ ...embedding, input: Array(257).fill('a') }, model), { status: 422 });
  assert.equal(readEmbeddingRequest({ ...embedding, input: Array(256).fill('a') }, model).input.length, 256);
  assert.throws(() => readEmbeddingRequest({ ...embedding, input: ['a', 'b'] }, model, { maxEmbeddingInputs: 1 }), { status: 422 });
  let calls = 0;
  const payload = { authorization: { from: '0xABcd', nonce: `shared-${++paymentSequence}` } };
  const invoke = async (path, body) => {
    const app = createApp({ ...CONFIG, maxEditResponseBytes: 10, maxEmbeddingResponseBytes: 10 }, {
      facilitatorClient: fakeFacilitator(), catalogue, log: () => {}, fetchImpl: async () => { calls++; return Response.json({ data: [{ b64_json: OUTPUT_PNG }] }); },
    });
    const layers = app.router.stack.filter(layer => layer.route && [].concat(layer.route.path).includes(path) && layer.route.methods.post);
    const req = { body, get: () => encode({ accepted: { network: BASE, asset: 'USDC' }, payload }) };
    let status = 200;
    const res = { set() { return this; }, status(value) { status = value; return this; }, json() {} };
    await layers.find(layer => /resolveEdit|resolveEmbedding/.test(layer.route.stack[0].handle.toString())).route.stack[0].handle(req, res, () => {});
    await layers.at(-1).route.stack.at(-1).handle(req, res);
    return status;
  };
  assert.equal(await invoke('/v1/images/edits', edit), 503, 'configured response limit is applied');
  payload.authorization.from = '0xabCD';
  assert.equal(await invoke('/v1/embeddings', embedding), 409, 'same authorization reserved across routes and app instances');
  assert.equal(calls, 1);
});

test('diagnostic logging respects media stream caps before cloning error bodies', async () => {
  const { withRejectLog } = await import('../src/reject-log.mjs');
  const { readBoundedJson } = await import('../src/media-response.mjs');
  for (const path of ['/v1/images/edits', '/v1/embeddings']) {
    for (const status of [200, 500]) {
      let pulls = 0, cancelled = false;
      const url = CONFIG.surplusUrl + path;
      const fetchImpl = withRejectLog(async () => new Response(new ReadableStream({
        pull(c) { pulls++; c.enqueue(new Uint8Array(60)); },
        cancel() { cancelled = true; },
      }), { status }), { surplusUrl: CONFIG.surplusUrl, log: () => {}, responseLimits: { [url]: 100 } });
      const response = await fetchImpl(url, { method: 'POST', body: JSON.stringify({ model: 'test' }) });
      await assert.rejects(readBoundedJson(response, 100), /too large/);
      await fetchImpl.idle();
      assert.ok(cancelled);
      assert.ok(pulls < 5, `read ${pulls} chunks for ${path} status ${status}`);
    }
  }
});

test('payment reservations fail closed at capacity and retain live replay identities', async () => {
  const { reservePayment } = await import('../src/media-payment-replay.mjs');
  const store = new Map();
  const reserve = (key, now = 0) => reservePayment(key, { store, now, maxEntries: 2 });
  assert.equal(reserve('a'), 'reserved');
  assert.equal(reserve('b'), 'reserved');
  for (let i = 0; i < 100; i++) assert.equal(reserve(`overflow-${i}`), 'full');
  assert.equal(store.size, 2);
  assert.equal(reserve('a'), 'duplicate');
  assert.equal(reserve('new', 3_600_001), 'reserved');
  assert.equal(store.size, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { listingCopy, bazaarLimitsBoilerplate } from '../../singit-ask/src/listing-copy.mjs';
import { routeCopy } from '../../singit-ask/src/listing-snapshot.mjs';
import { catalogResponse } from '../../singit-ask/src/catalog-shape.mjs';
import { serve, request } from '../../singit-ask/test/fixtures/listing-harness.mjs';
import { aliasPaths } from '../../singit-ask/src/model-alias-routes.mjs';


const TAIL = 'Pay per call in USDC on Base or Solana, no API key. Models: GET /v1/catalog.';

test('copy derives sample tags, gates unsold modalities and separates key-only transcription', () => {
  const catalog = { counts: { chat: 7, image: 2, transcription: 6 }, data: [
    { id: 'provider-chat', modality: 'chat', access: 'x402', available: true },
    { id: 'artist-image', modality: 'image', payment: 'x402' },
    { id: 'private-model', modality: 'chat', payment: 'api_key_only' },
  ] };
  for (const [modality, id] of [['chat', 'provider-chat'], ['image', 'artist-image']]) {
    const copy = listingCopy(catalog, modality, 'Generate an answer');
    assert.equal(copy.description, `Generate an answer. ${TAIL}`);
    assert.ok(copy.tags.includes(id));
    assert.doesNotMatch(JSON.stringify(copy), /video|private-model/);
    assert.ok(copy.description.length <= 160);
  }
  assert.equal(listingCopy(catalog, 'video', 'Generate clips'), null);
  assert.equal(listingCopy(catalog, 'music', 'Generate audio'), null);
  assert.equal(listingCopy(catalog, 'sound_effects', 'Generate effects'), null);
  assert.ok(listingCopy(catalog, 'music', 'Generate audio', { audioSold: true }));
  const transcription = listingCopy(catalog, 'transcription', 'Transcription');
  assert.match(transcription.description, /API-key only/);
  assert.doesNotMatch(JSON.stringify(transcription), /x402|USDC/);
  assert.match(listingCopy(catalog, 'speech', 'Speech API').description, /Models: GET \/v1\/catalog/);
});

test('snapshot copy and sample tags remain consistent with D3', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../../website/data/catalog-snapshot.json', import.meta.url)));
  assert.deepEqual(catalogResponse(snapshot.data).counts, snapshot.counts);
  const copy = routeCopy('/v1/chat/completions');
  assert.equal(copy.description, `OpenAI-compatible chat API, many models incl. free ones. ${TAIL}`);
  for (const tag of copy.tags.slice(1)) assert.ok(snapshot.data.some(e => e.id === tag));
  assert.match(copy.description, /incl. free ones/);
  const pinnedModel = snapshot.data.find(e => e.modality === 'chat' && e.payment === 'x402' && !e.router && !e.free);
  assert.ok(pinnedModel, 'snapshot contains a paid chat model');
  const pinned = routeCopy(`/v1/chat/${pinnedModel.id}`);
  assert.equal(pinned.description, `OpenAI-compatible chat API pinned to ${pinnedModel.name.replace(/^[^:]+: /, '')}. ${TAIL}`);
  assert.doesNotMatch(pinned.description, /Snapshot:/);
});

test('samples are sorted, diverse and limited to eligible catalog entries', () => {
  const data = ['zeta-one', 'beta-two', 'alpha-two', 'epsilon-one', 'delta-one', 'alpha-one']
    .map(id => ({ id, modality: 'chat', payment: 'x402' }));
  data.push(
    { id: 'aaa-router', modality: 'chat', payment: 'x402', router: true },
    { id: 'aaa-free', modality: 'chat', payment: 'x402', free: true },
    { id: 'aaa-unavailable', modality: 'chat', payment: 'x402', available: false },
    ...['music', 'sound_effects', 'video'].map(modality => ({ id: `${modality}-secret`, modality, payment: 'x402' })),
  );
  const copy = listingCopy({ data }, 'chat', 'Chat API');
  assert.deepEqual(copy.tags, ['chat', 'alpha-one', 'beta-two', 'delta-one', 'epsilon-one']);
  assert.deepEqual(copy, listingCopy({ data: [...data].reverse() }, 'chat', 'Chat API'));
  assert.doesNotMatch(JSON.stringify(copy), /secret|aaa-|alpha-two|zeta-one/);
  for (const modality of ['music', 'sound_effects', 'video']) {
    assert.equal(listingCopy({ data }, modality, 'Generate'), null);
    const flags = modality === 'video' ? { videoSold: true } : { audioSold: true };
    assert.doesNotMatch(JSON.stringify(listingCopy({ data }, modality, 'Generate', flags)), /secret/);
  }
  for (const modality of ['image', 'speech', 'image_edit', 'embeddings']) {
    const missing = listingCopy({ data }, modality, 'API');
    assert.deepEqual(missing.tags, [modality]);
    assert.match(missing.description, /Models: GET \/v1\/catalog/);
  }
});

test('default discovery preserves base URLs plus D4 model aliases and shares descriptions with challenges and OpenAPI', async t => {
  const { url } = await serve(t, {}, { audioSold: false, audioDiscoverable: false });
  const discovery = await (await request(url + '/.well-known/x402')).json();
  const llms = await (await request(url + '/llms.txt')).text();
  assert.doesNotMatch(llms, /video|music|sound.effects/i);
  assert.match(llms, /transcription is API-key only/);
  const openapi = await (await request(url + '/openapi.json')).json();
  const expected = 30 + aliasPaths().length;
  assert.equal(discovery.resources.length, expected);
  assert.equal(discovery.resourceDetails.length, expected);
  assert.doesNotMatch(JSON.stringify(openapi), /video|music|sound.effects/i);
  assert.doesNotMatch(JSON.stringify(discovery), /video|music|sound.effects/i);
  assert.doesNotMatch(discovery.instructions, /ceiling/i);
  assert.doesNotMatch(JSON.stringify(discovery), /ceiling|\bfees?\b|%/i);
  for (const detail of discovery.resourceDetails) {
    const path = new URL(detail.resource).pathname;
    const response = await request(url + path);
    const challenge = JSON.parse(Buffer.from(response.headers.get('payment-required'), 'base64').toString());
    assert.equal(challenge.resource.description, detail.description, path);
    assert.ok(llms.includes(detail.description), path);
    assert.ok(openapi.paths[path].post.description.startsWith(detail.description), path);
    assert.ok(detail.description.length <= 160, path);
    assert.doesNotMatch(detail.description, /ceiling|\bfees?\b|%/i, path);
    assert.doesNotMatch(detail.description, /0x[0-9a-fA-F]{8,}/, path);
    assert.doesNotMatch(detail.description, /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/, path);
  }
});

test('published media listings use populated snapshot counts and exclude hidden models', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../../website/data/catalog-snapshot.json', import.meta.url)));
  for (const [modality, path] of [
    ['image', '/v1/images/generations'], ['image_edit', '/v1/images/edits'],
    ['embeddings', '/v1/embeddings'], ['speech', '/v1/audio/speech'],
  ]) {
    const copy = routeCopy(path);
    assert.ok(snapshot.counts[modality] > 0);
    assert.ok(copy.description.length <= 160);
    assert.doesNotMatch(copy.description, /\b(fee|markup|ceiling|settlement)\b|%/i);
    for (const id of copy.tags.slice(1)) assert.ok(snapshot.data.some(e => (e.id.slice(0, 60) === id || e.id.split(/[-/]/)[0] === id) && e.modality === modality));
    assert.doesNotMatch(JSON.stringify(copy), /music|sound.effects|video/i);
  }
  for (const modality of ['music', 'sound_effects', 'video', 'transcription']) {
    assert.ok(!snapshot.data.some(e => e.modality === modality));
  }
});

test('copy enforces length and banned wording and only advertises actual free entries', () => {
  for (const word of ['ceiling', 'fee', 'fees', '%', 'CEILING']) {
    assert.throws(() => listingCopy({ data: [] }, 'chat', `API ${word}`), /banned wording/);
  }
  assert.equal(listingCopy({ data: [] }, 'search', 'x'.repeat(82)).description.length, 160);
  assert.throws(() => listingCopy({ data: [] }, 'search', 'x'.repeat(83)), /exceeds 160/);
  for (const data of [[], [{ modality: 'chat', router: true }]]) {
    assert.equal(listingCopy({ data }, 'chat', 'OpenAI-compatible chat API').description,
      `OpenAI-compatible chat API, many models. ${TAIL}`);
  }
  assert.equal(listingCopy({ data: [{ modality: 'chat', kind: 'free' }] }, 'chat', 'OpenAI-compatible chat API').description,
    `OpenAI-compatible chat API, many models incl. free ones. ${TAIL}`);
  for (const [path, lead] of [
    ['/v1/messages', 'Anthropic Messages format chat API, many models'],
    ['/v1/responses', 'OpenAI Responses format chat API, many models'],
    ['/v1/images/edits', 'Image editing API: PNG, JPEG or WEBP input, optional mask'],
    ['/v1/images/image2image', 'Image editing API: PNG, JPEG or WEBP input, optional mask'],
  ]) assert.equal(routeCopy(path).description, `${lead}. ${TAIL}`);
});

test('draft limits boilerplate stays capability-first, bounded and free of banned wording', () => {
  const copy = bazaarLimitsBoilerplate();
  assert.ok(copy.startsWith('AI chat, images and search.'));
  assert.match(copy, /Owner-set USDC limits via MCP\/API keys/);
  assert.ok(copy.length <= 160);
  assert.doesNotMatch(copy, /ceiling|\bfees?\b|%/i);
  for (const word of ['ceiling', 'fee', 'fees', '%', 'CEILING']) {
    assert.throws(() => bazaarLimitsBoilerplate(word), /banned wording/);
  }
  assert.throws(() => bazaarLimitsBoilerplate('x'.repeat(161)), /exceeds 160/);
});

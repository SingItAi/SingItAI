import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { listingCopy } from '../../singit-ask/src/listing-copy.mjs';
import { routeCopy } from '../../singit-ask/src/listing-snapshot.mjs';
import { catalogResponse } from '../../singit-ask/src/catalog-shape.mjs';
import { serve, request } from '../../singit-ask/test/fixtures/listing-harness.mjs';

test('copy derives counts and sample IDs, gates unsold modalities and separates key-only transcription', () => {
  const catalog = { counts: { chat: 7, image: 2, transcription: 6 }, data: [
    { id: 'provider-chat', modality: 'chat', access: 'x402', available: true },
    { id: 'artist-image', modality: 'image', payment: 'x402' },
    { id: 'private-model', modality: 'chat', payment: 'api_key_only' },
  ] };
  for (const [modality, count, id] of [['chat', 7, 'provider-chat'], ['image', 2, 'artist-image']]) {
    const copy = listingCopy(catalog, modality, 'Generate an answer');
    assert.match(copy.description, new RegExp(`${count} ${modality} models`));
    assert.ok(copy.description.includes(id));
    assert.ok(copy.tags.includes(id));
    assert.doesNotMatch(JSON.stringify(copy), /video|private-model/);
    assert.ok(copy.description.length <= 500);
  }
  assert.equal(listingCopy(catalog, 'video', 'Generate clips'), null);
  assert.equal(listingCopy(catalog, 'music', 'Generate audio'), null);
  assert.equal(listingCopy(catalog, 'sound_effects', 'Generate effects'), null);
  assert.ok(listingCopy(catalog, 'music', 'Generate audio', { audioSold: true }));
  const transcription = listingCopy(catalog, 'transcription', 'Transcription');
  assert.match(transcription.description, /API-key only/);
  assert.doesNotMatch(JSON.stringify(transcription), /x402|USDC/);
  assert.match(listingCopy(catalog, 'speech', 'Speech API').description, /listed at GET \/v1\/catalog/);
});

test('snapshot counts and sample IDs remain consistent with D3', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../../website/data/catalog-snapshot.json', import.meta.url)));
  assert.deepEqual(catalogResponse(snapshot.data).counts, snapshot.counts);
  const copy = routeCopy('/v1/chat/completions');
  assert.ok(copy.description.includes(`${snapshot.counts.chat} chat models`));
  for (const tag of copy.tags.slice(1)) assert.ok(snapshot.data.some(e => e.id === tag));
  assert.match(copy.description, /including free entries and routers/);
  const pinned = routeCopy('/v1/chat/claude-opus-5.5');
  assert.ok(pinned.description.includes(`${snapshot.counts.chat} chat models`));
  assert.match(pinned.description, /Claude Opus 5.5|claude-opus-5.5/i);
  assert.doesNotMatch(pinned.description, /Snapshot: 1 chat/);
});

test('default discovery preserves 25 URLs and shares descriptions with challenges and OpenAPI', async t => {
  const { url } = await serve(t, {}, { audioSold: false, audioDiscoverable: false });
  const discovery = await (await request(url + '/.well-known/x402')).json();
  const llms = await (await request(url + '/llms.txt')).text();
  assert.doesNotMatch(llms, /video|music|sound.effects/i);
  assert.match(llms, /transcription is API-key only/);
  const openapi = await (await request(url + '/openapi.json')).json();
  assert.equal(discovery.resources.length, 25);
  assert.equal(discovery.resourceDetails.length, 25);
  assert.doesNotMatch(JSON.stringify(openapi), /video|music|sound.effects/i);
  assert.doesNotMatch(JSON.stringify(discovery), /video|music|sound.effects/i);
  for (const detail of discovery.resourceDetails) {
    const path = new URL(detail.resource).pathname;
    const response = await request(url + path);
    const challenge = JSON.parse(Buffer.from(response.headers.get('payment-required'), 'base64').toString());
    assert.equal(challenge.resource.description, detail.description, path);
    assert.ok(llms.includes(detail.description), path);
    assert.ok(openapi.paths[path].post.description.startsWith(detail.description), path);
    assert.ok(detail.description.length <= 500);
  }
});

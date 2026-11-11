import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { listingCopy, bazaarLimitsBoilerplate, checkedDescription, serviceDescription, MAX_DESCRIPTION, HOLDER_NOTE } from '../../singit-ask/src/listing-copy.mjs';
import { routeCopy } from '../../singit-ask/src/listing-snapshot.mjs';
import { catalogResponse } from '../../singit-ask/src/catalog-shape.mjs';
import { serve, request } from '../../singit-ask/test/fixtures/listing-harness.mjs';
import { aliasPaths } from '../../singit-ask/src/model-alias-routes.mjs';
import { SERVICE_NAME } from '../../singit-ask/src/pricing.mjs';


const tail = unit => `Pay-per-${unit} in USDC on Base or Solana, no API key; the max charge is quoted before signing. ${HOLDER_NOTE} Models: GET /v1/catalog.`;
const TAIL = tail('answer');
const CALL_TAIL = tail('call');

test('copy derives sample tags, gates unsold modalities and separates key-only transcription', () => {
  const catalog = { counts: { chat: 7, image: 2, transcription: 6 }, data: [
    { id: 'provider-chat', modality: 'chat', access: 'x402', available: true },
    { id: 'artist-image', modality: 'image', payment: 'x402' },
    { id: 'private-model', modality: 'chat', payment: 'api_key_only' },
  ] };
  for (const [modality, id] of [['chat', 'provider-chat'], ['image', 'artist-image']]) {
    const copy = listingCopy(catalog, modality, 'Generate an answer');
    assert.equal(copy.description, `Generate an answer. ${modality === 'chat' ? TAIL : CALL_TAIL}`);
    assert.ok(copy.tags.includes(id));
    assert.doesNotMatch(JSON.stringify(copy), /video|private-model/);
    assert.ok(copy.description.length <= MAX_DESCRIPTION);
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
  const expected = 31 + aliasPaths().length;
  assert.equal(discovery.resources.length, expected);
  assert.equal(discovery.resourceDetails.length, expected);
  assert.doesNotMatch(JSON.stringify(openapi), /video|music|sound.effects/i);
  assert.doesNotMatch(JSON.stringify(discovery), /video|music|sound.effects/i);
  assert.equal(discovery.version, 1);
  // Service-level card copy for directory crawlers: the same strings GET / serves.
  assert.equal(discovery.name, SERVICE_NAME);
  assert.equal(discovery.description, serviceDescription({ long: true }));
  assert.match(discovery.description, /LLM chat/i);
  assert.ok(discovery.description.length <= MAX_DESCRIPTION);
  assert.doesNotMatch(discovery.description, /markup|\b(30|thirty)\s*percent\b/i);
  assert.doesNotMatch(discovery.description, /ceiling|\bfees?\b|%/i);
  assert.doesNotMatch(discovery.description, /0x[0-9a-fA-F]{8,}/);
  assert.doesNotMatch(discovery.description, /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
  assert.doesNotMatch(discovery.instructions, /ceiling|%/i);
  assert.match(discovery.instructions, /settlement fee of \$0\.001 on Base or \$0\.002 on Solana/);
  assert.match(llms, /settlement fee of \$0\.001 on Base or \$0\.002 on Solana/);
  assert.doesNotMatch(JSON.stringify(discovery.resourceDetails), /ceiling|\bfees?\b|%/i);
  for (const detail of discovery.resourceDetails) {
    const path = new URL(detail.resource).pathname;
    const response = await request(url + path);
    const challenge = JSON.parse(Buffer.from(response.headers.get('payment-required'), 'base64').toString());
    assert.equal(challenge.resource.description, detail.description, path);
    assert.ok(llms.includes(detail.description), path);
    assert.ok(openapi.paths[path].post.description.startsWith(detail.description), path);
    assert.ok(detail.description.length >= 1 && detail.description.length <= MAX_DESCRIPTION, path);
    assert.doesNotMatch(detail.description, /markup|\b(30|thirty)\s*percent\b/i, path);
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
    assert.ok(copy.description.length <= MAX_DESCRIPTION);
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
  for (const word of ['markupBps', 'markupAtomic', 'markupPct', 'markupPercent', 'a 30% markup', '30 percent', 'thirty percent', 'Thirty  Percent']) {
    assert.throws(() => listingCopy({ data: [] }, 'chat', `API ${word}`), /banned wording/, word);
    assert.throws(() => checkedDescription(`API ${word}.`), /banned wording/, word);
  }
  for (const command of ['Call it when an agent needs a clip', 'You should call this first', 'you must pay first']) {
    assert.throws(() => checkedDescription(`Video API. ${command}.`), /banned wording/, command);
  }
  assert.throws(() => checkedDescription(''), /empty/);
  // CDP's facilitator rejects over 500 characters: exactly 500 passes, 501 throws.
  assert.equal(MAX_DESCRIPTION, 500);
  const room = MAX_DESCRIPTION - `. ${CALL_TAIL}`.length;
  assert.equal(listingCopy({ data: [] }, 'search', 'x'.repeat(room)).description.length, 500);
  assert.throws(() => listingCopy({ data: [] }, 'search', 'x'.repeat(room + 1)), /exceeds 500/);
  assert.equal(checkedDescription('x'.repeat(500)).length, 500);
  assert.throws(() => checkedDescription('x'.repeat(501)), /exceeds 500/);
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
  ]) assert.equal(routeCopy(path).description, `${lead}. ${path.startsWith('/v1/images/') ? CALL_TAIL : TAIL}`);
});

test('draft limits boilerplate stays capability-first, bounded and free of banned wording', () => {
  const copy = bazaarLimitsBoilerplate();
  assert.ok(copy.startsWith('AI chat, images and search.'));
  assert.match(copy, /Owner-set USDC limits via MCP\/API keys/);
  assert.ok(copy.length <= MAX_DESCRIPTION);
  assert.doesNotMatch(copy, /ceiling|\bfees?\b|%/i);
  for (const word of ['ceiling', 'fee', 'fees', '%', 'CEILING']) {
    assert.throws(() => bazaarLimitsBoilerplate(word), /banned wording/);
  }
  assert.throws(() => bazaarLimitsBoilerplate('x'.repeat(501)), /exceeds 500/);
});

test('service-level copy follows the submission pack and names only what the instance sells', () => {
  assert.equal(serviceDescription(),
    'Pay-per-answer LLM chat, images, speech and Exa web search over x402 in USDC, no API key; the max charge is quoted before signing.');
  assert.equal(serviceDescription({ long: true }),
    'Pay-per-answer LLM chat (OpenAI, Anthropic and Responses formats), images, speech and Exa web search over x402 in USDC, with no API key. '
    + 'The SingIt SDK supports client-side per-call and per-day spend limits; the max charge is quoted before signing.');
  assert.equal(serviceDescription({ formats: false, search: false }),
    'Pay-per-answer LLM chat over x402 in USDC, no API key; the max charge is quoted before signing.');
  assert.doesNotMatch(serviceDescription({ formats: false }), /images|speech|Anthropic/);
  assert.doesNotMatch(serviceDescription({ search: false, long: true }), /Exa/);
  for (const long of [false, true]) assert.doesNotMatch(serviceDescription({ long }), /Agents can|markup|%|0x[0-9a-fA-F]{8,}/);
});

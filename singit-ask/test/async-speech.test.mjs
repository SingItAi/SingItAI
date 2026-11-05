import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVoiceModels } from '../src/catalogue.mjs';
import { ASYNC_SPEECH_MODELS } from '../src/speech-models.mjs';
import { asyncSpeechBody, generateAsyncSpeech, readSpeechRequest, speechListAtomic, speechPrice } from '../src/speech.mjs';
import { BASE, SOLANA } from '../src/pricing.mjs';

const config = { surplusUrl: 'https://surplus.test', surplusKey: 'test-key' };
export const metadata = ASYNC_SPEECH_MODELS.map(m => ({ id: m.upstreamId, architecture: { modality: 'music' },
  pricing: { image: String(m.usdPerJob), media_unit: 'job' }, voices: ['Aria'] }));
const parsed = parseVoiceModels({ data: metadata });
const audio = Buffer.from('ID3test-audio');
const json = value => Response.json(value);

test('exactly three allowlisted music models map to public speech ids and fixed job prices', () => {
  assert.deepEqual([...parsed.speech.keys()], ASYNC_SPEECH_MODELS.map(m => m.id));
  assert.equal(parseVoiceModels({ data: [{ ...metadata[0], id: 'venice-elevenlabs-tts-flash-v2-5' }] }).speech.size, 0);
  for (const model of parsed.speech.values()) {
    const req = readSpeechRequest({ input: 'Hello', voice: 'Aria' }, model);
    assert.deepEqual(asyncSpeechBody(model, req), { model: model.upstreamId, prompt: 'Hello', voice: 'Aria' });
    const list = speechListAtomic(model, req);
    assert.equal(list, model.usdPerJob === 0.12 ? 120000 : 2875);
    assert.equal(speechListAtomic(model, { input: 'x'.repeat(4096) }), list);
    assert.equal(speechPrice(list, BASE).totalAtomic, list === 120000 ? '157000' : '4738');
    assert.equal(speechPrice(list, SOLANA).totalAtomic, list === 120000 ? '158000' : '5738');
    for (const extra of [{ input: 'x'.repeat(4097) }, { voice: 'unknown' }, { speed: 1 }, { response_format: 'mp3' }])
      assert.throws(() => readSpeechRequest({ input: 'Hi', ...extra }, model));
  }
});

test('async speech submits with own key, polls then follows artifact redirects as bytes', async () => {
  for (const model of parsed.speech.values()) {
    const calls = [];
    const responses = [json({ id: 'job_123', status: 'queued' }), json({ status: 'running' }),
      json({ status: 'succeeded', results: [{}] }), new Response(audio)];
    const result = await generateAsyncSpeech(config, model, { input: 'Hello', voice: 'Aria' }, { pollMs: 1,
      fetchImpl: async (url, init) => { calls.push([url, init]); return responses.shift(); } });
    assert.deepEqual(result.audio, audio);
    assert.equal(result.format, 'mp3');
    assert.ok(calls.every(([, init]) => init.headers.Authorization === 'Bearer test-key'));
    assert.deepEqual(calls.map(([url]) => url), ['https://surplus.test/v1/music/generations',
      'https://surplus.test/v1/music/generations/job_123', 'https://surplus.test/v1/music/generations/job_123',
      'https://surplus.test/v1/media/artifacts/job_123/0']);
    assert.equal(calls.at(-1)[1].redirect, 'follow');
  }
});

for (const [name, responses, options] of [
  ['no credit', [new Response('{}', { status: 402 })]],
  ['submit failure', [new Response('{}', { status: 500 })]],
  ['failed job', [json({ id: 'job_123', status: 'failed' })]],
  ['poll failure', [json({ id: 'job_123', status: 'queued' }), new Response('{}', { status: 503 })]],
  ['late job', [], { timeoutMs: 10 }],
  ['missing result', [json({ id: 'job_123', status: 'succeeded', results: [] })]],
  ['invalid artifact', [json({ id: 'job_123', status: 'succeeded', results: [{}] }), new Response('{}')]],
  ['empty artifact', [json({ id: 'job_123', status: 'succeeded', results: [{}] }), new Response('')]],
  ['oversized artifact', [json({ id: 'job_123', status: 'succeeded', results: [{}] }), new Response(audio)], { maxBytes: 2 }],
]) test(`async speech rejects ${name} before a billable answer`, async () => {
  await assert.rejects(generateAsyncSpeech(config, parsed.speech.values().next().value, { input: 'Hello' }, {
    pollMs: 1, ...options, fetchImpl: async () => responses.shift() ?? json({ id: 'job_123', status: 'running' }),
  }));
});

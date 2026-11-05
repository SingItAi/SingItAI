import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelCatalogue, parseVoiceModels } from '../src/catalogue.mjs';
import { ASYNC_SPEECH_MODELS } from '../src/speech-models.mjs';
import { asyncSpeechBody, generateAsyncSpeech, readSpeechRequest, speechListAtomic, speechPrice } from '../src/speech.mjs';
import { BASE, SOLANA } from '../src/pricing.mjs';

const resolveHostname = async () => [{ address: '93.184.216.34', family: 4 }];
const config = { surplusUrl: 'https://surplus.test', surplusKey: 'test-key' };
export const metadata = ASYNC_SPEECH_MODELS.map(m => ({ id: m.upstreamId, architecture: { modality: 'music' },
  pricing: { image: String([0.12, 0.12, 0.002875][ASYNC_SPEECH_MODELS.indexOf(m)]), media_unit: 'job' }, voices: ['Aria'] }));
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
    const result = await generateAsyncSpeech(config, model, { input: 'Hello', voice: 'Aria' }, { resolveHostname, pollMs: 1,
      fetchImpl: async (url, init) => { calls.push([url, init]); return responses.shift(); } });
    assert.deepEqual(result.audio, audio);
    assert.equal(result.format, 'mp3');
    assert.ok(calls.every(([, init]) => init.headers.Authorization === 'Bearer test-key'));
    assert.deepEqual(calls.map(([url]) => url), ['https://surplus.test/v1/music/generations',
      'https://surplus.test/v1/music/generations/job_123', 'https://surplus.test/v1/music/generations/job_123',
      'https://surplus.test/v1/media/artifacts/job_123/0']);
    assert.equal(calls.at(-1)[1].redirect, 'manual');
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
    resolveHostname, pollMs: 1, ...options, fetchImpl: async () => responses.shift() ?? json({ id: 'job_123', status: 'running' }),
  }));
});

test('async speech price follows live catalogue changes', () => {
  for (const price of [0.03, 0.24]) {
    const model = parseVoiceModels({ data: [{ ...metadata[0], pricing: { image: String(price), media_unit: 'job' } }] }).speech.get(ASYNC_SPEECH_MODELS[0].id);
    assert.equal(model.usdPerJob, price);
    assert.equal(speechListAtomic(model, { input: 'Hi' }), price * 1e6);
  }
});

for (const image of [undefined, null, '', 'bad', NaN, Infinity, 0, -1, 2, 100, true]) {
  test(`invalid async price ${String(image)} is not offered`, async () => {
    const voice = parseVoiceModels({ data: [{ ...metadata[0], pricing: { image, media_unit: 'job' } }] });
    assert.equal(voice.speech.size, 0);
    const catalogue = new ModelCatalogue({ url: config.surplusUrl });
    catalogue.voiceModels = async () => voice;
    await assert.rejects(catalogue.resolveSpeech(ASYNC_SPEECH_MODELS[0].id), { status: 503 });
  });
}

for (const target of ['https://127.0.0.1/a', 'https://10.1.2.3/a', 'https://169.254.169.254/a',
  'http://public.test/a', 'https://100.64.0.1/a', 'https://[::1]/a', 'https://[::ffff:127.0.0.1]/a',
  'https://[fe80::1]/a', 'https://[fd00::1]/a', 'https://metadata.test/a']) {
  test(`unsafe artifact redirect refused: ${target}`, async () => {
    const calls = [];
    await assert.rejects(generateAsyncSpeech(config, [...parsed.speech.values()][0], { input: 'Hi' }, {
      resolveHostname: async host => host === 'metadata.test' ? [{ address: '169.254.169.254' }] : resolveHostname(),
      fetchImpl: async url => {
        calls.push(url);
        return calls.length === 1 ? json({ id: 'job_123', status: 'succeeded', results: [{}] })
          : new Response(null, { status: 302, headers: { location: target } });
      },
    }), { status: 503 });
    assert.equal(calls.length, 2);
  });
}

test('artifact redirects allow three public HTTPS hops, strip credentials, and stop on fourth', async () => {
  for (const count of [3, 4]) {
    const calls = [], lookups = [];
    const result = generateAsyncSpeech(config, [...parsed.speech.values()][0], { input: 'Hi' }, {
      resolveHostname: async host => { lookups.push(host); return resolveHostname(); },
      fetchImpl: async (url, init) => {
        calls.push([url, init]);
        if (calls.length === 1) return json({ id: 'job_123', status: 'succeeded', results: [{}] });
        return calls.length <= count + 1 ? new Response(null, { status: 302, headers: { location: `https://cdn.test/${calls.length}` } }) : new Response(audio);
      },
    });
    if (count === 4) await assert.rejects(result, { status: 503 });
    else assert.deepEqual((await result).audio, audio);
    assert.equal(calls[1][0], 'https://surplus.test/v1/media/artifacts/job_123/0');
    assert.ok(calls.slice(2).every(([, init]) => !init.headers.Authorization && init.redirect === 'manual'));
    assert.deepEqual(lookups, ['surplus.test', 'cdn.test', 'cdn.test', 'cdn.test']);
  }
});

test('hostname checks reject every unsafe DNS answer and re-resolve same-host redirects', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1']) {
    let lookups = 0, downloads = 0;
    await assert.rejects(generateAsyncSpeech(config, [...parsed.speech.values()][0], { input: 'Hi' }, {
      resolveHostname: async (host, options) => {
        assert.equal(host, 'surplus.test');
        assert.equal(options.all, true);
        return ++lookups === 1 ? resolveHostname() : [...await resolveHostname(), { address }];
      },
      fetchImpl: async url => {
        if (url.endsWith('/v1/music/generations')) return json({ id: 'job_123', status: 'succeeded', results: [{ url: 'https://evil.test' }] });
        assert.equal(url, 'https://surplus.test/v1/media/artifacts/job_123/0');
        downloads++;
        return new Response(null, { status: 302, headers: { location: url } });
      },
    }), { status: 503 });
    assert.equal(downloads, 1);
    assert.equal(lookups, 2);
  }
});

test('async speech requires catalogue job units', () => {
  for (const unit of [undefined, 'minute', '1K characters']) {
    assert.equal(parseVoiceModels({ data: [{ ...metadata[0], pricing: { image: '0.12', media_unit: unit } }] }).speech.size, 0);
  }
});

test('artifact download pins the validated address (no DNS rebind)', async () => {
  const seen = [];
  const result = await generateAsyncSpeech(config, [...parsed.speech.values()][0], { input: 'Hi' }, {
    resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url) => {
      if (String(url).includes('/v1/music/generations') && !String(url).includes('/v1/media/'))
        return json({ id: 'job_123', status: 'succeeded', results: [{}] });
      throw new Error('fetchImpl must not download the artifact when artifactFetch is set');
    },
    artifactFetch: async (url, init, address) => {
      seen.push({ href: url.href, address, redirect: init.redirect });
      return new Response(audio, { status: 200 });
    },
  });
  assert.deepEqual(result.audio, audio);
  assert.deepEqual(seen, [{ href: 'https://surplus.test/v1/media/artifacts/job_123/0',
    address: { address: '93.184.216.34', family: 4 }, redirect: 'manual' }]);
});

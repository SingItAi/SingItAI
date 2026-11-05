import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { Readable } from 'node:stream';
import { runMediaJob, artifactTarget, publicAddress, audioContentType } from '../src/media-jobs.mjs';
import { AUDIO_MODELS, audioPrices, readAudioGeneration, surplusAudioRequest } from '../src/audio-generation.mjs';
const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
const audio = Buffer.from('ID3audio');
function scenario(mode = 'success') {
  let polls = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([String(url), init]);
    if (init.method === 'POST') return mode === 'credit' ? Response.json({ error: { code: 'insufficient_credit' } }, { status: 402 }) : Response.json({ id: 'job_123', status: 'queued', job_token: 'private-token' }, { status: 202 });
    if (String(url).includes('/music/generations/')) return Response.json({ id: 'job_123', status: ++polls > 0 ? 'succeeded' : 'running' });
    if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } });
    return new Response(mode === 'invalid' ? '<html>bad</html>' : mode === 'oversize' ? Buffer.alloc(101) : audio);
  };
  return { calls, fetchImpl, artifactFetch: fetchImpl };
}
const options = { baseUrl: 'https://surplus.test', key: 'our-key', request: { model: 'upstream', text: 'rain' }, idempotencyKey: 'unique', timeoutMs: 1000, maxBytes: 100, resolve, sleep: async () => {} };
test('pinned fetch drains null-body responses and rejects callback errors', async (t) => {
  for (const status of [101, 204, 205, 304, 200]) {
    const res = Readable.from([]);
    res.statusCode = status;
    res.headers = status === 200 ? { 'invalid header': 'value' } : {};
    const resume = t.mock.method(res, 'resume');
    const request = t.mock.method(https, 'request', (_url, _init, callback) => ({
      on() {}, end() { queueMicrotask(() => callback(res)); },
    }));
    try {
      await assert.rejects(runMediaJob({ ...options,
        fetchImpl: async () => Response.json({ id: 'job123', status: 'succeeded' }),
      }), status === 101 ? RangeError : status === 200 ? TypeError
        : status === 304 ? /Artifact unavailable/ : /Non-audio artifact/);
      if (status !== 200) assert.equal(resume.mock.callCount(), 1);
    } finally { request.mock.restore(); resume.mock.restore(); }
  }
});
test('submit, poll and download audio bytes with our credit key; job token only on our host', async () => {
  const s = scenario();
  assert.deepEqual(await runMediaJob({ ...options, ...s }), { audio, contentType: 'audio/mpeg' });
  assert.equal(s.calls[0][1].headers.Authorization, 'Bearer our-key');
  assert.equal(s.calls[1][1].headers['X-Job-Token'], 'private-token');
  assert.equal(s.calls[2][0], 'https://surplus.test/v1/media/artifacts/job_123/0');
  assert.equal(s.calls[2][1].redirect, 'manual');
});
for (const mode of ['credit', 'invalid', 'oversize', 'redirect']) test(`job rejects ${mode} before returning billable audio`, async () => {
  const s = scenario(mode);
  await assert.rejects(runMediaJob({ ...options, ...s }));
  assert.ok(!s.calls.some(([url]) => url.includes('127.0.0.1')));
});
test('whole deadline bounds a hung submit', async () => {
  await assert.rejects(runMediaJob({ ...options, timeoutMs: 10, fetchImpl: () => new Promise(() => {}) }), /timeout/);
});
test('whole deadline also bounds a hung artifact stream', async () => {
  const s = scenario();
  await assert.rejects(runMediaJob({ ...options, ...s, timeoutMs: 10, artifactFetch: async () => new Response(new ReadableStream({ start() {} })) }), /timeout/);
});
test('https redirect strips credentials, public DNS only', async () => {
  const s = scenario(); let n = 0;
  const result = await runMediaJob({ ...options, ...s, artifactFetch: async (url, init) => {
    if (n++ === 0) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/audio' } });
    assert.deepEqual(init.headers, {}); return new Response(audio);
  } });
  assert.equal(result.contentType, 'audio/mpeg');
  for (const url of ['http://example.com/a', 'https://localhost/a', 'https://[::1]/a', 'https://u:p@example.com/a', 'https://2130706433/a', 'https://[::ffff:127.0.0.1]/a']) await assert.rejects(artifactTarget(url, resolve));
  await assert.rejects(artifactTarget('https://example.com', async () => [{ address: '10.0.0.1', family: 4 }]));
  for (const ip of ['0.0.0.0', '127.1.2.3', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '192.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '2002:7f00:1::1', '2001:db8::1']) assert.equal(publicAddress(ip), false, ip);
});
test('recognized audio container signatures', () => {
  for (const [bytes, type] of [['ID3a', 'audio/mpeg'], ['RIFF0000WAVE', 'audio/wav'], ['OggS', 'audio/ogg'], ['fLaC', 'audio/flac'], ['ADIF', 'audio/aac'], ['0000ftypM4A ', 'audio/mp4']]) assert.equal(audioContentType(Buffer.from(bytes)), type);
  assert.throws(() => audioContentType(Buffer.from('0000ftypisom')));
});
test('model mapping and integer-rounded flat prices on Base', () => {
  assert.deepEqual(audioPrices().map(m => m.exact.base.usd), [.027, .003691, .053, .313, .313]);
  for (const m of AUDIO_MODELS) {
    const body = m.kind === 'music' ? { prompt: 'song', lyrics: 'words', model: m.id } : { text: 'rain', model: m.id };
    const { request } = readAudioGeneration(body, m.kind);
    assert.equal(surplusAudioRequest(request).model, m.upstream);
  }
});
test('invalid input is 422, including model capabilities and duration caps', () => {
  for (const [kind, body] of [['sound-effects', { text: '' }], ['sound-effects', { text: 'a'.repeat(1001) }], ['sound-effects', { text: 'rain', duration_seconds: 23 }], ['sound-effects', { text: 'rain', duration_seconds: NaN }], ['sound-effects', { text: 'rain', response_format: 'json' }], ['music', { prompt: 'song' }], ['music', { prompt: 'song', lyrics: 'words', instrumental: true }], ['music', { prompt: 'song', lyrics: 'words', duration_seconds: 241 }], ['music', { prompt: 'song', model: 'minimax/music-2.5', instrumental: true, lyrics: 'words' }]]) assert.throws(() => readAudioGeneration(body, kind), { status: 422 });
  assert.equal(readAudioGeneration({ prompt: 'song', model: 'minimax/music-2.6', instrumental: true }, 'music').request.instrumental, true);
});

test('polling deadline and terminal upstream failures do not download artifacts', async () => {
  for (const terminal of [false, true]) {
    let clock = 0, downloads = 0;
    await assert.rejects(runMediaJob({ ...options, now: () => clock, sleep: async ms => { clock += ms; },
      fetchImpl: async (_url, init) => Response.json({ id: 'job123', status: init.method === 'POST' ? 'queued' : terminal ? 'failed' : 'running' }),
      artifactFetch: async () => { downloads++; return new Response(audio); },
    }));
    assert.equal(downloads, 0);
  }
});
test('stream cap cancels oversized artifacts and refuses an oversized Content-Length', async () => {
  for (const declared of [false, true]) {
    const s = scenario(); let cancelled = false;
    await assert.rejects(runMediaJob({ ...options, ...s, artifactFetch: async () => new Response(new ReadableStream({
      pull(c) { c.enqueue(Buffer.alloc(101)); }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: declared ? { 'content-length': '101' } : {} }) }));
    assert.equal(cancelled, true);
  }
});

test('queued timeout cancels once with independent signal and job auth', async () => {
  for (const token of [undefined, 'private-token']) {
    let clock = 0;
    const calls = [];
    await assert.rejects(runMediaJob({ ...options, now: () => clock,
      sleep: async ms => { clock += ms; },
      fetchImpl: async (_url, init) => {
        calls.push(init);
        if (init.method === 'DELETE') { assert.equal(init.signal.aborted, false); throw new Error('cancel unavailable'); }
        return Response.json({ id: 'job123', status: 'queued', job_token: token });
      },
    }), { code: 'timeout', jobId: 'job123', lastStatus: 'queued' });
    const deletes = calls.filter(c => c.method === 'DELETE');
    assert.equal(deletes.length, 1);
    assert.deepEqual(deletes[0].headers, token ? { 'X-Job-Token': token } : { Authorization: 'Bearer our-key' });
  }
});

test('terminal failures need no cancellation and carry diagnostic fields', async () => {
  for (const status of ['failed', 'canceled', 'cancelled', 'expired']) {
    const calls = [];
    await assert.rejects(runMediaJob({ ...options, fetchImpl: async (_url, init) => {
      calls.push(init); return Response.json({ id: 'job123', status });
    } }), { code: 'job_failed', jobId: 'job123', lastStatus: status });
    assert.equal(calls.length, 1);
  }
});

test('poll delays back off from two seconds, cap at ten and stop at deadline', async () => {
  let clock = 0, polls = 0;
  const delays = [], deletes = [];
  await assert.rejects(runMediaJob({ ...options, timeoutMs: 41000, now: () => clock,
    sleep: async ms => { delays.push(ms); clock += ms; },
    fetchImpl: async (_url, init) => {
      if (init.method === 'DELETE') { deletes.push(init); return new Response(null, { status: 204 }); }
      if (init.method !== 'POST') { assert.ok(clock < 41000); polls++; }
      return Response.json({ id: 'job123', status: ['queued', 'running', 'processing', 'pending'][polls % 4] });
    },
  }), { code: 'timeout' });
  assert.deepEqual(delays, [2000, 3000, 5000, 8000, 10000, 10000, 3000]);
  assert.equal(polls, 6);
  assert.equal(deletes.length, 1);
});

test('success and artifact failure after succeeded never cancel', async () => {
  for (const mode of ['success', 'invalid']) {
    const s = scenario(mode);
    if (mode === 'success') await runMediaJob({ ...options, ...s });
    else await assert.rejects(runMediaJob({ ...options, ...s }), { code: 'artifact_failed', jobId: 'job_123', lastStatus: 'succeeded' });
    assert.ok(s.calls.every(([, init]) => init.method !== 'DELETE'));
  }
});

test('poll and submit failures have reason codes; poll failure cancels', async () => {
  for (const submit of [true, false]) {
    let deletes = 0;
    await assert.rejects(runMediaJob({ ...options, fetchImpl: async (_url, init) => {
      if (init.method === 'DELETE') { deletes++; return new Response(null, { status: 204 }); }
      if (submit || init.method !== 'POST') throw new Error('upstream secret');
      return Response.json({ id: 'job123', status: 'queued' });
    } }), { code: submit ? 'submit_failed' : 'poll_failed' });
    assert.equal(deletes, submit ? 0 : 1);
  }
});

test('real deadline cancels a stalled poll without masking timeout', async () => {
  let cancelSignal;
  await assert.rejects(runMediaJob({ ...options, timeoutMs: 10,
    fetchImpl: async (_url, init) => {
      if (init.method === 'POST') return Response.json({ id: 'job123', status: 'queued' });
      if (init.method === 'DELETE') { cancelSignal = init.signal; assert.equal(cancelSignal.aborted, false); return new Response(null, { status: 204 }); }
      return new Promise(() => {});
    },
  }), { code: 'timeout', jobId: 'job123', lastStatus: 'queued' });
  assert.ok(cancelSignal);
});


test('submit HTTP failure preserves upstream status and code', async () => {
  await assert.rejects(runMediaJob({ ...options,
    fetchImpl: async () => Response.json({ error: { code: 'no_healthy_sellers' } }, { status: 503 }),
  }), { code: 'submit_failed', upstreamStatus: 503, upstreamCode: 'no_healthy_sellers' });
});

test('poll HTTP failure preserves diagnostics and cancels the job', async () => {
  const calls = [];
  await assert.rejects(runMediaJob({ ...options, fetchImpl: async (url, init) => {
    calls.push([String(url), init]);
    if (init.method === 'POST') return Response.json({ id: 'job123', status: 'queued' });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ error: { type: 'rate_limit_error' } }, { status: 429 });
  } }), { code: 'poll_failed', upstreamStatus: 429, upstreamCode: 'rate_limit_error' });
  const deletes = calls.filter(([, init]) => init.method === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0][0], calls[1][0]);
  assert.ok(deletes[0][0].endsWith('/job123'));
});

test('terminal failed job preserves upstream error type', async () => {
  await assert.rejects(runMediaJob({ ...options,
    fetchImpl: async () => Response.json({ id: 'job123', status: 'failed', error: { type: 'provider_error' } }),
  }), { code: 'job_failed', upstreamCode: 'provider_error' });
});

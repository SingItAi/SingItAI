// Native format routes (POST /v1/messages, POST /v1/responses) fall back after payment the way /v1/chat/completions does:
// one alternate, before the first data event, inside the signed amount and the Solana exact window, one settlement.
// Mocked Surplus (fetchImpl) and a fake facilitator; no network, keys or payments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve, CONFIG, decode, sseResponse } from './helpers/agent-app.mjs';
import { BASE, SOLANA } from '../src/app.mjs';
import { UnknownModel } from '../src/catalogue.mjs';
import { withMinBudget, REASONING_MIN_UPSTREAM_TOKENS } from '../src/formats.mjs';

const price = (id, prompt, completion, extra = {}) => ({ id, name: id, provider: 'x', contextLength: 1e6, promptUsdPerToken: prompt, completionUsdPerToken: completion, ...extra });
const MODELS = [
  price('cheap-a', 0.1e-6, 0.3e-6),
  price('cheap-b', 0.1e-6, 0.4e-6),
  price('deepseek-v4-flash', 0.1e-6, 0.35e-6),
  price('deepseek-v4.1-flash', 0.1e-6, 0.3e-6),
  price('glm-4.7-flash', 0.2e-6, 0.8e-6),
  price('glm-5.3-flash', 0.2e-6, 0.8e-6),
  price('gemma-4-31b', 0.2e-6, 0.8e-6),
  price('qwen3-5-9b', 0.1e-6, 0.3e-6, { tags: ['reasoning'] }),
  price('think-cheap', 0.1e-6, 0.25e-6, { tags: ['reasoning'] }),
  price('dear-model', 5e-6, 20e-6),
];
const makeCatalogue = (models = MODELS, shares = {}) => ({
  async resolve(id) { const m = models.find(x => x.id === id); if (!m) throw new UnknownModel('no'); return m; },
  async list() { return [...models].sort((a, b) => a.completionUsdPerToken - b.completionUsdPerToken); },
  async canAnswer() { return true; },
  guardShare: id => shares[id] ?? null,
});

const frame = (data, event) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
const okJson = path => path === '/v1/messages'
  ? { id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn', usage: { buyer_cost_micro: 3 } }
  : { id: 'resp', object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }], usage: { buyer_cost_micro: 3 } };
const okFrames = path => path === '/v1/messages' ? [
  frame({ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 1 } } }, 'message_start'),
  frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start'),
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ans' } }, 'content_block_delta'),
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'wer' } }, 'content_block_delta'),
  frame({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
  frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2, buyer_cost_micro: 3 } }, 'message_delta'),
  frame({ type: 'message_stop' }, 'message_stop')] : [
  frame({ type: 'response.created', sequence_number: 0, response: { id: 'resp', object: 'response', status: 'in_progress', output: [] } }, 'response.created'),
  frame({ type: 'response.output_text.delta', sequence_number: 1, output_index: 0, content_index: 0, item_id: 'm', delta: 'answer' }, 'response.output_text.delta'),
  frame({ type: 'response.completed', sequence_number: 2, response: { id: 'resp', object: 'response', status: 'completed',
    output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer' }] }], usage: { output_tokens: 2, buyer_cost_micro: 3 } } }, 'response.completed')];
const answered = (path, stream) => stream ? sseResponse(okFrames(path)) : Response.json(okJson(path));
// Surplus refusing: the same codes production logged.
const refused = (path, code = 'overloaded_error', status = 503) => Response.json(path === '/v1/messages'
  ? { type: 'error', error: { type: code, message: 'upstream words are never matched' } }
  : { error: { type: 'service_unavailable', code, message: 'upstream words are never matched' } }, { status });
const spentReasoning = path => Response.json(path === '/v1/messages'
  ? { type: 'message', role: 'assistant', stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '...' }], usage: { buyer_cost_micro: 1 } }
  : { object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning', summary: [] }], usage: { buyer_cost_micro: 1 } });

const body = (path, model, { stream = false, tokens = 300, ...rest } = {}) => path === '/v1/messages'
  ? { model, max_tokens: tokens, messages: [{ role: 'user', content: 'Say hi.' }], stream, ...rest }
  : { model, input: 'Say hi.', max_output_tokens: tokens, stream, ...rest };
const tokensOf = sent => sent.max_tokens ?? sent.max_output_tokens;

function signature(required, network, scheme) {
  const accepted = required.accepts.find(a => a.network === network && a.scheme === scheme);
  return { accepted, header: Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource, accepted,
    payload: network === SOLANA ? { transaction: 'signed' } : { signature: '0xsigned' }, extensions: required.extensions })).toString('base64') };
}
// Solana exact windows run on a scripted clock; the reserve timer is the shorter one.
function reserveClock() {
  const t0 = Date.now(), timers = new Map();
  let id = 0;
  return { timers, now: () => t0, setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: n => timers.delete(n),
    fireAll() { for (const [n, t] of [...timers]) { timers.delete(n); t.fn(); } },
    fireReserve() { const [n, t] = [...timers].sort((a, b) => a[1].ms - b[1].ms)[0]; timers.delete(n); t.fn(); } };
}
const waitFor = async condition => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(condition(), 'condition reached'); };
const hangs = options => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));

// One paid call: `script(model, call)` is what Surplus answers; `models` records who was asked, in order.
async function paid(t, path, { model = 'glm-4.7-flash', network = BASE, scheme = 'exact', stream = false, tokens, extra, headers = {},
  script, catalogue = makeCatalogue(), clock, config = CONFIG } = {}) {
  const sent = [];
  const ctx = await serve(t, { upstream: null, catalogue, clock, config, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); sent.push(request);
    return script(request.model, sent.length, options, request); } });
  const request = body(path, model, { stream, tokens, ...extra });
  const settled = [];
  const settle = ctx.facilitator.settle.bind(ctx.facilitator);
  ctx.facilitator.settle = async (...args) => { if (args[0].payload.type !== 'deposit') settled.push(BigInt(args[1].amount)); return settle(...args); };
  const challenge = await ctx.url(request, {}, path);
  assert.equal(challenge.status, 402);
  const { accepted, header } = signature(decode(challenge.headers.get('payment-required')), network, scheme);
  const send = () => ctx.url(request, { 'payment-signature': header, ...headers }, path);
  return { ...ctx, sent, settled, send, signed: BigInt(accepted.amount), models: () => sent.map(s => s.model) };
}

for (const path of ['/v1/messages', '/v1/responses']) for (const stream of [false, true]) {
  const label = `${path}${stream ? ' stream' : ''}`;

  test(`${label}: overloaded_error / no_healthy_sellers on a pinned out-of-tier model falls back once, one settlement within the signed amount`, async t => {
    for (const [code, status] of [['overloaded_error', 503], ['no_healthy_sellers', 503], ['not_found_error', 404]]) {
      const ctx = await paid(t, path, { stream, script: model => model === 'glm-4.7-flash' ? refused(path, code, status) : answered(path, stream) });
      const res = await ctx.send();
      assert.equal(res.status, 200, `${code}: ${await res.clone().text()}`);
      assert.deepEqual(ctx.models(), ['glm-4.7-flash', 'cheap-a'], code);
      assert.equal(ctx.settled.length, 1, code);
      assert.ok(ctx.settled[0] <= ctx.signed + 100n, 'never above the signed amount');
      assert.equal(res.headers.get('x-singit-model'), 'cheap-a');
      assert.equal(res.headers.get('x-singit-fallback-from'), 'glm-4.7-flash');
      assert.equal(res.headers.get('x-singit-fallback-policy'), 'paid');
      assert.ok(!/markup/i.test(await res.text()));
    }
  });

  test(`${label}: a dearer model than the one quoted is never the alternate`, async t => {
    const catalogue = makeCatalogue(MODELS.filter(m => ['glm-4.7-flash', 'dear-model'].includes(m.id)));
    const ctx = await paid(t, path, { stream, catalogue, script: model => model === 'glm-4.7-flash' ? refused(path) : answered(path, stream) });
    const res = await ctx.send();
    assert.equal(res.status, 503);
    assert.deepEqual(ctx.models(), ['glm-4.7-flash']);
    assert.ok(ctx.settled.every(amount => amount === 0n), 'nothing charged');
  });

  test(`${label}: X-SingIt-Fallback: off stays pinned after payment`, async t => {
    const ctx = await paid(t, path, { stream, headers: { 'x-singit-fallback': 'off' }, script: () => refused(path) });
    const res = await ctx.send();
    assert.equal(res.status, 503);
    assert.deepEqual(ctx.models(), ['glm-4.7-flash']);
    assert.ok(ctx.settled.every(amount => amount === 0n));
  });

  test(`${label}: a second failure is final: one alternate, no charge`, async t => {
    const ctx = await paid(t, path, { stream, script: () => refused(path) });
    const res = await ctx.send();
    assert.equal(res.status, 503);
    assert.equal(ctx.sent.length, 2);
    assert.ok(ctx.settled.every(amount => amount === 0n));
    assert.equal((await res.json()).error?.code ?? 'no_billable_answer', 'no_billable_answer');
  });

  test(`${label}: a minimum_discount_not_met that can be relaxed is retried on the same model before switching`, async t => {
    const catalogue = makeCatalogue(MODELS, { 'glm-4.7-flash': 0.2 });
    let first = true;
    const ctx = await paid(t, path, { stream, catalogue, script: model => {
      if (model === 'glm-4.7-flash' && first) { first = false;
        return Response.json({ error: { type: 'not_found', code: 'minimum_discount_not_met', message: 'Best otherwise-eligible estimated discount is 77.5862%' } }, { status: 404 }); }
      return answered(path, stream); } });
    const res = await ctx.send();
    assert.equal(res.status, 200);
    assert.deepEqual(ctx.models(), ['glm-4.7-flash', 'glm-4.7-flash']);
    assert.equal(res.headers.get('x-singit-fallback-from'), null);
    assert.equal(ctx.settled.length, 1);
  });

  test(`${label}: the service default and out-of-tier models both get an alternate`, async t => {
    const ctx = await paid(t, path, { stream, model: 'deepseek-v4.1-flash', script: model => model === 'deepseek-v4.1-flash' ? refused(path, 'overloaded_error') : answered(path, stream) });
    const res = await ctx.send();
    assert.equal(res.status, 200);
    assert.equal(ctx.models().length, 2);
    assert.equal(ctx.settled.length, 1);
  });
}

test('/v1/messages: deepseek-v4.1-flash 404 not_found_error falls back to a non-deepseek model and is learned per format', async t => {
  // deepseek-v4.1-flash is the default and is not served on Messages: asked once, then skipped; /v1/responses still uses it.
  const path = '/v1/messages';
  const calls = [];
  const script = model => { calls.push(model); return model === 'deepseek-v4.1-flash' ? refused(path, 'not_found_error', 404) : answered(path, false); };
  const first = await paid(t, path, { model: 'deepseek-v4.1-flash', script });
  assert.equal((await first.send()).status, 200);
  assert.deepEqual(first.models(), ['deepseek-v4.1-flash', 'cheap-a'], 'cheap-a, not deepseek-v4-flash or another deepseek');
  assert.ok(!first.models().slice(1).some(m => m.startsWith('deepseek-')));
  assert.equal(first.settled.length, 1);
  // The same app asked again skips the known miss and goes straight to the alternate.
  const again = await first.send();
  assert.equal(again.status, 200);
  assert.deepEqual(first.models().slice(2), ['cheap-a'], 'learned: the known miss is not asked again');
});

test('/v1/messages never tries a deepseek reviewed default for glm-5.3-flash; /v1/responses does', async t => {
  const messages = await paid(t, '/v1/messages', { model: 'glm-5.3-flash', script: model => model === 'glm-5.3-flash' ? refused('/v1/messages') : answered('/v1/messages', false) });
  assert.equal((await messages.send()).status, 200);
  assert.deepEqual(messages.models(), ['glm-5.3-flash', 'cheap-a']);
  const responses = await paid(t, '/v1/responses', { model: 'glm-5.3-flash', script: model => model === 'glm-5.3-flash' ? refused('/v1/responses') : answered('/v1/responses', false) });
  assert.equal((await responses.send()).status, 200);
  assert.equal(responses.models()[1], 'deepseek-v4-flash', 'reviewed default is kept on /v1/responses');
});

test('a 404 on /v1/messages does not hide the model on /v1/responses', async t => {
  const m = await paid(t, '/v1/messages', { model: 'deepseek-v4.1-flash', script: model => model === 'deepseek-v4.1-flash' ? refused('/v1/messages', 'not_found_error', 404) : answered('/v1/messages', false) });
  assert.equal((await m.send()).status, 200);
  const r = await paid(t, '/v1/responses', { model: 'deepseek-v4.1-flash', script: model => answered('/v1/responses', false) });
  assert.equal((await r.send()).status, 200);
  assert.deepEqual(r.models(), ['deepseek-v4.1-flash']);
});

for (const path of ['/v1/messages', '/v1/responses']) {
  test(`${path} stream: after the first data event a later failure starts no second model and settles nothing`, async t => {
    const frames = okFrames(path);
    const cut = frames.findIndex(f => /ans/.test(f)) + 1;
    const ctx = await paid(t, path, { stream: true, script: () => new Response(new ReadableStream({ async start(c) {
      const enc = new TextEncoder(); for (const f of frames.slice(0, cut)) c.enqueue(enc.encode(f));
      await new Promise(r => setTimeout(r, 20)); c.error(new Error('reset')); } }), { headers: { 'content-type': 'text/event-stream' } }) });
    const res = await ctx.send();
    const text = await res.text();
    assert.equal(ctx.sent.length, 1, 'no second model');
    assert.match(text, /ans/);
    assert.ok(!/billing|message_stop|response\.completed/.test(text), text);
    assert.ok(ctx.settled.every(amount => amount === 0n));
  });
}

// ---- reasoning budget ----------------------------------------------------------------------------------------------
for (const path of ['/v1/messages', '/v1/responses']) {
  test(`${path}: a reasoning model at 150 tokens is asked for a larger budget upstream, still billed within the signed amount`, async t => {
    const ctx = await paid(t, path, { model: 'qwen3-5-9b', tokens: 150, script: () => answered(path, false) });
    const res = await ctx.send();
    assert.equal(res.status, 200);
    assert.deepEqual(ctx.models(), ['qwen3-5-9b']);
    assert.ok(tokensOf(ctx.sent[0]) >= REASONING_MIN_UPSTREAM_TOKENS, `asked for ${tokensOf(ctx.sent[0])}`);
    assert.equal(ctx.settled.length, 1);
    assert.ok(ctx.settled[0] <= ctx.signed + 100n);
  });

  for (const network of [BASE, SOLANA]) test(`${path} ${network}: a reasoning model that still spends everything thinking is answered once by a non-reasoning alternate`, async t => {
    const clock = network === SOLANA ? reserveClock() : undefined;
    const ctx = await paid(t, path, { model: 'qwen3-5-9b', tokens: 150, network, clock, script: model => model === 'qwen3-5-9b' ? spentReasoning(path) : answered(path, false) });
    const res = await ctx.send();
    assert.equal(res.status, 200, await res.clone().text());
    // Base may spend its one reasoning retry first; Solana exact never does (no time to spare).
    assert.deepEqual(ctx.models(), network === SOLANA ? ['qwen3-5-9b', 'cheap-a'] : ['qwen3-5-9b', 'qwen3-5-9b', 'cheap-a']);
    assert.equal(ctx.settled.length, 1);
    assert.ok(ctx.settled[0] <= ctx.signed + 100n);
  });

  test(`${path}: no non-reasoning alternate means a 422 with a machine-actionable next_action and nothing settled`, async t => {
    const only = makeCatalogue(MODELS.filter(m => ['qwen3-5-9b', 'think-cheap', 'dear-model'].includes(m.id)));
    const ctx = await paid(t, path, { model: 'qwen3-5-9b', tokens: 150, catalogue: only, script: () => spentReasoning(path) });
    const res = await ctx.send();
    assert.equal(res.status, 422);
    const json = await res.json();
    const error = json.error;
    assert.equal(error.code, 'max_tokens_too_small');
    assert.deepEqual(error.next_action, { type: 'raise_max_tokens', field: path === '/v1/messages' ? 'max_tokens' : 'max_output_tokens', minimum: REASONING_MIN_UPSTREAM_TOKENS });
    assert.ok(ctx.settled.every(amount => amount === 0n));
  });

  test(`${path}: X-SingIt-Fallback: off keeps a reasoning model pinned (422, nothing settled)`, async t => {
    const ctx = await paid(t, path, { model: 'qwen3-5-9b', tokens: 150, headers: { 'x-singit-fallback': 'off' }, script: () => spentReasoning(path) });
    const res = await ctx.send();
    assert.equal(res.status, 422);
    assert.ok(ctx.models().every(m => m === 'qwen3-5-9b'));
    assert.ok(ctx.settled.every(amount => amount === 0n));
  });
}

test('withMinBudget does not raise a budget when the dearest answer would exceed three times the quote, nor for a non-reasoning model', () => {
  const info = price('r', 40e-6, 40e-6, { tags: ['reasoning'] });
  const format = { model: 'r', info, chars: 20, maxTokens: 16, messageCount: 1, share: 1, minDiscount: null, request: { model: 'r', max_tokens: 272 } };
  assert.equal(withMinBudget(format.request, format, 0.3).raised, false);
  const cheap = price('c', 0.1e-6, 0.3e-6, { tags: ['reasoning'] });
  assert.equal(withMinBudget({ model: 'c', max_tokens: 406 }, { ...format, model: 'c', info: cheap, maxTokens: 150 }, 0.3).raised, true);
  assert.equal(withMinBudget({ model: 'cheap-a', max_tokens: 150 }, { ...format, info: price('cheap-a', 1e-7, 3e-7), maxTokens: 150 }, 0.3).raised, false);
});

// ---- Solana exact window ------------------------------------------------------------------------------------------
for (const path of ['/v1/messages', '/v1/responses']) for (const stream of [false, true]) {
  test(`${path}${stream ? ' stream' : ''} solana exact: a first model that overruns the reserved slice falls back inside the window, one settlement`, async t => {
    const clock = reserveClock();
    const ctx = await paid(t, path, { stream, network: SOLANA, clock, script: (model, _n, options) => model === 'glm-4.7-flash' ? hangs(options) : answered(path, stream) });
    const pending = ctx.send();
    await waitFor(() => clock.timers.size >= 2);
    clock.fireReserve();
    const res = await pending;
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(ctx.models(), ['glm-4.7-flash', 'cheap-a']);
    assert.equal(ctx.settled.length, 1);
    assert.ok(ctx.settled[0] <= ctx.signed + 100n);
  });

  test(`${path}${stream ? ' stream' : ''} solana exact: the window cutoff starts no alternate and settles nothing`, async t => {
    const clock = reserveClock();
    const ctx = await paid(t, path, { stream, network: SOLANA, clock, script: (_model, _n, options) => hangs(options) });
    const pending = ctx.send();
    await waitFor(() => clock.timers.size >= 2);
    clock.fireAll();
    const res = await pending;
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('x-singit-error'), 'no_billable_answer');
    assert.deepEqual(ctx.models(), ['glm-4.7-flash'], 'no alternate after the cutoff');
    assert.equal(ctx.settled.length, 0);
  });
}

test('/v1/messages solana exact stream: a model with data on the wire is not cut for the reserve', async t => {
  const path = '/v1/messages', clock = reserveClock(), frames = okFrames(path);
  let open;
  const gate = new Promise(r => { open = r; });
  const ctx = await paid(t, path, { stream: true, network: SOLANA, clock, script: () => new Response(new ReadableStream({ async start(c) {
    const enc = new TextEncoder(); for (const f of frames.slice(0, 3)) c.enqueue(enc.encode(f)); await gate;
    for (const f of frames.slice(3)) c.enqueue(enc.encode(f)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const pending = ctx.send();
  await waitFor(() => ctx.sent.length === 1 && clock.timers.size >= 2);
  await new Promise(r => setTimeout(r, 30));
  clock.fireReserve();
  await new Promise(r => setTimeout(r, 30));
  open();
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(ctx.sent.length, 1, 'no alternate once the client has data');
  assert.equal(ctx.settled.length, 1);
});

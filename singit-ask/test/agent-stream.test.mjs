import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, CONFIG, QUESTION, decode, sseResponse } from './helpers/agent-app.mjs';
import { BASE, SOLANA, UpstreamError } from '../src/app.mjs';
import { HealthStats, numbersBody } from '../src/health-stats.mjs';
import { clientSource } from '../src/agent-traffic.mjs';
const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
const toolCalls = [{ id: 'call_test', type: 'function', function: { name: 'lookup', arguments: '{"q":"test"}' } }];
function signature(required, network, scheme) {
  const accepted = required.accepts.find(a => a.network === network && a.scheme === scheme);
  const from = CONFIG.payToSolana;
  const payload = network === SOLANA && scheme === 'upto' ? { from, channelId: from, maxAmount: accepted.amount, deposit: accepted.amount, nonce: '1', openSlot: '123', openTransaction: 'mock', expiresAt: Math.floor(Date.now()/1000)+300, validAfter: Math.floor(Date.now()/1000), authorizedSigner: from } : { signature: '0xsigned' };
  return Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource, accepted, payload, extensions: required.extensions })).toString('base64');
}
const frames = text => text.trim().split('\n\n').map(frame => { const data = frame.split('\n').find(l => l.startsWith('data: ')).slice(6); return data === '[DONE]' ? data : JSON.parse(data); });
const sse = (data, event) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
// What Surplus streams for each path: text or a tool call in two pieces, then the usage that carries the cost.
function upstreamFrames(path, tool, { cost = 1 } = {}) {
  if (path === '/v1/messages') return [
    sse({ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'cheap-model', content: [], stop_reason: null, usage: { input_tokens: 1 } } }, 'message_start'),
    sse({ type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call_test', name: 'lookup', input: {} } : { type: 'text', text: '' } }, 'content_block_start'),
    sse({ type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: '{"q":' } : { type: 'text_delta', text: 'ans' } }, 'content_block_delta'),
    sse({ type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: '"test"}' } : { type: 'text_delta', text: 'wer' } }, 'content_block_delta'),
    sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
    sse({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2, buyer_cost_micro: cost } }, 'message_delta'),
    sse({ type: 'message_stop' }, 'message_stop')];
  if (path === '/v1/responses') {
    const item = tool ? { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'lookup', arguments: '{"q":"test"}', status: 'completed' } : { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] };
    return [
      sse({ type: 'response.created', sequence_number: 0, response: { id: 'resp_test', object: 'response', status: 'in_progress', output: [] } }, 'response.created'),
      sse({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: tool ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } }, 'response.output_item.added'),
      sse(tool ? { type: 'response.function_call_arguments.delta', sequence_number: 2, output_index: 0, item_id: 'fc_test', delta: '{"q":"test"}' } : { type: 'response.output_text.delta', sequence_number: 2, output_index: 0, content_index: 0, item_id: 'msg_test', delta: 'answer' }, tool ? 'response.function_call_arguments.delta' : 'response.output_text.delta'),
      sse({ type: 'response.completed', sequence_number: 3, response: { id: 'resp_test', object: 'response', status: 'completed', model: 'cheap-model', output: [item], usage: { input_tokens: 1, output_tokens: 2, buyer_cost_micro: cost } } }, 'response.completed')];
  }
  const base = { id: 'up_1', object: 'chat.completion.chunk', created: 1, model: 'cheap-model' };
  return [
    sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
    sse({ ...base, choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: 'call_test', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] } : { content: 'ans' }, finish_reason: null }] }),
    sse({ ...base, choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, function: { arguments: '"test"}' } }] } : { content: 'wer' }, finish_reason: null }] }),
    sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] }),
    sse({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, buyer_cost_micro: cost } }),
    sse('[DONE]')];
}
for (const network of [BASE, SOLANA]) for (const scheme of ['upto', 'exact']) for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) for (const tool of [false, true]) test(`${network} ${scheme} ${path} live SSE ${tool ? 'tools' : 'text'}`, async t => {
  let upstreamCalls = 0;
  const { url, facilitator, app } = await serve(t, { upstream: null, log: process.env.DBG ? console.error : undefined, fetchImpl: async (_url, options) => { upstreamCalls++; assert.equal(JSON.parse(options.body).stream, true); if (path.endsWith('completions')) assert.deepEqual(JSON.parse(options.body).stream_options, { include_usage: true }); return sseResponse(upstreamFrames(path, tool)); } });
  const body = { ...QUESTION, model: 'cheap-model', stream: true, ...(tool ? { tools } : {}), ...(path.endsWith('responses') ? { input: 'test', max_output_tokens: 300 } : {}), ...(path.endsWith('completions') ? { stream_options: { include_usage: true } } : {}) };
  const challenge = await url(body, {}, path);
  assert.equal(challenge.status, 402);
  let settled = 0;
  const settle = facilitator.settle.bind(facilitator);
  facilitator.settle = async (...args) => { settled++; return settle(...args); };
  const res = await url(body, { 'payment-signature': signature(decode(challenge.headers.get('payment-required')), network, scheme), 'user-agent': 'OpenAI/Python secret' }, path);
  assert.equal(res.status, 200, await res.clone().text()); assert.match(res.headers.get('content-type'), /text\/event-stream/); assert.equal(res.headers.get('cache-control'), 'no-cache');
  const text = await res.text(), events = frames(text);
  assert.equal(upstreamCalls, 1);
  assert.equal(settled, scheme === 'upto' && network === SOLANA ? 2 : 1, 'one settlement (plus the Solana upto deposit)');
  assert.ok(!/buyer_cost_micro|"provider"/.test(text.replace(/"usage":\{[^}]*\}/g, '')) || path.endsWith('completions'));
  if (path.endsWith('completions')) { assert.equal(events.at(-1), '[DONE]'); assert.deepEqual(events.at(-2).choices, []); assert.ok(events.at(-3).billing); assert.equal(events[0].choices[0].delta.role, 'assistant'); assert.equal(events.at(-3).choices[0].finish_reason, tool ? 'tool_calls' : 'stop'); if (tool) assert.equal(events[0].choices[0].delta.tool_calls[0].index, 0); else assert.equal(events.map(e => e.choices?.[0]?.delta?.content ?? '').join(''), 'answer'); }
  else if (path.endsWith('messages')) { assert.equal(events[0].type, 'message_start'); assert.equal(events.at(-1).type, 'message_stop'); assert.ok(events.at(-2).billing); assert.equal(events.at(-2).billing.totalAtomic, scheme === 'exact' ? events.at(-2).billing.totalAtomic : events.at(-2).billing.totalAtomic); assert.match(text, /event: content_block_delta/); assert.ok(!text.includes('buyer_cost_micro')); }
  else { assert.equal(events[0].type, 'response.created'); assert.equal(events.at(-1).type, 'response.completed'); assert.ok(events.at(-1).response.billing); assert.ok(!text.includes('[DONE]')); assert.ok(!text.includes('buyer_cost_micro')); }
  if (scheme === 'exact') assert.equal((path.endsWith('completions') ? events.at(-3) : path.endsWith('messages') ? events.at(-2) : events.at(-1).response).billing.mode, 'exact_ceiling');
  assert.equal(numbersBody(app.locals.healthStats).agent_traffic.total.calls, 1);
});

function withoutBuyerCost(path) {
  return upstreamFrames(path, false).map((frame) => frame.replace(/,\s*"buyer_cost_micro"\s*:\s*\d+/, ''));
}

for (const path of ['/v1/messages', '/v1/responses']) test(`exact ${path} live SSE settles the ceiling when Surplus omits buyer_cost_micro`, async t => {
  const { url, facilitator } = await serve(t, { upstream: null, fetchImpl: async () => sseResponse(withoutBuyerCost(path)) });
  const body = { ...QUESTION, model: 'cheap-model', stream: true, ...(path.endsWith('responses') ? { input: 'test', max_output_tokens: 300 } : {}) };
  const challenge = await url(body, {}, path);
  assert.equal(challenge.status, 402);
  let settled = 0;
  const settle = facilitator.settle.bind(facilitator);
  facilitator.settle = async (...args) => { settled++; return settle(...args); };
  const res = await url(body, { 'payment-signature': signature(decode(challenge.headers.get('payment-required')), BASE, 'exact') }, path);
  assert.equal(res.status, 200, await res.clone().text());
  const text = await res.text(), events = frames(text);
  assert.equal(settled, 1);
  const billing = path.endsWith('messages') ? events.at(-2).billing : events.at(-1).response.billing;
  assert.equal(billing.mode, 'exact_ceiling');
  assert.ok(billing.totalAtomic);
  assert.match(text, path.endsWith('messages') ? /event: content_block_delta/ : /response\.output_text\.delta/);
});

for (const path of ['/v1/messages', '/v1/responses']) test(`upto ${path} live SSE does not settle when Surplus omits buyer_cost_micro`, async t => {
  const { url, facilitator } = await serve(t, { upstream: null, fetchImpl: async () => sseResponse(withoutBuyerCost(path)) });
  const body = { ...QUESTION, model: 'cheap-model', stream: true, ...(path.endsWith('responses') ? { input: 'test', max_output_tokens: 300 } : {}) };
  const challenge = await url(body, {}, path);
  assert.equal(challenge.status, 402);
  let settled = 0;
  const settle = facilitator.settle.bind(facilitator);
  facilitator.settle = async (...args) => { settled++; return settle(...args); };
  const res = await url(body, { 'payment-signature': signature(decode(challenge.headers.get('payment-required')), BASE, 'upto') }, path);
  const text = await res.text();
  assert.equal(settled, 0);
  assert.equal(res.status === 200 && /billing/.test(text), false);
});

// Wire log of one request: when each piece of the response reached the socket.
function watchWire(app) {
  const wire = [];
  app.locals.testOnWire = chunk => wire.push({ at: performance.now(), chunk });
  return { wire, first: pattern => wire.find(w => pattern.test(w.chunk)) };
}
const streamBody = (path, extra = {}) => ({ ...QUESTION, model: 'cheap-model', stream: true, ...(path.endsWith('responses') ? { input: 'test', max_output_tokens: 300 } : {}), ...extra });
async function paidStream(t, path, { network = BASE, scheme = 'upto', body = streamBody(path), headers = {}, ...options } = {}) {
  const ctx = await serve(t, { upstream: null, ...options });
  const challenge = await ctx.url(body, {}, path);
  assert.equal(challenge.status, 402);
  const events = [];
  const settle = ctx.facilitator.settle.bind(ctx.facilitator);
  ctx.facilitator.settle = async (...args) => { events.push({ at: performance.now(), what: 'settle', amount: args[1].amount, deposit: args[0].payload.type === 'deposit' }); return settle(...args); };
  const send = () => ctx.url(body, { 'payment-signature': signature(decode(challenge.headers.get('payment-required')), network, scheme), ...headers }, path);
  return { ...ctx, events, send, wire: watchWire(ctx.app) };
}

for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) test(`${path} first token reaches the client before the upstream stream finishes`, async t => {
  // The model speaks, thinks for 150 ms, then finishes; the last frame is produced after the client has the first.
  let produced = {};
  const frames = upstreamFrames(path, false);
  const firstContent = frames.findIndex(f => /ans|answer/.test(f));
  const steps = frames.flatMap((f, i) => i === firstContent ? [f, 150] : [f]);
  const { send, events, wire, app } = await paidStream(t, path, { fetchImpl: async () => sseResponse(steps, { onFrame: (i) => { if (i === steps.length - 1) produced.last = performance.now(); } }) });
  const res = await send();
  assert.equal(res.status, 200);
  const text = await res.text();
  const firstData = wire.first(/ans|answer/);
  assert.ok(firstData, 'first content on the wire');
  assert.ok(produced.last, 'the mock produced its last frame');
  assert.ok(firstData.at < produced.last - 100, `first token ${(produced.last - firstData.at).toFixed(0)} ms before the last upstream frame`);
  const settleAt = events.find(e => e.what === 'settle').at;
  assert.ok(firstData.at < settleAt, 'tokens leave before settlement');
  const billing = wire.first(/billing/);
  assert.ok(billing.at >= settleAt, 'the billing event is released after settlement');
  assert.match(text, /billing/);
  assert.equal(numbersBody(app.locals.healthStats).agent_traffic.total.calls, 1);
});

test('keepalive comments flow while the model is silent and are not data', async t => {
  const path = '/v1/chat/completions';
  const frames = upstreamFrames(path, false);
  const { send, wire } = await paidStream(t, path, { config: { ...CONFIG, streamKeepaliveMs: 30 }, fetchImpl: async () => sseResponse([250, ...frames]) });
  const res = await send();
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok((text.match(/: keepalive/g) ?? []).length >= 2, text);
  assert.ok(text.indexOf(': keepalive') < text.indexOf('data: '), 'keepalives lead the data');
  assert.equal(frames_(text).filter(e => e !== '[DONE]').every(e => e.id?.startsWith('singit-ask-')), true);
  assert.ok(wire.first(/: keepalive/).at < wire.first(/data: /).at);
});
const frames_ = text => text.split('\n\n').filter(f => f.includes('data: ')).map(f => { const d = f.split('\n').find(l => l.startsWith('data: ')).slice(6); return d === '[DONE]' ? d : JSON.parse(d); });

test('a model that fails before its first token leaves a JSON error and no charge, fallback runs once', async t => {
  const catalogue = { async list() { return []; }, async resolve(id) { return { id, promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 }; }, async canAnswer() { return true; } };
  const models = [];
  const path = '/v1/chat/completions';
  const { send, facilitator } = await paidStream(t, path, { catalogue, body: streamBody(path, { model: 'pin', fallback_models: ['alt'] }), fetchImpl: async (_url, options) => {
    const model = JSON.parse(options.body).model; models.push(model);
    return model === 'pin' ? Response.json({ error: { code: 'upstream_unavailable' } }, { status: 503 }) : sseResponse(upstreamFrames(path, false)); } });
  const res = await send();
  assert.equal(res.status, 200); assert.deepEqual(models, ['pin', 'alt']);
  assert.equal(res.headers.get('x-singit-model'), 'alt'); assert.equal(res.headers.get('x-singit-fallback-from'), 'pin'); assert.equal(res.headers.get('x-singit-fallback-policy'), 'paid');
  assert.equal(frames_(await res.text()).at(-1), '[DONE]');
  assert.equal(facilitator.calls.settle.length, 1);
  // A stream that ends before any token is the same failure: JSON, nothing charged, then the alternate.
  const empty = await paidStream(t, path, { catalogue, body: streamBody(path, { model: 'pin', fallback_models: ['alt'] }), fetchImpl: async (_url, options) => JSON.parse(options.body).model === 'pin' ? sseResponse([sse({ id: 'x', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })]) : Response.json({ error: { code: 'upstream_unavailable' } }, { status: 503 }) });
  const failed = await empty.send();
  assert.equal(failed.status, 503); assert.match(failed.headers.get('content-type'), /application\/json/); assert.equal((await failed.json()).error.code, 'no_billable_answer');
  assert.ok(empty.facilitator.calls.settle.every(amount => BigInt(amount) === 0n));
});

// Solana exact: the fallback reserve (solana-exact-window.mjs) cuts a slow first model only until the client has data.
function reserveClock() {
  const t0 = Date.now(), timers = new Map();
  let id = 0;
  return { timers, now: () => t0, setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: n => timers.delete(n),
    // Fires the reserve timer (the shorter one); the window's own cutoff timer is left alone.
    fireAll() { for (const [n, t] of [...timers]) { timers.delete(n); t.fn(); } },
    fireReserve() { const [n, t] = [...timers].sort((a, b) => a[1].ms - b[1].ms)[0]; timers.delete(n); t.fn(); } };
}
const waitFor = async condition => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(condition(), 'condition reached'); };
const altCatalogue = { async list() { return []; }, async resolve(id) { return { id, promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 }; }, async canAnswer() { return true; } };
const stalled = (frames, gate) => new Response(new ReadableStream({ async start(c) { const enc = new TextEncoder(); for (const f of frames) c.enqueue(enc.encode(f)); await gate; } , }), { headers: { 'content-type': 'text/event-stream' } });

test('solana exact: the fallback reserve cuts a first model that has sent nothing, but not one that has sent data', async t => {
  const path = '/v1/chat/completions', frames = upstreamFrames(path, false);
  for (const sendsData of [false, true]) {
    const clock = reserveClock(), models = [];
    let open;
    const gate = new Promise(r => { open = r; });
    const ctx = await paidStream(t, path, { network: SOLANA, scheme: 'exact', catalogue: altCatalogue, clock, body: streamBody(path, { model: 'pin', fallback_models: ['alt'] }),
      fetchImpl: async (_url, options) => {
        const model = JSON.parse(options.body).model; models.push(model);
        if (model === 'alt') return sseResponse(frames);
        // The first model: either silent, or it has sent a token and stalls with the rest of the answer still to come.
        return sendsData ? new Response(new ReadableStream({ async start(c) { const enc = new TextEncoder(); for (const f of frames.slice(0, 2)) c.enqueue(enc.encode(f)); await gate; for (const f of frames.slice(2)) c.enqueue(enc.encode(f)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } })
          : new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))); } });
    const pending = ctx.send();
    if (sendsData) await waitFor(() => ctx.wire.first(/ans/));
    else await waitFor(() => clock.timers.size >= 2);
    clock.fireReserve();
    if (sendsData) { await new Promise(r => setTimeout(r, 30)); open(); }
    const res = await pending, text = await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(models, sendsData ? ['pin'] : ['pin', 'alt'], sendsData ? 'a model with data on the wire is not cut for a fallback' : 'a silent model is cut for the reserve');
    assert.equal(frames_(text).at(-1), '[DONE]');
  }
});

test('solana exact: a stream still running at the window cutoff is cut after its first token and not charged', async t => {
  const path = '/v1/chat/completions', frames = upstreamFrames(path, false), clock = reserveClock();
  const ctx = await paidStream(t, path, { network: SOLANA, scheme: 'exact', clock, fetchImpl: async () => new Response(new ReadableStream({ async start(c) {
    const enc = new TextEncoder(); for (const f of frames.slice(0, 2)) c.enqueue(enc.encode(f)); await new Promise(() => {}); } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const pending = ctx.send();
  await waitFor(() => ctx.wire.first(/ans/));
  clock.fireAll();
  const res = await pending, text = await res.text();
  assert.equal(res.status, 200); assert.match(text, /ans/); assert.ok(!/billing|\[DONE\]|"error"/.test(text), text);
  assert.equal(ctx.events.length, 0, 'an exact payment that never completed is never settled');
});

for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) for (const [network, scheme] of [[BASE, 'upto'], [SOLANA, 'upto'], [BASE, 'exact']]) test(`${network} ${scheme} ${path} a stream that breaks after its first token ends without a fallback or a charge`, async t => {
  const catalogue = { async list() { return []; }, async resolve(id) { return { id, promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 }; }, async canAnswer() { return true; } };
  const models = [];
  const frames = upstreamFrames(path, false);
  const cut = frames.findIndex(f => /ans|answer/.test(f)) + 1;
  const body = streamBody(path, path.endsWith('completions') ? { model: 'pin', fallback_models: ['alt'] } : {});
  const { send, events, wire, app } = await paidStream(t, path, { network, scheme, catalogue, body, fetchImpl: async (_url, options) => { models.push(JSON.parse(options.body).model);
    // The connection resets 20 ms after the first token.
    return new Response(new ReadableStream({ async start(c) { const enc = new TextEncoder(); for (const f of frames.slice(0, cut)) c.enqueue(enc.encode(f)); await new Promise(r => setTimeout(r, 20)); c.error(new Error('reset')); } }), { headers: { 'content-type': 'text/event-stream' } }); } });
  const res = await send();
  const text = await res.text();
  assert.equal(models.length, 1, 'no second model');
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.match(text, /ans|answer/); assert.ok(!/billing|\[DONE\]|message_stop|response\.completed|"error"/.test(text), text);
  // Only the Solana escrow deposit moves money, and the cancellation settles it for nothing.
  assert.ok(events.filter(e => !e.deposit).every(e => BigInt(e.amount) === 0n), `no charge: ${JSON.stringify(events)}`);
  assert.equal(numbersBody(app.locals.healthStats).agent_traffic.total.calls, 0);
});

for (const network of [BASE, SOLANA]) for (const scheme of ['upto', 'exact']) for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) test(`${network} ${scheme} ${path} failures stay JSON`, async t => {
  for (const failUpstream of [false, true]) {
    const answer = path.endsWith('messages') ? { id: 'msg', type: 'message', content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn', usage: { buyer_cost_micro: 1 } } : { id: 'resp', object: 'response', output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }], usage: { buyer_cost_micro: 1 } };
    const { url, facilitator, app } = await serve(t, { upstream: failUpstream ? async () => { throw new UpstreamError('fake'); } : async () => ({ content: 'answer', finishReason: 'stop', usage: { buyer_cost_micro: 1 } }), fetchImpl: async () => failUpstream ? Response.json({ error: { code: 'fake' } }, { status: 500 }) : Response.json(answer) });
    const settlementAmounts = [];
    const settle = facilitator.settle.bind(facilitator);
    facilitator.settle = async (payload, requirements) => {
      assert.equal(app.locals.testWireBytes, 0);
      if (payload.payload.type === 'deposit') return settle(payload, requirements);
      settlementAmounts.push(requirements.amount);
      if (failUpstream) return settle(payload, requirements);
      return { success: false, errorReason: 'fake_refusal', network };
    };
    const body = { ...QUESTION, model: 'cheap-model', stream: true, ...(path.endsWith('responses') ? { input: 'test' } : {}) };
    const challenge = await url(body, {}, path);
    const res = await url(body, { 'payment-signature': signature(decode(challenge.headers.get('payment-required')), network, scheme) }, path);
    assert.ok(res.status >= 400); assert.match(res.headers.get('content-type'), /application\/json/); assert.ok(!(await res.text()).includes('data: '));
    if (failUpstream) assert.ok(settlementAmounts.every(amount => BigInt(amount) === 0n), 'only a zero-charge Solana cancellation may settle');
    assert.equal(numbersBody(app.locals.healthStats).agent_traffic.total.calls, 0);
  }
});
test('free chat streams live from the model and ends with the free billing', async t => {
  const path = '/v1/chat/completions';
  const frames = upstreamFrames(path, false);
  const steps = frames.flatMap((f, i) => i === 1 ? [f, 120] : [f]);
  let last;
  const { url, app } = await serve(t, { upstream: null, config: { ...CONFIG, freeModels: ['cheap-model'] }, fetchImpl: async () => sseResponse(steps, { onFrame: i => { if (i === steps.length - 1) last = performance.now(); } }) });
  const wire = watchWire(app);
  const res = await url({ ...QUESTION, model: 'free/cheap-model', stream: true });
  assert.equal(res.status, 200); assert.equal(res.headers.get('x-singit-free'), 'true');
  const events = frames_(await res.text());
  assert.equal(events.at(-1), '[DONE]'); assert.equal(events.at(-2).billing.free, true);
  assert.ok(wire.first(/ans/).at < last - 80, 'first free token before the model finished');
});

test('free SSE and invalid stream options', async t => {
  const { url } = await serve(t, { config: { ...CONFIG, freeModels: ['cheap-model'] } });
  const body = { ...QUESTION, model: 'free/cheap-model', stream: true };
  const res = await url(body); assert.equal(res.status, 200); assert.equal(frames(await res.text()).at(-1), '[DONE]'); assert.equal(res.headers.get('payment-response'), null);
  for (const options of [null, [], { unknown: true }, { include_usage: 1 }]) { const r = await url({ ...body, stream_options: options }); assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'invalid_request'); }
  const r = await url({ ...body, stream: false, stream_options: {} }); assert.equal(r.status, 400);
});
test('traffic fixed sources, windows, persistence, old and invalid files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-traffic-')), file = join(dir, 'stats.json');
  try {
    let now = Date.now(); const stats = new HealthStats({ file, now: () => now });
    const req = (ua, client) => ({ get: k => k === 'x-singit-client' ? client : ua, body: { stream: true, tools, messages: [{ content: [{ type: 'image_url' }] }] } });
    for (const [ua, label] of [['openai-python/1.0', 'openai-python'], ['openai-node/6', 'openai-node'], ['curl/8', 'curl'], ['Mozilla/5.0', 'browser'], ['private secret', 'other']]) { assert.equal(clientSource(req(ua)), label); stats.recordAgent(req(ua)); }
    assert.equal(clientSource(req('curl/8', 'BAD secret')), 'other'); assert.equal(clientSource(req('curl/8', 'cursor')), 'cursor');
    assert.equal(clientSource(req('curl/8', 'singit-proxy/0.1.0')), 'singit-proxy'); assert.equal(clientSource(req('curl/8', 'singit-mcp')), 'singit-mcp');
    assert.equal(clientSource(req('curl/8', 'codex')), 'codex');
    stats.flush(); assert.ok(!readFileSync(file, 'utf8').includes('private secret'));
    const loaded = new HealthStats({ file, now: () => now }); assert.equal(numbersBody(loaded).agent_traffic.total.with_images, 5);
    now += 8 * 86400000; assert.equal(numbersBody(loaded).agent_traffic.last_7d.calls, 0);
    const state = JSON.parse(readFileSync(file)); delete state.agent_traffic; for (const b of Object.values(state.buckets)) delete b.agent_traffic;
    writeFileSync(file, JSON.stringify(state)); assert.equal(numbersBody(new HealthStats({ file })).agent_traffic.total.calls, 0);
    state.agent_traffic = { calls: -1 }; writeFileSync(file, JSON.stringify(state)); assert.notEqual(new HealthStats({ file }).state.salt, state.salt);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('per-model SSE uses agent limits; chat usage is opt-in', async t => {
  const id = 'deepseek-v4.1-flash';
  const catalogue = { async list() { return []; }, async resolve() { return { id, promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 }; }, async canAnswer() { return true; } };
  const { url, asked } = await serve(t, { catalogue });
  for (const path of ['/v1/chat/completions', `/v1/chat/${id}`]) {
    const body = { ...QUESTION, stream: true, max_tokens: 8000 };
    const quote = await url(body, {}, path);
    const res = await url(body, { 'payment-signature': signature(decode(quote.headers.get('payment-required')), BASE, 'upto') }, path);
    assert.equal(res.status, 200); const events = frames(await res.text());
    assert.equal(events.length, 3); assert.equal(events.at(-1), '[DONE]'); assert.ok(events[1].billing);
    assert.equal(asked.at(-1).maxTokens, 8000);
  }
});

test('fallback model headers survive SSE', async t => {
  const catalogue = { async list() { return []; }, async resolve(id) { return { id, promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 }; }, async canAnswer(id) { return id !== 'pin'; } };
  const { url } = await serve(t, { catalogue });
  const body = { ...QUESTION, model: 'pin', fallback_models: ['fallback'], stream: true };
  const quote = await url(body);
  const res = await url(body, { 'payment-signature': signature(decode(quote.headers.get('payment-required')), BASE, 'upto') });
  assert.equal(res.status, 200); assert.equal(res.headers.get('x-singit-model'), 'fallback'); assert.equal(res.headers.get('x-singit-fallback-from'), 'pin'); assert.equal(res.headers.get('x-singit-fallback-policy'), 'request');
});

test('served agent tools/images/stream and source appear in numbers.json; auto headers survive', async t => {
  const catalogue = { async list() { return []; }, async resolve(id) { return { id, promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 }; }, async canAnswer() { return true; } };
  const { url } = await serve(t, { catalogue, upstream: async () => ({ content: 'answer', finishReason: 'stop', usage: { buyer_cost_micro: 1 } }) });
  const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'https://fake.invalid/image.png' } }] }], tools, stream: true };
  const quote = await url(body);
  const res = await url(body, { 'payment-signature': signature(decode(quote.headers.get('payment-required')), BASE, 'upto'), 'user-agent': 'OpenAI/Python 3.45 private-marker' });
  assert.equal(res.status, 200);
  const numbers = await (await url({}, {}, '/numbers.json')).json();
  assert.equal(numbers.agent_traffic.total.calls, 1); assert.equal(numbers.agent_traffic.total.with_tools, 1); assert.equal(numbers.agent_traffic.total.with_images, 1); assert.equal(numbers.agent_traffic.total.with_stream, 1); assert.equal(numbers.agent_traffic.total.by_source['openai-python'], 1); assert.ok(!JSON.stringify(numbers).includes('private-marker'));
  const auto = { ...QUESTION, model: 'singit/auto', stream: true };
  const autoQuote = await url(auto);
  const autoRes = await url(auto, { 'payment-signature': signature(decode(autoQuote.headers.get('payment-required')), BASE, 'upto') });
  assert.equal(autoRes.status, 200); assert.ok(autoRes.headers.get('x-singit-model')); assert.ok(autoRes.headers.get('x-singit-tier'));
});

test('invalid stream options on paid APIs never verify, settle or ask upstream', async t => {
  const { url, facilitator, asked, app } = await serve(t);
  for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) {
    for (const options of [null, [], { unknown: true }, { include_usage: 'yes' }]) {
      const res = await url({ ...QUESTION, model: 'cheap-model', input: 'test', stream: true, stream_options: options }, {}, path);
      assert.equal(res.status, 400); const data = await res.json(); assert.equal(data.error.code, 'invalid_request');
    }
  }
  assert.equal(facilitator.calls.verify, 0); assert.deepEqual(facilitator.calls.settle, []); assert.deepEqual(asked, []); assert.equal(numbersBody(app.locals.healthStats).agent_traffic.total.calls, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, CONFIG, QUESTION, decode } from './helpers/agent-app.mjs';
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
for (const network of [BASE, SOLANA]) for (const scheme of ['upto', 'exact']) for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) for (const tool of [false, true]) test(`${network} ${scheme} ${path} buffered ${tool ? 'tools' : 'text'}`, async t => {
  let upstreamCalls = 0;
  const answer = path === '/v1/messages' ? { id: 'msg_test', type: 'message', role: 'assistant', model: 'cheap-model', content: [tool ? { type: 'tool_use', id: 'call_test', name: 'lookup', input: { q: 'test' } } : { type: 'text', text: 'answer' }], stop_reason: tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 2, buyer_cost_micro: 1 } }
    : { id: 'resp_test', object: 'response', status: 'completed', model: 'cheap-model', output: [tool ? { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'lookup', arguments: '{"q":"test"}', status: 'completed' } : { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 2, buyer_cost_micro: 1 } };
  const { url, facilitator, app } = await serve(t, { upstream: async () => { upstreamCalls++; return { content: tool ? null : 'answer', ...(tool ? { message: { role: 'assistant', content: null, tool_calls: toolCalls }, toolCalls } : {}), finishReason: tool ? 'tool_calls' : 'stop', usage: { buyer_cost_micro: 1, total_tokens: 3 } }; }, fetchImpl: async (_url, options) => { upstreamCalls++; assert.equal(JSON.parse(options.body).stream, false); return Response.json(answer); } });
  const body = { ...QUESTION, model: 'cheap-model', stream: true, ...(tool ? { tools } : {}), ...(path.endsWith('responses') ? { input: 'test', max_output_tokens: 300 } : {}), ...(path.endsWith('completions') ? { stream_options: { include_usage: true } } : {}) };
  const challenge = await url(body, {}, path);
  assert.equal(challenge.status, 402);
  let settled = false;
  const settle = facilitator.settle.bind(facilitator);
  facilitator.settle = async (...args) => { assert.equal(app.locals.testWireBytes, 0, 'no response bytes before settlement'); await Promise.resolve(); settled = true; return settle(...args); };
  const res = await url(body, { 'payment-signature': signature(decode(challenge.headers.get('payment-required')), network, scheme), 'user-agent': 'OpenAI/Python secret' }, path);
  assert.equal(res.status, 200, await res.clone().text()); assert.equal(settled, true); assert.ok(res.headers.get('payment-response')); assert.match(res.headers.get('content-type'), /text\/event-stream/); assert.equal(res.headers.get('cache-control'), 'no-cache');
  const text = await res.text(), events = frames(text);
  assert.equal(upstreamCalls, 1);
  if (path.endsWith('completions')) { assert.equal(events.at(-1), '[DONE]'); assert.deepEqual(events.at(-2).choices, []); assert.ok(events.at(-3).billing); assert.equal(events[0].choices[0].delta.role, 'assistant'); if (tool) assert.equal(events[0].choices[0].delta.tool_calls[0].index, 0); }
  else if (path.endsWith('messages')) { assert.equal(events[0].type, 'message_start'); assert.equal(events.at(-1).type, 'message_stop'); assert.ok(events.at(-2).billing); assert.match(text, /event: content_block_delta/); }
  else { assert.equal(events[0].type, 'response.created'); assert.equal(events.at(-1).type, 'response.completed'); assert.ok(events.at(-1).response.billing); assert.ok(!text.includes('[DONE]')); }
  assert.equal(numbersBody(app.locals.healthStats).agent_traffic.total.calls, 1);
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
    stats.flush(); assert.ok(!readFileSync(file, 'utf8').includes('private secret'));
    const loaded = new HealthStats({ file, now: () => now }); assert.equal(numbersBody(loaded).agent_traffic.total.with_images, 5);
    now += 8 * 86400000; assert.equal(numbersBody(loaded).agent_traffic.last_7d.calls, 0);
    const state = JSON.parse(readFileSync(file)); delete state.agent_traffic; for (const b of Object.values(state.buckets)) delete b.agent_traffic;
    writeFileSync(file, JSON.stringify(state)); assert.equal(numbersBody(new HealthStats({ file })).agent_traffic.total.calls, 0);
    state.agent_traffic = { calls: -1 }; writeFileSync(file, JSON.stringify(state)); assert.notEqual(new HealthStats({ file }).state.salt, state.salt);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('per-model SSE retains legacy limits; chat usage is opt-in', async t => {
  const id = 'deepseek-v4.1-flash';
  const catalogue = { async list() { return []; }, async resolve() { return { id, promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 }; }, async canAnswer() { return true; } };
  const { url, asked } = await serve(t, { catalogue });
  for (const path of ['/v1/chat/completions', `/v1/chat/${id}`]) {
    const body = { ...QUESTION, stream: true, max_tokens: 8000 };
    const quote = await url(body, {}, path);
    const res = await url(body, { 'payment-signature': signature(decode(quote.headers.get('payment-required')), BASE, 'upto') }, path);
    assert.equal(res.status, 200); const events = frames(await res.text());
    assert.equal(events.length, 3); assert.equal(events.at(-1), '[DONE]'); assert.ok(events[1].billing);
    assert.equal(asked.at(-1).maxTokens, path === '/v1/chat/completions' ? 8000 : 1200);
  }
});

test('fallback model headers survive buffered SSE', async t => {
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

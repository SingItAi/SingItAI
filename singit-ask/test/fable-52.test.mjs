import { test } from 'node:test';
import assert from 'node:assert/strict';
import { surplusModel, fitRequest, readFormatRequest, withHeadroom } from '../src/formats.mjs';
import { forcedToolError } from '../src/model-policy.mjs';
import { askSurplus } from '../src/app.mjs';
import { parseModels, UnknownModel } from '../src/catalogue.mjs';
import { ceilingAtomic, worstModelCostMicro, TERMS } from '../src/pricing.mjs';
import { serve, request } from './fixtures/listing-harness.mjs';
import { serve as agentServe, CONFIG } from './helpers/agent-app.mjs';
// Assumed Surplus dotted id, mirroring 5.1; update if Surplus chooses another spelling.
const id = 'claude-fable-5.2';
const params = ['max_tokens', 'reasoning', 'reasoning_effort', 'tools', 'temperature', 'top_p', 'top_k', 'tool_choice'];
const models = parseModels({ data: [{ id, pricing: { prompt: '0.000008', completion: '0.000040' }, context_length: 1e6,
  architecture: { modality: 'text+image->text' }, supported_features: ['reasoning', 'tools', 'vision'], supported_parameters: params }] });
const info = models.get(id);
const messages = [{ role: 'user', content: 'hi' }];
const cat = present => ({ async resolve(name) { if (!present || name !== id) throw new UnknownModel('That model is not available.'); return info; },
  async list() { return present ? [info] : []; }, async canAnswer() { return true; }, async listable() { return true; } });
test('Fable 5.2 ids, hard sampling restrictions, forced tools and headroom', async () => {
  for (const name of ['claude-fable-5-2', 'claude-fable-5-2-20261109']) assert.equal(surplusModel(name), id);
  for (const advertised of [undefined, params, ['max_tokens', 'reasoning']]) {
    const fitted = fitRequest({ model: id, temperature: 1, top_p: 1, top_k: 1 }, advertised);
    for (const knob of ['temperature', 'top_p', 'top_k']) assert.ok(!(knob in fitted));
    let sent;
    await askSurplus(CONFIG, messages, 16, async (_url, init) => { sent = JSON.parse(init.body); return Response.json({ choices: [{ message: { content: 'hi' } }], usage: {} }); }, id, { params: advertised });
    for (const knob of ['temperature', 'top_p', 'top_k']) assert.ok(!(knob in sent));
    assert.equal(sent.reasoning_effort ?? sent.reasoning?.effort, 'low');
    assert.equal(sent.max_tokens, 272);
  }
  for (const choice of ['required', 'any', { type: 'any' }, { type: 'tool', name: 'lookup' }, { type: 'function', function: { name: 'lookup' } }]) {
    assert.equal(forcedToolError(id, choice).status, 400);
    for (const route of ['/v1/messages', '/v1/responses']) assert.throws(() => readFormatRequest(route, { model: 'claude-fable-5-2', messages, input: 'hi', max_tokens: 16, tool_choice: choice }), /forced tool use/);
  }
  for (const choice of [undefined, 'auto', 'none', { type: 'auto' }, { type: 'none' }]) assert.equal(forcedToolError(id, choice), null);
  assert.equal(withHeadroom({ model: id, max_tokens: 16 }).max_tokens, 272);
  const size = { chars: 2, messageCount: 1, maxTokens: 16 };
  const cost = worstModelCostMicro(info, size);
  assert.equal(ceilingAtomic(info, size, TERMS), String(Math.max(Number(TERMS.minChargeAtomic ?? 0), cost + Math.ceil(cost * TERMS.markupBps / 10000) + Number(TERMS.settlementFeeAtomic))));
});
for (const present of [false, true]) test(`Fable listing follows live catalog: ${present}`, async t => {
  const { url, facilitator } = await serve(t, cat(present));
  const list = await (await request(url + '/v1/models')).json();
  assert.equal(list.data.some(m => m.id === id), present);
  assert.equal((await request(url + '/v1/models/' + id)).status, present ? 200 : 404);
  for (const path of ['/openapi.json', '/.well-known/x402']) assert.ok(!(await (await request(url + path)).text()).includes('/v1/chat/' + id));
  if (!present) assert.equal((await request(url + '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: id, messages, max_tokens: 16 }), headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal(facilitator.calls.verify, 0); assert.deepEqual(facilitator.calls.settle, []);
});
test('Fable forced tools rejected before chat and Messages payment; auto quotes', async t => {
  const { url, facilitator } = await agentServe(t, { catalogue: cat(true) });
  const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
  for (const choice of ['required', { type: 'function', function: { name: 'lookup' } }]) {
    const res = await url({ model: id, messages, tools, tool_choice: choice, max_tokens: 16 }, {}, '/v1/chat/completions');
    assert.equal(res.status, 400); assert.match(await res.text(), /forced tool use/);
  }
  for (const choice of [{ type: 'any' }, { type: 'tool', name: 'lookup' }]) assert.equal((await url({ model: 'claude-fable-5-2', messages, max_tokens: 16, tool_choice: choice }, {}, '/v1/messages')).status, 400);
  assert.equal((await url({ model: id, messages, tools, tool_choice: 'auto', max_tokens: 16 }, {}, '/v1/chat/completions')).status, 402);
  assert.equal(facilitator.calls.verify, 0); assert.deepEqual(facilitator.calls.settle, []);
});

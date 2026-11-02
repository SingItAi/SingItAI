import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askSurplus } from '../src/app.mjs';
import { retryBudget } from '../src/pricing.mjs';
import { billWithDiagnostics } from '../src/metered.mjs';
const config = { surplusUrl: 'https://unused.invalid' };
const exhausted = () => new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: { buyer_cost_micro: 5000 } }));
test('retry once, preserving parameters and discount, clamping billing to the signed ceiling', async () => {
  for (const maxTokens of [32, 3000]) {
    const calls = [];
    const answer = await askSurplus(config, [], maxTokens, async (_url, init) => {
      calls.push({ body: JSON.parse(init.body), headers: init.headers });
      return calls.length === 1 ? exhausted() : success();
    }, 'tagged', { retryOnReasoning: true, info: { tags: ['reasoning'] }, params: ['reasoning'], minDiscount: 30 });
    assert.equal(answer.retried, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.max_tokens, retryBudget(calls[0].body.max_tokens));
    assert.ok(calls[1].body.max_tokens <= 2 * calls[0].body.max_tokens);
    assert.ok(calls[1].body.max_tokens <= calls[0].body.max_tokens + 2048);
    assert.deepEqual(calls[1].body.reasoning, calls[0].body.reasoning);
    assert.deepEqual(calls[1].headers, calls[0].headers);
    const logs = [];
    const bill = billWithDiagnostics(answer.usage, { markupBps: 3000, settlementFeeAtomic: '1000', maxChargeAtomic: '1500' }, false, '/test', 'tagged', line => logs.push(line), answer.retried);
    assert.equal(bill.totalAtomic, '1500'); assert.equal(bill.overrunAtomic, '6000');
    assert.match(logs[0], /reasoning retry overrun/);
  }
});
test('second exhaustion carries retried and cannot produce a billable answer', async () => {
  let calls = 0;
  await assert.rejects(askSurplus(config, [], 32, async () => { calls++; return exhausted(); }, 'tagged', { retryOnReasoning: true }),
    e => e.code === 'max_tokens_spent_reasoning' && e.retried === true);
  assert.equal(calls, 2);
});
test('no retry when disabled, under eight seconds remain, or a different failure occurs', async () => {
  for (const options of [{}, { retryOnReasoning: false }, { retryOnReasoning: true, deadline: Date.now() + 7000 }]) {
    let calls = 0;
    await assert.rejects(askSurplus(config, [], 32, async () => { calls++; return exhausted(); }, 'tagged', options), { code: 'max_tokens_spent_reasoning' });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(askSurplus(config, [], 32, async () => { calls++; return new Response('{}', { status: 503 }); }, 'tagged', { retryOnReasoning: true }));
  assert.equal(calls, 1);
});

import { fixture, response, invoke, exhaustedFormat, answeredFormat } from './helpers/reasoning-routes.mjs';
import { FORMAT_LIMITS } from '../src/formats.mjs';
import { addFreeRoute } from '../src/free.mjs';
for (const route of ['/v1/messages', '/v1/responses']) {
  test(`${route}: retry success is delivered with a clamped upto bill`, async () => {
    const bodies = [];
    const { app, info } = fixture(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(bodies.length === 1 ? exhaustedFormat(route) : answeredFormat(route)));
    });
    const res = await invoke(app, info, route);
    assert.equal(res.statusCode, 200); assert.equal(res.body.retried, true);
    assert.equal(res.body.billing.totalAtomic, '1500'); assert.equal(res.body.billing.overrunAtomic, '6000');
    const field = route === '/v1/messages' ? 'max_tokens' : 'max_output_tokens';
    assert.equal(bodies[0][field], 288); assert.equal(bodies[1][field], 576);
  });
  test(`${route}: second exhaustion returns 422 with no settlement override`, async () => {
    let calls = 0;
    const { app, info } = fixture(async () => { calls++; return new Response(JSON.stringify(exhaustedFormat(route))); });
    const res = await invoke(app, info, route);
    assert.equal(calls, 2); assert.equal(res.statusCode, 422);
    assert.equal(res.headers['settlement-overrides'], undefined);
  });
  test(`${route}: other failures are never retried`, async () => {
    let calls = 0;
    const { app, info } = fixture(async () => { calls++; return new Response('{}', { status: 503 }); });
    assert.equal((await invoke(app, info, route)).statusCode, 503);
    assert.equal(calls, 1);
  });
}
test('paid chat retries and clamps upto; second exhaustion does not authorize settlement', async () => {
  let calls = 0;
  const { app, info } = fixture(async () => ++calls === 1 ? exhausted() : success());
  const res = await invoke(app, info, '/v1/chat/completions');
  assert.equal(calls, 2); assert.equal(res.statusCode, 200);
  assert.equal(res.body.billing.totalAtomic, '1500'); assert.equal(res.body.billing.overrunAtomic, '6000');
  const failed = fixture(async () => exhausted());
  const bad = await invoke(failed.app, failed.info, '/v1/chat/completions');
  assert.equal(bad.statusCode, 422); assert.equal(bad.headers['settlement-overrides'], undefined);
});
test('free route passes catalogue info and explicitly disables retries', async () => {
  let handler, calls = 0;
  const info = { id: 'tagged', tags: ['reasoning'], promptUsdPerToken: 0, completionUsdPerToken: 0.000001 };
  addFreeRoute({ post(_route, fn) { handler = fn; } }, '/free', {
    config, terms: { models: ['tagged'], chars: 100, maxTokens: 32, budgetUsdPerDay: 1 },
    allowance: { take: () => ({ ok: true }), giveBack() {}, done() {} },
    readRequest: () => ({ messages: [], maxTokens: 32, chars: 0 }), RequestError: Error,
    catalogue: { resolve: async () => info }, log() {},
    upstream: async (...args) => {
      assert.equal(args[5].retryOnReasoning, false); assert.equal(args[5].info, info);
      return askSurplus(...args);
    }, fetchImpl: async () => { calls++; return exhausted(); },
  });
  const res = response();
  await handler({ body: { model: 'free/tagged' }, get() {}, ip: '127.0.0.1' }, res, () => {});
  assert.equal(res.statusCode, 422); assert.equal(calls, 1);
});

for (const route of ['/v1/messages', '/v1/responses']) {
  test(`${route}: under eight seconds left means no retry`, async t => {
    let now = Date.now(), calls = 0;
    t.mock.method(Date, 'now', () => now);
    const { app, info } = fixture(async () => {
      calls++; now += FORMAT_LIMITS.timeoutMs - 7000;
      return new Response(JSON.stringify(exhaustedFormat(route)));
    });
    const res = await invoke(app, info, route);
    assert.equal(calls, 1); assert.equal(res.statusCode, 422);
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FreeAllowance, freeTerms, DEFAULT_FREE_MODELS, freeAnswerCost } from '../src/free.mjs';
import { reasoningHeadroom, worstModelCostMicro } from '../src/pricing.mjs';
import { ERROR_CODES } from '../src/errors.mjs';

test('six default models, default cap, overrides and disabled cap', () => {
  assert.deepEqual(freeTerms({}).models, ['openai-gpt-oss-20b', 'gemma-4-e2b', 'gemma-3-27b-it', 'mistral-small-3.2-24b-instruct', 'qwen3-coder-30b-a3b-instruct', 'deepseek-v4.1-flash']);
  assert.equal(DEFAULT_FREE_MODELS.length, 6);
  for (const value of [undefined, -1, NaN, 'bad']) assert.equal(freeTerms({ freeBudgetUsdPerDay: value }).budgetUsdPerDay, .25);
  const a = new FreeAllowance(freeTerms({ freeBudgetUsdPerDay: 0 }));
  assert.ok(a.take('visitor', 1e9).ok);
  assert.equal(freeTerms({ freeBudgetUsdPerDay: .1 }).budgetUsdPerDay, .1);
  assert.ok(ERROR_CODES.includes('free_budget_exhausted'));
  assert.match(readFileSync(new URL('../ERRORS.md', import.meta.url), 'utf8'), /`free_budget_exhausted`/);
});

test('reservations bound concurrent cost and failures release count and cost', () => {
  const a = new FreeAllowance(freeTerms({ freeBudgetUsdPerDay: .0001 }));
  const first = a.take('a', 60);
  assert.ok(first.ok);
  assert.equal(a.take('b', 60).reason, 'budget');
  const second = a.take('b', 40);
  assert.ok(second.ok);
  assert.equal(a.reservedMicro, 100);
  a.giveBack('a', first); a.done();
  assert.equal(a.reservedMicro, 40);
  assert.equal(a.total, 1);
  a.spend(10, second); a.done();
  assert.equal(a.spentMicro, 10);
  assert.equal(a.reservedMicro, 0);
  assert.ok(a.take('a', 90).ok);
});

test('daily spend and answer count persist, yesterday is ignored, invalid state fails closed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'free-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'private', 'budget.json');
  let now = Date.UTC(2026, 9, 31, 23, 59, 30);
  const terms = freeTerms({ freeStateFile: file, freeBudgetUsdPerDay: .0001 });
  const a = new FreeAllowance(terms, () => now);
  const turn = a.take('fake-network', 80); a.spend(70, turn); a.done();
  const b = new FreeAllowance(terms, () => now);
  assert.equal(b.spentMicro, 70); assert.equal(b.total, 1);
  assert.equal(b.reservedMicro, 0); assert.equal(b.visitors.size, 0);
  assert.equal(b.take('b', 31).reason, 'budget');
  assert.equal(b.secondsToReset(), 30);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file))).sort(), ['answers', 'day', 'pendingMicro', 'spentMicro', 'version']);
  now += 86400000;
  assert.equal(new FreeAllowance(terms, () => now).total, 0);
  for (const data of ['bad json', JSON.stringify({ version: 1, day: Math.floor(now / 86400000), spentMicro: -1, answers: 0 })]) {
    writeFileSync(file, data); const logs = [];
    const fresh = new FreeAllowance(terms, () => now, s => logs.push(s));
    assert.equal(fresh.spentMicro, 100); assert.equal(fresh.take('x', 1).reason, 'budget'); assert.equal(logs.length, 1);
  }
});

test('a crash with an answer in flight counts its reservation as spent after restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'free-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const terms = freeTerms({ freeStateFile: join(dir, 'b.json'), freeBudgetUsdPerDay: .0001 });
  const a = new FreeAllowance(terms, () => Date.UTC(2026, 9, 31, 12));
  assert.equal(a.take('fake-network', 80).ok, true);  // never settled: the process "crashes" here
  const b = new FreeAllowance(terms, () => Date.UTC(2026, 9, 31, 12));
  assert.equal(b.spentMicro, 80); assert.equal(b.reservedMicro, 0);
  assert.equal(b.take('n', 30).reason, 'budget');
});

test('reasoning headroom is fully included in fallback and reservation pricing', () => {
  const model = { id: 'claude-opus-5.5', promptUsdPerToken: 1e-6, completionUsdPerToken: 5e-6 };
  const input = { chars: 100, messages: [{}] };
  assert.equal(freeAnswerCost(null, model, input, 400), worstModelCostMicro(model, { chars: 100, maxTokens: 400, messageCount: 1, charsPerToken: 1 }));
  assert.equal(reasoningHeadroom(model.id), 256);
  assert.ok(freeAnswerCost(null, model, input, 400) >= Math.ceil((400 + reasoningHeadroom(model.id)) * 5));
});

// Exercise the HTTP handler with fake request/response objects: no listener or network.
import { addFreeRoute } from '../src/free.mjs';
function routeHarness({ budget = .0005, upstream, now = () => Date.UTC(2026, 9, 31, 23, 59, 30), file, perVisitor = 20 } = {}) {
  let handler;
  const terms = freeTerms({ freeModels: ['m'], freeBudgetUsdPerDay: budget, freeStateFile: file, freeLimits: { perVisitorPerDay: perVisitor } });
  const allowance = new FreeAllowance(terms, now);
  const info = { id: 'm', promptUsdPerToken: 0, completionUsdPerToken: 1e-6 };
  addFreeRoute({ post(_path, fn) { handler = fn; } }, '/v1/chat/completions', {
    config: {}, terms, allowance, readRequest: () => ({ chars: 5, messages: [{}], maxTokens: 400 }), RequestError: class extends Error {},
    upstream: upstream ?? (async () => ({ content: 'ok', usage: { buyer_cost_micro: 110 } })),
    catalogue: { async resolve() { return info; } }, log() {},
  });
  return { allowance, async ask(ip = '203.0.113.1') {
    const res = { statusCode: 200, headers: {}, set(k, v) { Object.assign(this.headers, typeof k === 'string' ? { [k.toLowerCase()]: v } : Object.fromEntries(Object.entries(k).map(([a,b]) => [a.toLowerCase(), b]))); return this; }, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
    await handler({ body: { model: 'free/m' }, get() { return ip; } }, res, () => assert.fail('unexpected next'));
    return res;
  } };
}

test('budget refusal is a 429 with exact UTC retry and no visitor limit headers', async () => {
  const h = routeHarness();
  assert.equal((await h.ask()).statusCode, 200);
  const res = await h.ask('198.51.100.1');
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error.code, 'free_budget_exhausted');
  assert.equal(res.body.error.type, 'rate_limit_error');
  assert.equal(res.headers['retry-after'], '30');
  assert.ok(!Object.keys(res.headers).some(k => k.startsWith('x-ratelimit-')));
});

test('in-flight route reservations prevent overspend; upstream failure frees reservation', async () => {
  let finish;
  const h = routeHarness({ upstream: () => new Promise(resolve => { finish = resolve; }) });
  const first = h.ask();
  while (!finish) await Promise.resolve();
  assert.equal((await h.ask('198.51.100.1')).body.error.code, 'free_budget_exhausted');
  finish({ content: 'ok', usage: { buyer_cost_micro: 10 } });
  assert.equal((await first).statusCode, 200);
  assert.equal(h.allowance.reservedMicro, 0);
  const failed = routeHarness({ upstream: async () => { throw new Error('fake failure'); } });
  assert.equal((await failed.ask()).statusCode, 503);
  assert.equal(failed.allowance.reservedMicro, 0);
  assert.equal(failed.allowance.total, 0);
  assert.equal(failed.allowance.spentMicro, 0);
});

test('visitor limits still apply when the dollar cap is disabled', async () => {
  const h = routeHarness({ budget: 0, perVisitor: 1 });
  assert.equal((await h.ask()).statusCode, 200);
  const res = await h.ask();
  assert.equal(res.body.error.code, 'free_tier_exhausted');
  assert.equal(res.headers['x-ratelimit-limit'], '1');
  assert.equal((await h.ask('198.51.100.1')).statusCode, 200);
});

test('persisted total also enforces the shared answer limit after restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'free-count-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const terms = freeTerms({ freeStateFile: join(dir, 'state.json'), freeLimits: { perDay: 1 } });
  const a = new FreeAllowance(terms); const turn = a.take('a', 1); a.spend(1, turn); a.done();
  const b = new FreeAllowance(terms);
  assert.equal(b.take('b', 1).reason, 'day');
});

test('write failure logs once and never interrupts answers; milestones only report percentages', t => {
  const dir = mkdtempSync(join(tmpdir(), 'free-write-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'not-a-directory'), 'x');
  const logs = [];
  const a = new FreeAllowance(freeTerms({ freeStateFile: join(dir, 'not-a-directory', 'b.json'), freeBudgetUsdPerDay: .0001 }), Date.now, s => logs.push(s));
  const first = a.take('a', 50); a.spend(50, first); a.done();
  const second = a.take('b', 40); a.spend(40, second); a.done();
  const third = a.take('c', 10); a.spend(10, third); a.done();
  assert.equal(logs.filter(s => s.includes('write failed')).length, 1);
  assert.deepEqual(logs.filter(s => s.includes('budget used')), ['singit-ask: free budget used 50%', 'singit-ask: free budget used 90%', 'singit-ask: free budget used 100%']);
  assert.equal(a.spentMicro, 100);
});

// Helpers behind the native format routes' one post-payment alternate (src/format-fallback.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFamily, FormatTracker, FormatUnserved, rankFormatAlternates, pickAlternate, fitsWindow, WINDOW_MARGIN_MS } from '../src/format-fallback.mjs';

const net = 'eip155:8453';
const cand = model => ({ model, chars: 20, maxTokens: 100, messageCount: 1, share: 1, minDiscount: null, info: { id: model, promptUsdPerToken: 1e-7, completionUsdPerToken: 3e-7 } });

test('modelFamily is the leading letter run', () => {
  for (const [id, family] of [['gemma-4-31b', 'gemma'], ['gemma-4-e2b', 'gemma'], ['gemma-4-26b-a4b-it', 'gemma'], ['qwen3-5-9b', 'qwen'],
    ['qwen3.5-flash', 'qwen'], ['glm-4.7-flash', 'glm'], ['deepseek-v4.1-flash', 'deepseek'], ['cheap-a', 'cheap'], ['Gemma-4', 'gemma']])
    assert.equal(modelFamily(id), family, id);
  assert.equal(modelFamily('9lives'), '9lives');
  assert.equal(modelFamily(undefined), '');
});

test('FormatTracker keeps a short ring per model and network and reports success rate and p50, from one sample on', () => {
  const tracker = new FormatTracker();
  assert.equal(tracker.stats('a', net), null);
  tracker.record('a', net, false, 30_000);
  assert.deepEqual(tracker.stats('a', net), { n: 1, rate: 0, p50: 30_000 });
  assert.equal(tracker.stats('a', 'solana:x'), null, 'per network');
  for (const ms of [100, 300, 200]) tracker.record('b', net, true, ms);
  assert.deepEqual(tracker.stats('b', net), { n: 3, rate: 1, p50: 200 });
  for (let i = 0; i < 50; i++) tracker.record('c', net, i % 2 === 0, i);
  assert.equal(tracker.stats('c', net).n, 20, 'ring is capped');
  tracker.record('d', net, true, NaN);
  assert.equal(tracker.stats('d', net), null);
});

test('rankFormatAlternates: cold start keeps order; failing models go last; well-sampled HealthStats first; p50 breaks ties', () => {
  const pool = ['a', 'b', 'c'].map(cand), names = list => list.map(c => c.model);
  const tracker = new FormatTracker();
  assert.deepEqual(names(rankFormatAlternates(pool, { tracker, network: net })), ['a', 'b', 'c']);
  tracker.record('a', net, false, 500);
  assert.deepEqual(names(rankFormatAlternates(pool, { tracker, network: net })), ['b', 'c', 'a']);
  tracker.record('c', net, true, 900); tracker.record('b', net, true, 4000);
  assert.deepEqual(names(rankFormatAlternates(pool, { tracker, network: net })), ['c', 'b', 'a'], 'both answered: the faster first');
  const health = id => ({ a: { attempts: 30, answered: 29 }, b: { attempts: 1, answered: 1 }, c: { attempts: 30, answered: 3 } })[id];
  assert.deepEqual(names(rankFormatAlternates(pool, { health, network: net })), ['a', 'c', 'b'], 'a lucky 1/1 never beats a measured record');
});

test('fitsWindow: unknown latency fits, a known p50 must fit with the margin', () => {
  assert.equal(fitsWindow(null, 1000), true);
  assert.equal(fitsWindow({ p50: 25_000 }, Infinity), true);
  assert.equal(fitsWindow({ p50: 1000 }, 1000 + WINDOW_MARGIN_MS), true);
  assert.equal(fitsWindow({ p50: 1000 }, 1000 + WINDOW_MARGIN_MS - 1), false);
});

test('pickAlternate: other family first, same family when alone, re-checks health, window and the signed amount', async () => {
  const route = '/v1/messages', unserved = new FormatUnserved(), tracker = new FormatTracker();
  const format = cand('gemma-4-31b');
  const pool = ['gemma-4-e2b', 'cheap-a', 'deepseek-v4.1-flash'].map(cand);
  const base = { route, format, catalogue: {}, unserved, fits: () => true, tracker, network: net };
  const pick = async (options = {}, list = pool) => (await pickAlternate(list, { ...base, ...options }));
  assert.equal((await pick()).alternate.model, 'cheap-a');
  assert.equal((await pick({ fits: c => c.model === 'gemma-4-e2b' })).alternate.model, 'gemma-4-e2b');
  assert.equal((await pick({ catalogue: { isUnservable: id => id === 'cheap-a' } })).alternate.model, 'gemma-4-e2b');
  assert.equal((await pick({ catalogue: { canAnswer: async id => id !== 'cheap-a' } })).alternate.model, 'gemma-4-e2b');
  assert.equal((await pick()).alternate.model, 'cheap-a');
  assert.equal((await pick({}, [cand('gemma-4-31b')])).alternate, null, 'never the failed model itself');
  tracker.record('cheap-a', net, true, 25_000);
  const slow = await pick({ remainingMs: 20_000 });
  assert.equal(slow.alternate.model, 'gemma-4-e2b', 'cheap-a is too slow for what is left; same family beats nothing');
  const none = await pick({ remainingMs: 20_000 }, [cand('cheap-a')]);
  assert.deepEqual(none, { alternate: null, tooSlow: true });
  assert.equal((await pick({}, [cand('cheap-a')])).alternate.model, 'cheap-a', 'no window, no filter');
});

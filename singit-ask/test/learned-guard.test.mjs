import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelCatalogue, markUnservable, priceGuard } from '../src/catalogue.mjs';
import { ceilings } from '../src/metered.mjs';
import { priceProtectionSignal } from '../src/auto-router.mjs';
const log = () => {};
test('learned guard raises every quote scheme, decays on injected clock, and success clears it', async () => {
  let now = 0;
  const c = new ModelCatalogue({ url: 'unused', now: () => now, learnedGuardTtlMs: 1000 });
  c.guardShares.set('model', .05);
  const info = { id: 'model', promptUsdPerToken: .01, completionUsdPerToken: .01 };
  const input = { model: 'model', info, chars: 100, maxTokens: 300, messageCount: 1 };
  const before = ceilings(info, { ...input, ...priceGuard(c, 'model', 1) });
  markUnservable(c, 'model', { code: 'minimum_discount_not_met', bestDiscountPct: 93.75 }, log);
  assert.equal(c.guardShare('model'), .0625);
  assert.deepEqual(priceGuard(c, 'model', 1), { share: .08, minDiscount: 92 });
  const candidate = { ...input, ...priceGuard(c, 'model', 1) };
  const after = ceilings(info, candidate);
  for (const scheme of ['upto', 'exact']) for (const net of Object.keys(before[scheme])) assert.ok(BigInt(after[scheme][net]) > BigInt(before[scheme][net]));
  assert.equal(await priceProtectionSignal(c, candidate), null);
  now = 1000;
  assert.equal(c.guardShare('model'), .05);
  c.markPriceRejected('model', { bestDiscountPct: 0 });
  assert.equal(priceGuard(c, 'model', 1).share, 1);
  c.noteAnswered('model');
  assert.equal(c.guardShare('model'), .05);
  assert.equal(c.isPriceRejected('model'), false);
  for (const bestDiscountPct of [null, undefined, NaN, Infinity, -1, 101, '93.75']) {
    c.markPriceRejected('model', { bestDiscountPct });
    assert.equal(c.guardShare('model'), .05);
  }
  c.markPriceRejected('model', { bestDiscountPct: 99 });
  assert.equal(c.guardShare('model'), .05);
});
test('journal replay: sent 94, best 93.75, 66 repeated failures cannot generate unbounded quotes', async () => {
  const c = new ModelCatalogue({ url: 'unused', now: () => 0, neverHide: ['glm-5.3-flash'] });
  const id = 'glm-5.3-flash'; c.guardShares.set(id, .05);
  assert.equal(priceGuard(c, id, 1).minDiscount, 94);
  let quotes = 0;
  for (let n = 0; n < 66; n++) {
    if (!await c.canAnswer(id)) continue;
    quotes++;
    if (n > 0) assert.equal(priceGuard(c, id, 1).minDiscount, 92);
    markUnservable(c, id, { code: 'minimum_discount_not_met', bestDiscountPct: 93.75 }, log);
  }
  assert.equal(quotes, 3);
  assert.equal(c.isUnservable(id), true);
  assert.equal(c.isSuspended(id), false);
});

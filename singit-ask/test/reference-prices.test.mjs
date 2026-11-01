import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REFERENCE_PRICES, bookPrices, derivedPrice } from '../src/reference-prices.mjs';
import { ModelCatalogue, priceGuard } from '../src/catalogue.mjs';
const offer = (i, o, extra = {}) => ({ trusted: true, effective_input_per_1m: i, effective_output_per_1m: o, ...extra });
test('book bounds ignore health and capacity, filter invalid prices and providers, and use micro-USD per million units', () => {
  assert.deepEqual(bookPrices({ offers: [offer(219558, 219558)] }), { inputUsdPerToken: 2.19558e-7, outputUsdPerToken: 2.19558e-7 });
  assert.deepEqual(bookPrices({ data: { offers: [offer(1, 2), offer(3, 4, { healthy: false, available: false, cap_remaining: -1 }),
    offer(999, 999, { trusted: false }), offer(999, 999, { provider_id: 'BLOCK' }), offer(999, 999, { pricing_mode: 'per_image' }),
    offer(0, 999), offer(Infinity, 999), offer(999, NaN)] } }, new Set(['block'])), { inputUsdPerToken: 3e-12, outputUsdPerToken: 4e-12 });
  assert.equal(bookPrices({ offers: [offer(0, 1)] }), null);
});
test('derived prices have independent static floors and live margins for exactly twelve reviewed ids', () => {
  assert.equal(Object.keys(REFERENCE_PRICES).length, 12);
  assert.ok(Object.isFrozen(REFERENCE_PRICES));
  for (const [id, r] of Object.entries(REFERENCE_PRICES)) {
    assert.ok(Object.isFrozen(r));
    assert.deepEqual(derivedPrice(id, { inputUsdPerToken: 1, outputUsdPerToken: 0 }), {
      inputUsdPerToken: 1.1, outputUsdPerToken: r.outputUsdPerM / 1e6 });
  }
  assert.equal(derivedPrice('unreviewed'), null);
});
test('catalogue refresh replaces reference objects, preserves positive sides and last good books even on discarded health pass', async () => {
  const id = 'gemini-3.1-pro';
  let book = { model: id, offers: [offer(3000000, 20000000, { healthy: true, available: true, discount_pct: null })] };
  const c = new ModelCatalogue({ url: 'https://fixture', fetchImpl: async url => {
    if (url.endsWith('/v1/models')) return Response.json({ data: [[id, 0, 0], ['qwen3.5-plus', 1e-6, 0]].map(([id, prompt, completion]) => ({
      id, pricing: { prompt, completion }, architecture: { modality: 'text->text' }, supported_parameters: ['max_tokens'] })) });
    if (!book) throw Error('unreadable');
    return Response.json(book);
  } });
  const first = await c.resolve(id);
  assert.equal(first.priceBasis, 'reference');
  assert.equal(first.promptUsdPerToken, 2.5e-6);
  assert.ok((await c.list()).some(m => m.id === id));
  assert.equal((await c.resolve('qwen3.5-plus')).promptUsdPerToken, 1e-6);
  await c.loadServed(0);
  assert.equal((await c.resolve(id)).promptUsdPerToken, 3e-6 * 1.1);
  assert.equal(first.promptUsdPerToken, 2.5e-6);
  assert.deepEqual(priceGuard(c, id, 1), { share: 1, minDiscount: null });
  book = { model: id, offers: [offer(4000000, 30000000, { healthy: false })] };
  await c.loadServed(0);
  assert.equal((await c.resolve(id)).promptUsdPerToken, 4e-6 * 1.1);
  book = null; await c.loadServed(0);
  assert.equal(c.bookPrice(id).inputUsdPerToken, 4e-6);
  book = { offers: [offer(1, 1)] }; await c.loadServed(0);
  assert.equal((await c.resolve(id)).promptUsdPerToken, 2.5e-6);
});

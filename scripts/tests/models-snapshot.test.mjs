import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot } from '../models-snapshot.mjs';

test('snapshot drops a token pair when a positive list component has a zero SingIt price', () => {
  const data = Array.from({ length: 50 }, (_, i) => ({ id: `m-${i}`, usdPerMillionTokens: { input: 1, output: 2 }, singitUsdPerMillionTokens: { input: i ? 0.1 : 0, output: 0.2 } }));
  data[2].usdPerMillionTokens.input = 0;
  data[2].singitUsdPerMillionTokens.input = 0;
  const result = snapshot({ object: 'list', data, fees: { markupPct: 30, perAnswerUsd: { base: 0.001, solana: 0.002 } } }, {
    networks: { base: { chain: 'base', settlementFeeUsd: 0.001 }, solana: { chain: 'solana', settlementFeeUsd: 0.002 } },
    referenceRequest: { messages: 1, maxOutputTokens: 800 },
    models: data.map(m => ({ id: m.id, upto: { base: { usd: 1 }, solana: { usd: 1 } }, exact: { base: { usd: 1 }, solana: { usd: 1 } } })),
  }, '2026-11-01T00:00:00Z');
  assert.deepEqual(result.models.find(m => m.id === 'm-2').singitUsdPerMillionTokens, { input: 0, output: 0.2 });
  assert.equal(result.models.find(m => m.id === 'm-0').singitUsdPerMillionTokens, undefined);
  assert.deepEqual(result.models.find(m => m.id === 'm-1').singitUsdPerMillionTokens, { input: 0.1, output: 0.2 });
});

function priced(extra) {
  const data = Array.from({ length: 50 }, (_, i) => ({ id: `m-${i}`, usdPerMillionTokens: { input: 1, output: 2 } }));
  data.push(...extra);
  const pricing = {
    networks: { base: { chain: 'base', settlementFeeUsd: 0.001 }, solana: { chain: 'solana', settlementFeeUsd: 0.002 } },
    referenceRequest: { messages: 1, maxOutputTokens: 800 },
    models: data.map(m => ({ id: m.id, upto: { base: { usd: 1 }, solana: { usd: 1 } }, exact: { base: { usd: 1 }, solana: { usd: 1 } } })),
  };
  return { models: { object: 'list', data, fees: { markupPct: 30, perAnswerUsd: { base: 0.001, solana: 0.002 } } }, pricing };
}

test('snapshot keeps a free daily budget from the payload', () => {
  const offer = priced([]);
  offer.models.free = { models: ['free/a'], perVisitorPerDay: 20, budgetUsdPerDay: 0.25 };
  assert.equal(snapshot(offer.models, offer.pricing, '2026-11-01T00:00:00Z').free.budgetUsdPerDay, 0.25);
  delete offer.models.free.budgetUsdPerDay;
  assert.equal(Object.hasOwn(snapshot(offer.models, offer.pricing, '2026-11-01T00:00:00Z').free, 'budgetUsdPerDay'), false);
  offer.models.free.budgetUsdPerDay = -1;
  assert.throws(() => snapshot(offer.models, offer.pricing, '2026-11-01T00:00:00Z'), /free budget/);
});

test('snapshot skips an embedding rate and still rejects a broken token pair', () => {
  const scalar = priced([{ id: 'venice-embed-1', usdPerMillionTokens: 0.1625 }]);
  scalar.pricing.models = scalar.pricing.models.filter(m => m.id !== 'venice-embed-1').concat([{ id: 'venice-embed-1' }]);
  const kept = snapshot(scalar.models, scalar.pricing, '2026-11-01T00:00:00Z');
  assert.equal(kept.models.some(m => m.id === 'venice-embed-1'), false);
  assert.equal(kept.models.length, 50);
  const negative = priced([{ id: 'embed', usdPerMillionTokens: -1 }]);
  assert.throws(() => snapshot(negative.models, negative.pricing, '2026-11-01T00:00:00Z'), /embedding rate/);
  const broken = priced([{ id: 'broken', usdPerMillionTokens: { input: 1 } }]);
  assert.throws(() => snapshot(broken.models, broken.pricing, '2026-11-01T00:00:00Z'), /token prices/);
});

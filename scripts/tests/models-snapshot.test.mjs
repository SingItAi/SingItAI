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

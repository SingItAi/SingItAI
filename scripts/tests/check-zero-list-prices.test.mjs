import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../check-zero-list-prices.mjs';
const id = 'gemini-3.1-pro';
const offer = n => ({ trusted: true, healthy: true, available: true, effective_input_per_1m: n, effective_output_per_1m: n });
for (const [name, model, book, failures] of [
  ['healthy', id, { offers: [offer(1000000)] }, 0],
  ['equal to the static price passes despite float noise', 'claude-opus-4.6-fast', { offers: [{ ...offer(0), effective_input_per_1m: 32400000, effective_output_per_1m: 162000000 }] }, 0],
  ['stale', id, { offers: [offer(16000000)] }, 1],
  ['unreviewed', 'unknown-zero', { offers: [offer(1)] }, 1],
  ['unreadable', id, null, 0],
]) test(name, () => {
  const r = evaluate({ models: new Map([[model, { listZero: true }]]), books: new Map([[model, book]]) });
  assert.equal(r.failures.length, failures);
  if (!book) assert.ok(r.warnings.some(w => w.includes('unreadable')));
});

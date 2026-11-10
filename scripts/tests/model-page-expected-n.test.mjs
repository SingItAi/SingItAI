import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedPriceCopy } from '../generate-model-pages.mjs';

test('expected price copy names n when present and keeps the old sentence when n is absent', () => {
  assert.deepEqual(expectedPriceCopy({ basis: 'observed' }), {
    basisText: 'based on what answers from this model have cost us',
    sample: '',
  });
  assert.deepEqual(expectedPriceCopy({ basis: 'trusted' }), {
    basisText: 'estimate from sellers\' quotes, not yet confirmed by answers we paid for, so the real price can be higher',
    sample: '',
  });
  assert.equal(expectedPriceCopy({ basis: 'observed', n: 7, window: 20 }).sample,
    ' Sample size n = 7 of the last 20 paid answers.');
  const preliminary = expectedPriceCopy({ basis: 'observed_preliminary', n: 1, window: 20 });
  assert.equal(preliminary.basisText, 'based on what answers from this model have cost us');
  assert.match(preliminary.sample, /n = 1 of the last 20 paid answers/);
  assert.match(preliminary.sample, /preliminary sample/);
});

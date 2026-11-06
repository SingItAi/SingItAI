import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshot, EXCLUDED_MODALITIES } from '../catalog-snapshot.mjs';
import { catalogResponse } from '../../singit-ask/src/catalog-shape.mjs';

test('offline snapshot filters excluded modalities and recomputes counts from kept entries', () => {
  assert.deepEqual(EXCLUDED_MODALITIES, ['video', 'music', 'sound_effects', 'transcription']);
  const data = ['chat', 'image', 'image_edit', 'embeddings', 'speech', 'search', ...EXCLUDED_MODALITIES]
    .map(modality => ({ id: `fixture-${modality}`, modality }));
  const response = catalogResponse(data);
  const result = snapshot(response, '2026-11-05T17:25:00Z');
  assert.deepEqual(result.excluded, EXCLUDED_MODALITIES);
  assert.deepEqual(result.data, data.filter(e => !EXCLUDED_MODALITIES.includes(e.modality)));
  assert.deepEqual(result.counts, catalogResponse(result.data).counts);
  assert.equal(result.counts.transcription, 0);
  for (const modality of ['image', 'image_edit', 'embeddings', 'speech']) assert.ok(result.counts[modality] > 0);
  assert.equal(response.data.length, data.length);
  assert.throws(() => snapshot({ ...response, counts: {} }, result.fetchedAt), /Counts disagree/);
  assert.throws(() => snapshot(response, 'invalid'), /Invalid fetchedAt/);
});

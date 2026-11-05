// Offline only: save an externally captured GET /v1/catalog response; never fetch here.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { catalogResponse } from '../singit-ask/src/catalog-shape.mjs';

// Video and music/SFX stay off the website pending a product decision.
// API-key-only transcription is excluded because its production route returns 404.
export const EXCLUDED_MODALITIES = Object.freeze(['video', 'music', 'sound_effects', 'transcription']);

export function snapshot(response, fetchedAt) {
  if (!Number.isFinite(Date.parse(fetchedAt))) throw new Error('Invalid fetchedAt');
  const canonical = catalogResponse(response.data);
  if (JSON.stringify(response.counts) !== JSON.stringify(canonical.counts)) throw new Error('Counts disagree');
  const kept = canonical.data.filter(entry => !EXCLUDED_MODALITIES.includes(entry.modality));
  return { fetchedAt, source: 'https://ask.singitai.app/v1/catalog', coverage: 'Website modalities from the captured catalog; excluded modalities are recorded in the snapshot', excluded: EXCLUDED_MODALITIES, ...catalogResponse(kept) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, fetchedAt] = process.argv.slice(2);
  if (!input || !fetchedAt) throw new Error('Usage: catalog-snapshot.mjs catalog-response.json ISO-date');
  const response = JSON.parse(await readFile(input, 'utf8'));
  await writeFile(new URL('../website/data/catalog-snapshot.json', import.meta.url), JSON.stringify(snapshot(response, fetchedAt), null, 2) + '\n');
}

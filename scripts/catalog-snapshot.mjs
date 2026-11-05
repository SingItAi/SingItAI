// Offline only: save an externally captured GET /v1/catalog response; never fetch here.
import { readFile, writeFile } from 'node:fs/promises';
import { catalogResponse } from '../singit-ask/src/catalog-shape.mjs';
const [input, fetchedAt] = process.argv.slice(2);
if (!input || !fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('Usage: catalog-snapshot.mjs catalog-response.json ISO-date');
const response = JSON.parse(await readFile(input, 'utf8'));
const canonical = catalogResponse(response.data);
if (JSON.stringify(response.counts) !== JSON.stringify(canonical.counts)) throw new Error('Counts disagree');
await writeFile(new URL('../website/data/catalog-snapshot.json', import.meta.url), JSON.stringify({ fetchedAt, source: 'https://ask.singitai.app/v1/catalog', ...canonical }, null, 2) + '\n');

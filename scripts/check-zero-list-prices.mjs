import { pathToFileURL } from 'node:url';
import { REFERENCE_PRICES, BOOK_PRICE_MARGIN, bookPrices, matchesBook } from '../singit-ask/src/reference-prices.mjs';
import { parseModels } from '../singit-ask/src/catalogue.mjs';
export function evaluate({ models, books, blocked = new Set() }) {
  const rows = [], failures = [], warnings = [];
  for (const id of Object.keys(REFERENCE_PRICES)) {
    if (!models.get(id)?.listZero) warnings.push(`${id}: missing or no longer zero-listed`);
  }
  for (const [id, m] of models) {
    if (!m.listZero) continue;
    const ref = Object.hasOwn(REFERENCE_PRICES, id) ? REFERENCE_PRICES[id] : null, book = books.get(id);
    const valid = book && matchesBook(book, id) && Array.isArray(book?.data?.offers ?? book?.offers);
    const live = valid ? bookPrices(book, blocked) : null;
    const qualifying = valid ? (book?.data?.offers ?? book.offers).filter(o => o.trusted === true && o.healthy === true && o.available === true
      && !(typeof o.cap_remaining === 'number' && o.cap_remaining <= 0) && !blocked.has(String(o.provider_id ?? '').toLowerCase())).length : 0;
    rows.push({ id, allowlisted: !!ref, staticInput: ref?.inputUsdPerM, staticOutput: ref?.outputUsdPerM,
      offerInput: live ? live.inputUsdPerToken * 1e6 : null, offerOutput: live ? live.outputUsdPerToken * 1e6 : null, qualifying });
    if (!valid) warnings.push(`${id}: unreadable book`);
    if (ref && live && (ref.inputUsdPerM / 1e6 < live.inputUsdPerToken * (1 - 1e-9) || ref.outputUsdPerM / 1e6 < live.outputUsdPerToken * (1 - 1e-9))) failures.push(`${id}: table stale: raise it`);
    if (!ref && qualifying) failures.push(`${id}: review it: it is refused on the paid path`);
  }
  return { rows, failures, warnings };
}
async function main() {
  const url = (process.env.SURPLUS_API_URL || 'https://api.surplusintelligence.ai').replace(/\/$/, '');
  const response = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`models HTTP ${response.status}`);
  const models = parseModels(await response.json()), books = new Map();
  if (!models.size) throw new Error('Empty text model list');
  const ids = [...models].filter(([, m]) => m.listZero).map(([id]) => id);
  let next = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const r = await fetch(`${url}/api/markets/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10000) });
        if (r.ok) books.set(id, await r.json());
      } catch { /* reported as a warning */ }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }));
  const result = evaluate({ models, books });
  console.table(result.rows);
  console.log(`Live book margin: ${BOOK_PRICE_MARGIN}`);
  for (const warning of result.warnings) console.warn(warning);
  for (const failure of result.failures) console.error(failure);
  if (result.failures.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });

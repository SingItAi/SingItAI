// Listing copy changes metadata only; it does not add per-model resources.
// Counts describe the D3 snapshot, not a live availability promise.
export function listingCopy(catalog, modality, capability, { audioSold = false, videoSold = false } = {}) {
  if ((['music', 'sound_effects'].includes(modality) && !audioSold) || (modality === 'video' && !videoSold)) return null;
  const entries = (catalog.data ?? []).filter(e => e.modality === modality);
  const paid = entries.filter(e => e.available !== false && (e.payment === 'x402' || e.access === 'x402'));
  if (modality === 'transcription') return { description: 'Transcription is API-key only; see GET /v1/catalog.', tags: ['transcription', 'api-key'] };
  // Sample up to four families in ID order, independent of catalog entry order.
  const samples = [];
  const families = new Set();
  for (const e of paid.filter(e => !e.router && !e.free && !['router', 'free'].includes(e.kind)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const family = e.id.split(/[-/]/)[0];
    if (!families.has(family)) { samples.push(e); families.add(family); }
    if (samples.length === 4) break;
  }
  // Hidden modalities must never advertise model names, even in draft listings.
  const hidden = ['music', 'sound_effects', 'video'].includes(modality);
  const names = hidden ? [] : samples.map(e => e.id.slice(0, 60));
  const free = entries.some(e => e.free || e.kind === 'free');
  const lead = capability === 'OpenAI-compatible chat API'
    ? `${capability}, many models${free ? ' incl. free ones' : ''}` : capability;
  const description = `${lead}. Pay per call in USDC on Base or Solana, no API key. Models: GET /v1/catalog.`;
  if (description.length > 160) throw new RangeError('Listing description exceeds 160 characters');
  if (/ceiling|\bfees?\b|%/i.test(description)) throw new Error('Listing description contains banned wording');
  return { description, tags: [modality, ...names, ...(hidden ? [] : families)].slice(0, 5) };
}

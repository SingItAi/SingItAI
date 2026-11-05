// D2 preserves 25 default paid URL resources (27 with draft audio enabled), not the old 22.
// No per-model resources are added. Counts describe the D3 snapshot, not a live availability promise.
export function listingCopy(catalog, modality, capability, { audioSold = false, videoSold = false } = {}) {
  if ((['music', 'sound_effects'].includes(modality) && !audioSold) || (modality === 'video' && !videoSold)) return null;
  const entries = (catalog.data ?? []).filter(e => e.modality === modality);
  const paid = entries.filter(e => e.available !== false && (e.payment === 'x402' || e.access === 'x402'));
  if (modality === 'transcription') return { description: 'Transcription is API-key only; see GET /v1/catalog.', tags: ['transcription', 'api-key'] };
  const count = catalog.counts?.[modality] ?? entries.length;
  // Sample one real ID from each provider/family before filling remaining slots.
  const samples = [];
  const families = new Set();
  const preferred = /^(claude-opus-5\.5$|gpt-5\.5$|gemini-3\.8-flash$)/;
  for (const e of paid.filter(e => !e.router && !e.free && !['router', 'free'].includes(e.kind)).sort((a, b) => Number(preferred.test(b.id)) - Number(preferred.test(a.id)))) {
    const family = e.id.split(/[-/]/)[0];
    if (!families.has(family)) { samples.push(e); families.add(family); }
  }
  const names = samples.slice(0, 4).map(e => e.id.slice(0, 60));
  const noun = modality === 'search' ? 'search tools' : `${modality.replaceAll('_', ' ')} models`;
  const inventory = count > 0 && paid.length ? `Snapshot: ${count} ${noun}${modality === 'chat' && entries.some(e => e.free || e.router || ['free', 'router'].includes(e.kind)) ? ' (including free entries and routers)' : ''}${names.length ? ` incl. ${names.join(', ')}` : ''}.` : `${noun} listed at GET /v1/catalog.`;
  const description = `${capability}. ${inventory} Pay per call in USDC on Base or Solana, no API key.${count > 0 && paid.length ? ' Live availability: GET /v1/catalog.' : ''}`;
  if (description.length > 500) throw new RangeError('Listing description exceeds 500 characters');
  return { description, tags: [modality, ...names, ...families].slice(0, 5) };
}

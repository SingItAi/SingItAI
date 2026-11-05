export const MODALITIES = Object.freeze(['chat', 'image', 'image_edit', 'embeddings', 'speech', 'transcription', 'search']);
export function catalogResponse(data, modality) {
  if (modality !== undefined && !MODALITIES.includes(modality)) throw new RangeError('Unknown modality');
  const seen = new Set();
  for (const entry of data) {
    const key = `${entry.modality}:${entry.id}`;
    if (!MODALITIES.includes(entry.modality) || typeof entry.id !== 'string' || seen.has(key)) throw new TypeError('Invalid or duplicate catalog entry');
    seen.add(key);
  }
  const counts = Object.fromEntries(MODALITIES.map(m => [m, data.filter(e => e.modality === m).length]));
  return { object: 'list', counts, data: modality === undefined ? data : data.filter(e => e.modality === modality) };
}

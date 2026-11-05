export const MODALITIES = Object.freeze(['chat', 'image', 'image_edit', 'embeddings', 'speech', 'transcription', 'search']);
const OPTIONAL_MODALITIES = ['music', 'sound_effects', 'video'];
export const catalogModalities = data => [...MODALITIES, ...OPTIONAL_MODALITIES.filter(m => data.some(e => e.modality === m))];
export function catalogResponse(data, modality) {
  const modalities = catalogModalities(data);
  if (modality !== undefined && !modalities.includes(modality)) throw new RangeError('Unknown modality');
  const seen = new Set();
  for (const entry of data) {
    const key = `${entry.modality}:${entry.id}`;
    if (!modalities.includes(entry.modality) || typeof entry.id !== 'string' || seen.has(key)) throw new TypeError('Invalid or duplicate catalog entry');
    seen.add(key);
  }
  const counts = Object.fromEntries(modalities.map(m => [m, data.filter(e => e.modality === m).length]));
  return { object: 'list', counts, data: modality === undefined ? data : data.filter(e => e.modality === modality) };
}

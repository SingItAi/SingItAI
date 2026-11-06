import { readFileSync } from 'node:fs';
import { listingCopy } from './listing-copy.mjs';
const snapshot = JSON.parse(readFileSync(new URL('../../website/data/catalog-snapshot.json', import.meta.url), 'utf8'));
export const copyFor = (modality, capability, flags) => listingCopy(snapshot, modality, capability, flags);
export const routeCopy = path => {
  if (path.startsWith('/v1/exa/')) return copyFor('search', ({ search: 'Exa web search with ranked results', contents: 'Exa page contents and highlights', answer: 'Exa web answer with citations' })[path.split('/').at(-1)]);
  if (path === '/v1/images/generations') return copyFor('image', 'OpenAI-compatible text-to-image API');
  if (path === '/v1/embeddings') return copyFor('embeddings', 'OpenAI-compatible text embeddings API');
  if (path.startsWith('/v1/images/')) return copyFor('image_edit', 'Image editing API: PNG, JPEG or WEBP input, optional mask');
  if (path === '/v1/audio/speech') return copyFor('speech', 'OpenAI-compatible text-to-speech API');
  const pinned = snapshot.data.find(e => e.modality === 'chat' && path === `/v1/chat/${e.id}`);
  // Keep data-derived tags; only the capability names the pinned model.
  if (pinned) return copyFor('chat', `OpenAI-compatible chat API pinned to ${pinned.name.replace(/^[^:]+: /, '')}`);
  return copyFor('chat', path === '/v1/messages' ? 'Anthropic Messages format chat API, many models' : path === '/v1/responses' ? 'OpenAI Responses format chat API, many models' : 'OpenAI-compatible chat API');
};

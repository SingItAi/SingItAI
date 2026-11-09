// Unified discovery only. Execution and price authority remain with each existing route.
import { AUTO_ID, AUTO_DESCRIPTION, AUTO_CONFIG } from './auto-router.mjs';
import { MODEL_ROUTES, routePath } from './model-routes.mjs';
import { FREE_PREFIX } from './free.mjs';
import { IMAGE_ROUTE, imageListAtomic, imagePrice } from './images.mjs';
import { ROUTE as EDIT_ROUTE } from './image-edits.mjs';
import { ROUTE as EMBEDDING_ROUTE } from './embeddings.mjs';
import { SPEECH_ROUTE, SPEECH_TERMS } from './speech.mjs';
import { SEARCH_ROUTES, exaPriceRange } from './search.mjs';
import { availableAudioPrices, MUSIC_ROUTE, SFX_ROUTE, AUDIO_MODELS } from './audio-generation.mjs';
import { VIDEO_ROUTE, videoListAtomic, videoPrice } from './video.mjs';
import { BASE, SOLANA } from './pricing.mjs';

export { MODALITIES, catalogResponse } from './catalog-shape.mjs';
export async function buildCatalog({ catalogue, config = {}, free, searchEnabled = false, chatPrice = async () => ({ mode: 'dynamic' }), extraPrice = async () => ({ mode: 'dynamic' }) }) {
  const data = [];
  const add = (m, modality, route, price, payment = 'x402', kind = 'model', extra = {}) => data.push({
    id: m.id, name: m.name || m.id, modality, route, payment,
    access: payment === 'api_key_only' ? 'api_key' : payment, available: true,
    router: kind === 'router', free: kind === 'free' || payment === 'free',
    networks: payment === 'x402' ? [BASE, SOLANA] : [], kind, price, ...extra,
  });
  const listed = await catalogue?.list() ?? [];
  for (const m of listed) {
    const eligible = catalogue.listable ? await catalogue.listable(m.id) : catalogue.canAnswer ? await catalogue.canAnswer(m.id) : true;
    if (!eligible && !catalogue.neverHide?.has(m.id) && m.id !== config.model) continue;
    let price;
    try { price = await chatPrice(m); } catch { price = { mode: 'unavailable' }; }
    add(m, 'chat', MODEL_ROUTES.some(r => r.id === m.id) ? routePath(m.id) : '/v1/chat/completions', price, 'x402', 'model',
      { available: catalogue.canAnswer ? Boolean(await catalogue.canAnswer(m.id)) : Boolean(eligible),
        ...(config.defaultFallbacks !== false && AUTO_CONFIG.pinnedDefaultFallbacks[m.id] ? { defaultFallback: AUTO_CONFIG.pinnedDefaultFallbacks[m.id] } : {}) });
  }
  add({ id: AUTO_ID, name: 'SingIt Auto' }, 'chat', '/v1/chat/completions', { mode: 'selected_model', description: AUTO_DESCRIPTION }, 'x402', 'router');
  // The default alias can use configured fallback routing; it has no independent model price.
  add({ id: 'singit-ask', name: 'SingIt Ask default / fallback' }, 'chat', '/v1/chat/completions', { mode: 'selected_model', upstream: config.model }, 'x402', 'router');
  for (const id of free?.models ?? []) add({ id: FREE_PREFIX + id }, 'chat', '/v1/chat/completions', { usd: 0, limits: { perVisitorPerDay: free.perVisitorPerDay, maxTokens: free.maxTokens, maxChars: free.chars } }, 'free', 'free', { available: catalogue?.canAnswer ? Boolean(await catalogue.canAnswer(id)) : true });
  for (const m of (await catalogue?.imageModels?.().catch(() => new Map()) ?? new Map()).values()) {
    const amount = imageListAtomic(m, { prompt: '', n: 1, size: !m.sizes || m.sizes.includes('1024x1024') ? '1024x1024' : m.sizes[0] });
    add(m, 'image', IMAGE_ROUTE, { reference: 'one image', exact: Object.fromEntries([['base', BASE], ['solana', SOLANA]].map(([n, chain]) => [n, { usd: Number(imagePrice(amount, chain).totalAtomic) / 1e6 }])) });
  }
  for (const [method, modality, route] of [['editModels', 'image_edit', EDIT_ROUTE], ['embeddingModels', 'embeddings', EMBEDDING_ROUTE]]) {
    for (const m of (await catalogue?.[method]?.().catch(() => new Map()) ?? new Map()).values()) add(m, modality, route, await extraPrice(m, modality));
  }
  const voice = await catalogue?.voiceModels?.().catch(() => ({ speech: new Map(), transcription: new Map() })) ?? { speech: new Map(), transcription: new Map() };
  for (const modality of ['speech', 'transcription']) for (const m of voice[modality].values()) {
    add(m, modality, modality === 'speech' ? SPEECH_ROUTE : '/v1/audio/transcriptions', {
      currency: 'USD', unit: modality === 'speech' ? '1000 characters' : 'minute', list: m.usdPerUnit,
      withMarkup: Number((m.usdPerUnit * (1 + SPEECH_TERMS.markupBps / 10000)).toFixed(6)), settlementFeeAdditional: modality === 'speech',
    }, modality === 'speech' ? 'x402' : 'api_key_only');
  }
  for (const m of availableAudioPrices(config, catalogue)) {
    const model = AUDIO_MODELS.find(model => model.id === m.id);
    const music = model.kind === 'music';
    add(m, music ? 'music' : 'sound_effects', music ? MUSIC_ROUTE : SFX_ROUTE,
      { exact: { base: m.exact.base } }, 'x402', 'model', { networks: [BASE] });
  }
  if (config.videoSold === true) {
    const models = await catalogue?.videoModels?.() ?? new Map();
    const served = await catalogue?.videoServed?.();
    for (const m of models.values()) {
      if (served?.size && !(served.get(m.id) > 0)) continue;
      // Video is Base-only (#224); Solana is refused at the route.
      const p = videoPrice(videoListAtomic(m), BASE);
      add(m, 'video', VIDEO_ROUTE, { exact: { base: { ceilingAtomic: p.totalAtomic, usd: Number(p.totalAtomic) / 1e6 } } },
        'x402', 'model', { networks: [BASE] });
    }
  }
  if (searchEnabled) for (const route of Object.keys(SEARCH_ROUTES)) add({ id: `exa/${route.split('/').at(-1)}` }, 'search', route, exaPriceRange());
  return data.sort((a, b) => a.modality.localeCompare(b.modality) || a.id.localeCompare(b.id));
}

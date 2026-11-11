// Draft CDP/Growth propagation copy. Direct wallet calls require the buyer's signature.
// Keep existing route/alias descriptions stable; long pinned names leave no room.
// CDP's facilitator rejects a resource description over 500 characters; real copy stays well under it.
export const MAX_DESCRIPTION = 500;
// Billing detail, the markup in any spelling and commands aimed at an agent never go into a listing.
const BANNED = /ceiling|\bfees?\b|%|markup|\b(30|thirty)\s*percent\b|\bcall it when\b|\byou (should|must)\b/i;
export function checkedDescription(description) {
  if (!description) throw new RangeError('Listing description is empty');
  if (description.length > MAX_DESCRIPTION) throw new RangeError(`Listing description exceeds ${MAX_DESCRIPTION} characters`);
  if (BANNED.test(description)) throw new Error('Listing description contains banned wording');
  return description;
}

// What a buyer pays with and how; `unit` is "answer" for chat and "call" for everything else.
// A statement of fact, not an instruction; the tiers and how to qualify are in the 402's extra.holderDiscount.
export const HOLDER_NOTE = 'SINGIT holders on Base can get a lower USDC quote (see extra.holderDiscount).';
export const payTail = (unit = 'call', networks = 'Base or Solana') =>
  `Pay-per-${unit} in USDC on ${networks}, no API key; the max charge is quoted before signing. ${HOLDER_NOTE}`;

// Service-level blurb (the bare origin's index, llms.txt), not a route's 402 description. It names only what
// this instance sells: `formats` adds Anthropic/Responses, images and speech, `search` adds Exa.
export function serviceDescription({ formats = true, search = true, long = false } = {}) {
  const sold = [long && formats ? 'LLM chat (OpenAI, Anthropic and Responses formats)' : 'LLM chat',
    ...(formats ? ['images', 'speech'] : []), ...(search ? ['Exa web search'] : [])];
  const list = sold.length > 1 ? `${sold.slice(0, -1).join(', ')} and ${sold.at(-1)}` : sold[0];
  return checkedDescription(long
    ? `Pay-per-answer ${list} over x402 in USDC, with no API key. The SingIt SDK supports client-side per-call and per-day spend limits; the max charge is quoted before signing.`
    : `Pay-per-answer ${list} over x402 in USDC, no API key; the max charge is quoted before signing.`);
}

export function bazaarLimitsBoilerplate(capability = 'AI chat, images and search') {
  return checkedDescription(`${capability}. Owner-set USDC limits via MCP/API keys; check allowance and receipts.`);
}

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
  const description = checkedDescription(`${lead}. ${payTail(modality === 'chat' ? 'answer' : 'call')} Models: GET /v1/catalog.`);
  return { description, tags: [modality, ...names, ...(hidden ? [] : families)].slice(0, 5) };
}

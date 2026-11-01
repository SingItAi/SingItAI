import { NEVER_HIDE, MAX_PROVIDERS, validId, readSuspensions, writeSuspensions } from "./suspensions.mjs";
export { NEVER_HIDE } from "./suspensions.mjs";
import { bookPrices, derivedPrice, matchesBook } from "./reference-prices.mjs";
// Every text model Surplus sells, read from Surplus itself: a hand-kept list of 400+ models would be stale
// the day a seller adds one. The list is public; the prices are per token in USD.

const TTL_MS = 6 * 60 * 60 * 1000;
// The marketplace's cheapest offers move; the page showing them is public and large (about 1.7 MB), so ten minutes.
const MARKET_TTL_MS = 10 * 60 * 1000;
const VIDEO_HEALTH_TTL_MS = 60 * 1000;
// A single rejection older than this does not make the next one a second consecutive rejection.
const STREAK_MS = 24 * 60 * 60 * 1000;

export class UnknownModel extends Error {}
export class UnpricedModel extends UnknownModel {
  constructor() {
    super("That model has no usable list price right now and is not sold. You were not charged. See GET /v1/models.");
  }
}

// What a model can do, in the picker's own category keys (the ones Venice's list uses). Surplus says it through the
// inputs a model accepts and its features; coding models are mostly marked only by name.
const CODE_NAME = /coder|codex|devstral|(^|[-.])code([-.:]|$)/i;
export function capabilities(entry, inputs) {
  const features = new Set(entry?.supported_features ?? []);
  const tags = [];
  if (inputs.includes("image") || features.has("vision")) tags.push("vision");
  if (features.has("code") || CODE_NAME.test(String(entry?.id ?? ""))) tags.push("code");
  if (features.has("reasoning")) tags.push("reasoning");
  if (inputs.includes("video")) tags.push("video");
  if (inputs.includes("audio") || features.has("audio")) tags.push("audio");
  if (features.has("e2ee") || features.has("tee_attestation") || String(entry?.id ?? "").startsWith("e2ee-")) tags.push("private");
  return tags;
}

export function parseModels(data) {
  const models = new Map();
  for (const entry of Array.isArray(data?.data) ? data.data : []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const prompt = Number(entry?.pricing?.prompt);
    const completion = Number(entry?.pricing?.completion);
    const arch = entry?.architecture;
    // Text out and text accepted, and able to cap its answer: anything else cannot be priced or bounded here.
    // A model that also reads images or files (modality "text+image->text") still answers plain text questions.
    const [from, to] = String(arch?.modality ?? "").split("->");
    const inputs = arch?.input_modalities ?? from.split("+");
    const outputs = arch?.output_modalities ?? to?.split("+") ?? [];
    if (!id || !Number.isFinite(prompt) || !Number.isFinite(completion) || !(prompt >= 0) || !(completion >= 0)) continue;
    if (!inputs.includes("text") || outputs.length !== 1 || outputs[0] !== "text") continue;
    if (!entry.supported_parameters?.includes("max_tokens")) continue;
    models.set(id, { id, name: String(entry.name || id), provider: String(entry.provider || ""),
      contextLength: Number(entry.context_length) || 0, promptUsdPerToken: prompt, completionUsdPerToken: completion,
      ...(prompt <= 0 || completion <= 0 ? { listZero: true } : {}),
      tags: capabilities(entry, inputs), params: entry.supported_parameters.map(String) });
  }
  return models;
}

// Image models: text in, one image out, priced per image, per megapixel or per token. Edits, background removal and
// upscaling take an image in and are another service (Surplus lists them as text->image all the same, so they are
// detected by name).
const OTHER_SERVICE = /edit|remover|upscale/i;
const METERINGS = new Set(["per_image", "per_megapixel", "per_token"]);
export function parseImageModels(data) {
  const models = new Map();
  for (const entry of Array.isArray(data?.data) ? data.data : []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const arch = entry?.architecture ?? {};
    const inputs = arch.input_modalities ?? String(arch.modality ?? "").split("->")[0].split("+");
    const outputs = arch.output_modalities ?? [String(arch.modality ?? "").split("->")[1]];
    if (!id || OTHER_SERVICE.test(id) || !METERINGS.has(entry.metering)) continue;
    if (inputs.length !== 1 || inputs[0] !== "text" || outputs.length !== 1 || outputs[0] !== "image") continue;
    const image = Number(entry.pricing?.image), prompt = Number(entry.pricing?.prompt), completion = Number(entry.pricing?.completion);
    if (entry.metering !== "per_token" && !(image > 0)) continue;
    if (entry.metering === "per_token" && !(completion > 0 && prompt >= 0)) continue;
    models.set(id, { id, name: String(entry.name || id), provider: String(entry.provider || ""), metering: entry.metering,
      imageUsd: image > 0 ? image : 0, promptUsdPerToken: prompt || 0, completionUsdPerToken: completion || 0,
      sizes: Array.isArray(entry.sizes) && entry.sizes.length ? entry.sizes.map(String) : null,
      params: Array.isArray(entry.supported_parameters) ? entry.supported_parameters.map(String) : [] });
  }
  return models;
}

// Voice models, from the same list: text to speech priced per 1000 characters, speech to text per minute of audio.
export function parseVoiceModels(data) {
  const speech = new Map(), transcription = new Map();
  for (const entry of Array.isArray(data?.data) ? data.data : []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const modality = entry?.architecture?.modality;
    const price = Number(entry?.pricing?.image), unit = entry?.pricing?.media_unit;
    if (!id || OTHER_SERVICE.test(id) || !(price > 0)) continue;
    const model = { id, name: String(entry.name || id), provider: String(entry.provider || ""), usdPerUnit: price,
      voices: Array.isArray(entry.voices) && entry.voices.length ? entry.voices.map(String) : null };
    if (modality === "text->audio" && unit === "1K characters") speech.set(id, model);
    if (modality === "audio->text" && unit === "minute") transcription.set(id, model);
  }
  return { speech, transcription };
}

// Video models, from the same list: text to video, priced per job (Surplus runs them as asynchronous jobs).
export function parseVideoModels(data) {
  const models = new Map();
  for (const entry of Array.isArray(data?.data) ? data.data : []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const params = Array.isArray(entry?.supported_parameters) ? entry.supported_parameters.map(String) : [];
    const price = Number(entry?.pricing?.image);
    if (!id || OTHER_SERVICE.test(id) || entry?.architecture?.modality !== "video") continue;
    if (!params.includes("text-to-video") || entry?.pricing?.media_unit !== "job" || !(price > 0)) continue;
    const list = (value) => (Array.isArray(value) && value.length ? value.map(String) : null);
    models.set(id, { id, name: String(entry.name || id), provider: String(entry.provider || ""), usdPerJob: price,
      durations: Array.isArray(entry.durations_seconds) && entry.durations_seconds.length ? entry.durations_seconds.map(Number) : null,
      resolutions: list(entry.resolutions), aspectRatios: list(entry.aspect_ratios), audio: params.includes("audio") });
  }
  return models;
}

// What Surplus's trusted sellers ask per model, as a share of list price (best_trusted_offer_discount_pct). Measured
// on 12 October it was the closest of Surplus's figures to what answers really cost; the best offer was not.
function parseMarket(data) {
  const market = new Map();
  for (const entry of Array.isArray(data?.data?.markets) ? data.data.markets : []) {
    const discount = entry?.best_trusted_offer_discount_pct;
    if (typeof entry?.model === "string" && typeof discount === "number" && discount >= 0 && discount <= 100)
      market.set(entry.model, { trustedShare: (100 - discount) / 100 });
  }
  return market;
}

// Whether a model can be answered right now: some offer in its order book is trusted (the key routes to trusted
// sellers only), healthy and available, and not from a provider the key blocks. A model with none is not offered:
// choosing it would only end in an error. Measured on 12 October: 39 of 227 listed models had no such offer.
function qualifies(offer, blocked, id) {
  const model = offer?.model ?? offer?.model_id;
  if (model != null && String(model).toLowerCase() !== String(id).toLowerCase()) return false;
  return offer?.trusted === true && offer?.healthy === true && offer?.available === true
    && !(typeof offer.cap_remaining === "number" && offer.cap_remaining <= 0)
    && !blocked.has(String(offer.provider_id ?? "").toLowerCase());
}
export function canServe(book, blocked, id) {
  if (!matchesBook(book, id)) return false;
  const offers = book?.data?.offers ?? book?.offers ?? [];
  return offers.some((o) => qualifies(o, blocked, id));
}

// The cheapest share of list price among a model's qualifying offers (share = (100 - discount_pct) / 100), or
// null when none qualifies or names a usable discount. This is what Surplus could really charge if told to route
// there (catalogue.mjs's `guardShare`, pricing.mjs's `priceGuard`), not the best offer overall: an offer that is
// not trusted, healthy, available or from a blocked provider is never actually reachable.
export function cheapestShare(book, blocked, id) {
  if (!matchesBook(book, id)) return null;
  const offers = book?.data?.offers ?? book?.offers ?? [];
  let best = null;
  for (const o of offers) {
    if (!qualifies(o, blocked, id)) continue;
    const discount = Number(o?.discount_pct);
    if (!(discount >= 0 && discount <= 100)) continue;
    const share = (100 - discount) / 100;
    if (best === null || share < best) best = share;
  }
  return best;
}

// The ceiling share Surplus is bound to for a model, and the X-Min-Discount header value that binds it: the
// cheapest qualifying share, rounded up to a whole percent so the header asks for an integer, plus a small buffer
// (config.priceBufferPp, default 1 percentage point) for the market to move between quote and payment, capped at
// list price. No guard share known (book not read, model unknown) prices at list (share 1, no header sent): the
// ceiling still holds, just without Surplus being told to beat it.
export function priceGuard(catalogue, id, bufferPp) {
  const cheapest = catalogue?.guardShare ? catalogue.guardShare(id) : null;
  if (cheapest === null || cheapest === undefined) return { share: 1, minDiscount: null };
  const share = Math.min(1, (Math.ceil(cheapest * 100) + bufferPp) / 100);
  return { share, minDiscount: share < 1 ? 100 - Math.round(share * 100) : null };
}

// Both lists are read from Surplus, which takes a second or three; a visitor must never wait for that. What is
// cached is served at once even when it is old, and one refresh at a time runs in the background. Only the very
// first read, with nothing cached yet, waits.
export class ModelCatalogue {
  constructor({ url, fetchImpl = fetch, now = Date.now, blocked = [], unservableTtlMs = 15 * 60 * 1000, priceRejectedTtlMs = 120_000, liveDiscountTtlMs = 30_000, neverHide = [], suspensionsFile = null }) {
    Object.assign(this, { url, fetchImpl, now, unservableTtlMs });
    this.unservable = new Map();
    this.sellers = new Map();
    this.neverHide = new Set([...NEVER_HIDE, ...neverHide]);
    this.suspensionsFile = suspensionsFile;
    this.rejections = new Map();
    this.rejectionSeq = 0;
    if (unservableTtlMs > 0) for (const [id, r] of readSuspensions(suspensionsFile)) {
      if (this.neverHide.has(id)) continue;
      const { until, ...record } = r;
      this.rejections.set(id, record);
      if (until > this.now()) this.unservable.set(id, until);
    }
    Object.assign(this, { priceRejectedTtlMs, liveDiscountTtlMs });
    this.priceRejected = new Map();
    this.liveBooks = new Map();
    this.loadingLiveBooks = new Map();
    this.blocked = new Set(blocked.map((p) => String(p).toLowerCase()));
    this.served = null;  // ids of the models that can be answered now; null until first read
    this.guardShares = new Map();  // cheapest qualifying share of list per model id, from the same order books
    this.servedAt = 0;
    this.loadingServed = null;
    this.models = null;
    this.rawModels = null;
    this.bookPrices = new Map();
    this.images = null;   // image models, from the same list
    this.voice = null;    // { speech, transcription } models, from the same list
    this.videos = null;   // text-to-video models, from the same list
    this.videoBooks = new Map();  // per-model counts, including unknown reads, so an outage is not hammered
    this.loadingVideoBooks = new Map();
    this.videoSellers = null;
    this.videoSellersAt = 0;
    this.loadingVideoServed = null;
    this.loadedAt = 0;
    this.prices = null;
    this.pricesAt = 0;
    this.loadingModels = null;
    this.loadingPrices = null;
  }

  // One request in flight at a time; a failed refresh keeps what was cached and is retried at the next read.
  loadModels() {
    this.loadingModels ??= (async () => {
      try {
        const response = await this.fetchImpl(`${this.url}/v1/models`, { signal: AbortSignal.timeout(10_000) });
        const body = response.ok ? await response.json().catch(() => null) : null;
        const models = parseModels(body), images = parseImageModels(body);
        if (models.size) { this.rawModels = models; this.decorate(); this.loadedAt = this.now(); }
        if (images.size) this.images = images;
        const voice = parseVoiceModels(body);
        if (voice.speech.size) this.voice = voice;
        const videos = parseVideoModels(body);
        if (videos.size) this.videos = videos;
      } catch { /* keep the last list: a failed refresh must not take the endpoint down */ }
      finally { this.loadingModels = null; }
    })();
    return this.loadingModels;
  }

  decorate() {
    this.models = new Map([...(this.rawModels ?? [])].map(([id, model]) => {
      if (!model.listZero) return [id, model];
      const price = derivedPrice(id, this.bookPrices.get(id));
      return [id, price ? { ...model, priceBasis: "reference",
        promptUsdPerToken: model.promptUsdPerToken > 0 ? model.promptUsdPerToken : price.inputUsdPerToken,
        completionUsdPerToken: model.completionUsdPerToken > 0 ? model.completionUsdPerToken : price.outputUsdPerToken }
        : { ...model, unpriced: true }];
    }));
  }

  bookPrice(id) { return this.bookPrices.get(id) ?? null; }

  loadPrices() {
    this.loadingPrices ??= (async () => {
      try {
        const response = await this.fetchImpl(`${this.url}/api/marketplace`, { signal: AbortSignal.timeout(15_000) });
        const prices = response.ok ? parseMarket(await response.json().catch(() => null)) : new Map();
        if (prices.size) { this.prices = prices; this.pricesAt = this.now(); }
      } catch { /* keep the last prices */ }
      finally { this.loadingPrices = null; }
    })();
    return this.loadingPrices;
  }

  // One order book per model, read slowly: read fast, Surplus answers 429, or 200 with books whose offers all look
  // unhealthy (seen on 12 October). So two at a time with a pause, about a minute for all of them; a book that
  // cannot be read keeps that model's last answer, or offers it; and a pass that would offer far fewer models
  // than the last one (or than a quarter of them, the first time) is thrown away whole. An unreadable or odd
  // book is no reason to empty the picker, and a model that turns out unable to answer costs nothing.
  loadServed(pauseMs = 400) {
    this.loadingServed ??= (async () => {
      try {
        const ids = [...((this.models ?? (await this.loadModels(), this.models)) ?? new Map()).keys()];
        const served = new Set();
        const guards = new Map();
        const sellers = new Map();
        const readable = new Map();
        let next = 0;
        const worker = async () => {
          while (next < ids.length) {
            const id = ids[next++];
            const seenSeq = this.rejectionSeq;
            try {
              const response = await this.fetchImpl(`${this.url}/api/markets/${encodeURIComponent(id)}`,
                                                    { signal: AbortSignal.timeout(10_000) });
              const book = response.ok ? await response.json() : null;
              if (this.rawModels?.get(id)?.listZero && book && matchesBook(book, id)) {
                const price = bookPrices(book, this.blocked);
                if (price) this.bookPrices.set(id, price);
              }
              if (book ? canServe(book, this.blocked, id) : (this.served?.has(id) ?? true)) served.add(id);
              const offers = book?.data?.offers ?? book?.offers;
              if (book && Array.isArray(offers) && matchesBook(book, id)) {
                readable.set(id, seenSeq);
                sellers.set(id, new Set((book?.data?.offers ?? book?.offers ?? [])
                  .filter(o => matchesBook(book, id) && qualifies(o, this.blocked, id))
                  .map(o => String(o.provider_id ?? "")).filter(validId)));
              } else if (this.sellers.has(id)) sellers.set(id, this.sellers.get(id));
              const share = book ? cheapestShare(book, this.blocked, id) : null;
              if (share !== null) guards.set(id, share);
              else if (!book && this.guardShares.has(id)) guards.set(id, this.guardShares.get(id));
            } catch {
              if (this.served?.has(id) ?? true) served.add(id);
              if (this.sellers.has(id)) sellers.set(id, this.sellers.get(id));
              if (this.guardShares.has(id)) guards.set(id, this.guardShares.get(id));
            }
            if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
          }
        };
        await Promise.all(Array.from({ length: 2 }, worker));
        this.decorate();
        const floor = this.served ? this.served.size / 2 : ids.length / 4;
        if (ids.length && served.size >= floor) { this.served = served; this.guardShares = guards; this.sellers = sellers; this.servedAt = this.now();
          for (const [id, r] of this.rejections) {
            // Only a book requested after the latest rejection says anything about that rejection.
            if (!(readable.get(id) >= (r.seq ?? 0))) continue;
            if (!served.has(id)) { r.gone = true; continue; }
            // Rejected before any book was read: this pass only sets the seller baseline, it proves no recovery.
            if (r.unknown) {
              const all = [...(sellers.get(id) ?? [])];
              Object.assign(r, { providers: all.slice(0, MAX_PROVIDERS), truncated: all.length > MAX_PROVIDERS, unknown: false });
              if (r.gone) this.noteAnswered(id);
              continue;
            }
            // A truncated provider list cannot tell which sellers are new, so it only releases through gone/answers.
            const fresh = !r.truncated && [...(sellers.get(id) ?? [])].some(p => !r.providers.includes(p));
            if (r.gone || fresh) this.noteAnswered(id);
          }
          this.saveSuspensions(); }
        else if (ids.length) this.servedAt = this.now();  // keep what was offered; try again next time
      } finally { this.loadingServed = null; }
    })();
    return this.loadingServed;
  }

  // Health is a free public read, shared with the slow listing pass so a buyer and the picker do not race two
  // reads of the same book. Unknown is different from zero: an outage must keep the last answer, not invent a
  // seller shortage. Cache failed attempts too, so repeated buyers cannot turn an outage into a request storm.
  async videoHealth(id) {
    const cached = this.videoBooks.get(id);
    if (cached && this.now() - cached.at < VIDEO_HEALTH_TTL_MS) return cached.count;
    if (!this.loadingVideoBooks.has(id)) {
      const pending = (async () => {
        let count = cached?.count ?? null;
        try {
          const response = await this.fetchImpl(`${this.url}/api/markets/${encodeURIComponent(id)}`,
                                                { signal: AbortSignal.timeout(10_000) });
          const book = response.ok ? await response.json() : null;
          const offers = book?.data?.offers ?? book?.offers;
          if (Array.isArray(offers)) count = offers.filter((o) => qualifies(o, this.blocked)).length;
        } catch { /* keep the last count; unreadable is not the same as no qualifying offers */ }
        this.videoBooks.set(id, { count, at: this.now() });
        return count;
      })();
      this.loadingVideoBooks.set(id, pending);
    }
    try { return await this.loadingVideoBooks.get(id); }
    finally { this.loadingVideoBooks.delete(id); }
  }

  // Like the chat pass, two workers pause between books to avoid Surplus's rate limit. Publish a complete pass
  // at once: readers keep the old map while it refreshes, and an unreadable first book stays absent (unknown).
  loadVideoServed(pauseMs = 400) {
    this.loadingVideoServed ??= (async () => {
      try {
        const ids = [...(await this.videoModels()).keys()];
        const served = new Map();
        let next = 0;
        const worker = async () => {
          while (next < ids.length) {
            const id = ids[next++];
            const count = await this.videoHealth(id);
            if (count !== null) served.set(id, count);
            if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
          }
        };
        await Promise.all(Array.from({ length: 2 }, worker));
        this.videoSellers = served;
      } catch { /* keep the last map if even the model list cannot be read */ }
      finally { this.videoSellersAt = this.now(); this.loadingVideoServed = null; }
    })();
    return this.loadingVideoServed;
  }

  async videoServed(pauseMs = 400) {
    if (!this.videoSellers) await this.loadVideoServed(pauseMs);
    else if (this.now() - this.videoSellersAt >= VIDEO_HEALTH_TTL_MS) this.loadVideoServed(pauseMs);
    return this.videoSellers ?? new Map();
  }

  // Routing can reject a model whose public book still looks healthy. Keep that paid failure briefly so
  // subsequent buyers are not asked to sign a payment that cannot produce an answer. Unknown ids are bounded
  // too: neither a failing seller nor arbitrary callers should make this process retain ids without limit.
  saveSuspensions() {
    if (!this.suspensionsFile) return;
    clearTimeout(this.suspensionsTimer);
    this.suspensionsTimer = setTimeout(() => {
      const data = Object.fromEntries([...this.rejections].map(([id, r]) => [id, { count: r.count, lastAt: r.lastAt, providers: r.providers, truncated: r.truncated === true || r.unknown === true, gone: r.gone, until: this.unservable.get(id) ?? 0 }]));
      this.suspensionsWrite = (this.suspensionsWrite ?? Promise.resolve()).then(() => writeSuspensions(this.suspensionsFile, data));
    }, 20);
    this.suspensionsTimer.unref?.();
  }

  noteRejected(id) {
    if (!(this.unservableTtlMs > 0) || !validId(id) || this.neverHide.has(id)) {
      this.markUnservable(id); return;
    }
    // One old rejection is not a streak: it only counts toward suspension while it is recent.
    const before = this.rejections.get(id);
    const stale = before && before.count < 2 && this.now() - before.lastAt > STREAK_MS;
    const count = Math.min(1000000, (stale ? 0 : before?.count ?? 0) + 1);
    this.rejections.delete(id);
    while (this.rejections.size >= 300) {
      const oldest = this.rejections.keys().next().value;
      this.rejections.delete(oldest); this.unservable.delete(oldest);
    }
    this.rejections.set(id, { count, seq: ++this.rejectionSeq, lastAt: this.now(), providers: [...(this.sellers.get(id) ?? [])].slice(0, MAX_PROVIDERS),
      truncated: (this.sellers.get(id)?.size ?? 0) > MAX_PROVIDERS, unknown: !this.sellers.has(id), gone: false });
    this.markUnservable(id, Math.min(7200000, this.unservableTtlMs * 2 ** Math.min(count - 1, 30)));
    this.saveSuspensions();
  }

  noteAnswered(id) {
    const changed = this.rejections.delete(id);
    const marked = this.unservable.delete(id);
    if (changed || marked) this.saveSuspensions();
  }

  isSuspended(id) { return !this.neverHide.has(id) && (this.rejections.get(id)?.count ?? 0) >= 2; }
  suspensionSnapshot() { return new Map([...this.rejections].filter(([id]) => this.isSuspended(id))); }
  async listable(id) { return !this.isSuspended(id) && !(this.unservable.get(id) > this.now()) && (!this.served || this.served.has(id)); }

  markUnservable(id, ttlMs = this.unservableTtlMs) {
    if (!(this.unservableTtlMs > 0) || !(ttlMs > 0)) return;
    for (const [key, expiry] of this.unservable) if (expiry <= this.now()) this.unservable.delete(key);
    this.unservable.delete(id);
    while (this.unservable.size >= 1000) this.unservable.delete(this.unservable.keys().next().value);
    this.unservable.set(id, this.now() + ttlMs);
  }

  markPriceRejected(id, { bestDiscountPct = null } = {}) {
    for (const [key, value] of this.priceRejected) if (value.expiry <= this.now()) this.priceRejected.delete(key);
    this.priceRejected.delete(id);
    if (!(this.priceRejectedTtlMs > 0)) return;
    while (this.priceRejected.size >= 1000) this.priceRejected.delete(this.priceRejected.keys().next().value);
    this.priceRejected.set(id, { bestDiscountPct, expiry: this.now() + this.priceRejectedTtlMs });
  }

  isPriceRejected(id) {
    if (this.priceRejected.get(id)?.expiry > this.now()) return true;
    this.priceRejected.delete(id);
    return false;
  }

  async liveDiscount(id) {
    const cached = this.liveBooks.get(id);
    if (cached && cached.expiry > this.now()) return cached.share;
    if (this.loadingLiveBooks.has(id)) return this.loadingLiveBooks.get(id);
    const task = (async () => {
      let share = null;
      try {
        const response = await this.fetchImpl(`${this.url}/api/markets/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(3000) });
        if (response.ok) share = cheapestShare(await response.json(), this.blocked, id);
      } catch { /* An unreadable book must not prevent a quote. */ }
      this.liveBooks.delete(id);
      while (this.liveBooks.size >= 1000) this.liveBooks.delete(this.liveBooks.keys().next().value);
      this.liveBooks.set(id, { share, expiry: this.now() + this.liveDiscountTtlMs });
      return share;
    })();
    this.loadingLiveBooks.set(id, task);
    try { return await task; } finally { this.loadingLiveBooks.delete(id); }
  }

  isUnservable(id) {
    const expiry = this.unservable.get(id);
    if (expiry > this.now()) return true;
    this.unservable.delete(id);
    return false;
  }

  unservableSnapshot() {
    return new Map([...this.unservable].filter(([, expiry]) => expiry > this.now()));
  }

  unservableRetryAfter(id) {
    return this.isUnservable(id) ? Math.min(3600, Math.max(30, Math.ceil((this.unservable.get(id) - this.now()) / 1000))) : 30;
  }

  // Whether a model can be answered now: true until the order books have been read once.
  async canAnswer(id) {
    if (this.isUnservable(id)) return false;
    if (this.served && this.now() - this.servedAt >= MARKET_TTL_MS) this.loadServed();
    return this.served ? this.served.has(id) : true;
  }

  // The cheapest qualifying share of list price last seen for a model, read synchronously from the order books
  // (same pass as `served`): null until read, or when none qualified. Used to price a ceiling's worst case closer
  // to what Surplus would really charge (pricing.mjs's `priceGuard`), never to lower it unguarded.
  guardShare(id) {
    // A reference-priced model is bought at an absolute price, never against a discount: its list price is 0, so a
    // discount_pct on its book (Surplus has none today) must not lower the ceiling or send X-Min-Discount.
    if (this.rawModels?.get(id)?.listZero) return null;
    return this.guardShares.has(id) ? this.guardShares.get(id) : null;
  }

  async all() {
    if (!this.models) await this.loadModels();
    else if (this.now() - this.loadedAt >= TTL_MS) this.loadModels();
    if (!this.models) throw new UnknownModel("The model list is unavailable. Try again.");
    return this.models;
  }

  // The trusted sellers' share of list price per model id, or an empty map when the marketplace cannot be read.
  async market() {
    if (!this.prices) await this.loadPrices();
    else if (this.now() - this.pricesAt >= MARKET_TTL_MS) this.loadPrices();
    return this.prices ?? new Map();
  }

  // Read both now, then keep them fresh, so the first visitor after a start and every one after finds them ready.
  async warm(everyMs = MARKET_TTL_MS / 2) {
    await Promise.all([this.loadModels(), this.loadPrices()]);
    await this.loadServed();
    await this.videoServed();
    this.timer ??= setInterval(() => {
      this.loadModels(); this.loadPrices();
      if (this.now() - this.servedAt >= MARKET_TTL_MS) this.loadServed();
      if (this.now() - this.videoSellersAt >= VIDEO_HEALTH_TTL_MS) this.loadVideoServed();
    }, everyMs);
    this.timer.unref?.();
  }

  async resolve(id, { allowUnpriced = false } = {}) {
    const model = (await this.all()).get(String(id ?? "").trim());
    if (!model) throw new UnknownModel("That model is not available.");
    if (model.unpriced === true && !allowUnpriced) throw new UnpricedModel();
    return model;
  }

  async list() {
    // Observed prices are shares of list price and cannot supply a missing list price.
    return [...(await this.all()).values()].filter(m => m.unpriced !== true && !this.isSuspended(m.id)).sort((a, b) => a.completionUsdPerToken - b.completionUsdPerToken);
  }

  async imageModels() {
    await this.all().catch(() => null);
    if (!this.images) throw new UnknownModel("The image model list is unavailable. Try again.");
    return this.images;
  }

  async videoModels() {
    await this.all().catch(() => null);
    if (!this.videos) throw new UnknownModel("The video model list is unavailable. Try again.");
    return this.videos;
  }

  async resolveVideo(id) {
    const model = (await this.videoModels()).get(String(id ?? "").trim());
    if (!model) throw new UnknownModel("That video model is not available. See GET /v1/video/models.");
    return model;
  }

  async voiceModels() {
    await this.all().catch(() => null);
    if (!this.voice) throw new UnknownModel("The voice model list is unavailable. Try again.");
    return this.voice;
  }

  async resolveSpeech(id) {
    const model = (await this.voiceModels()).speech.get(String(id ?? "").trim());
    if (!model) throw new UnknownModel("That speech model is not available. See GET /v1/audio/models.");
    return model;
  }

  async resolveImage(id) {
    const model = (await this.imageModels()).get(String(id ?? "").trim());
    if (!model) throw new UnknownModel("That image model is not available. See GET /v1/images/models.");
    return model;
  }
}

// Shared by all paid text formats; match the machine code, never the upstream's human message.
export function markUnservable(catalogue, model, error, log) {
  if (error.code === "minimum_discount_not_met") catalogue?.markPriceRejected?.(model, { bestDiscountPct: error.bestDiscountPct });
  if (error.code !== "no_healthy_sellers") return;
  if (catalogue?.noteRejected) catalogue.noteRejected(model);
  else catalogue?.markUnservable?.(model);
  if (catalogue?.isUnservable?.(model)) {
    const minutes = catalogue.unservableTtlMs / 60_000;
    log(`singit-ask: model ${model} marked unservable for ${minutes} min (no_healthy_sellers)`);
  }
  if (catalogue?.isSuspended?.(model)) log(`singit-ask: model ${model} suspended after ${catalogue.rejections.get(model).count} consecutive no_healthy_sellers, retry in ${Math.ceil((catalogue.unservable.get(model) - catalogue.now()) / 60000)} min`);
}

export function unservableError(catalogue, id, ErrorClass) {
  const error = new ErrorClass(503, "No seller can serve that model right now. Nothing was paid; try again later.");
  error.retryAfter = catalogue?.unservableRetryAfter?.(id) ?? 30;
  return error;
}

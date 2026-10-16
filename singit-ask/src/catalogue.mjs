// Every text model Surplus sells, read from Surplus itself: a hand-kept list of 400+ models would be stale
// the day a seller adds one. The list is public; the prices are per token in USD.

const TTL_MS = 6 * 60 * 60 * 1000;
// The marketplace's cheapest offers move; the page showing them is public and large (about 1.7 MB), so ten minutes.
const MARKET_TTL_MS = 10 * 60 * 1000;

export class UnknownModel extends Error {}

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

function parseModels(data) {
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
    if (!id || !(prompt >= 0) || !(completion >= 0)) continue;
    if (!inputs.includes("text") || outputs.length !== 1 || outputs[0] !== "text") continue;
    if (!entry.supported_parameters?.includes("max_tokens")) continue;
    models.set(id, { id, name: String(entry.name || id), provider: String(entry.provider || ""),
      contextLength: Number(entry.context_length) || 0, promptUsdPerToken: prompt, completionUsdPerToken: completion,
      tags: capabilities(entry, inputs) });
  }
  return models;
}

// Image models: text in, one image out, priced per image, per megapixel or per token. Edits, background removal and
// upscaling take an image in and are another service (Surplus lists them as text->image all the same, so they are
// told by name); models made for adult or uncensored output are not sold.
const NOT_SOLD = /lustify|uncensored|nsfw|edit|remover|upscale/i;
const METERINGS = new Set(["per_image", "per_megapixel", "per_token"]);
export function parseImageModels(data) {
  const models = new Map();
  for (const entry of Array.isArray(data?.data) ? data.data : []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const arch = entry?.architecture ?? {};
    const inputs = arch.input_modalities ?? String(arch.modality ?? "").split("->")[0].split("+");
    const outputs = arch.output_modalities ?? [String(arch.modality ?? "").split("->")[1]];
    if (!id || NOT_SOLD.test(id) || !METERINGS.has(entry.metering)) continue;
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
function canServe(book, blocked) {
  const offers = book?.data?.offers ?? book?.offers ?? [];
  return offers.some((o) => o?.trusted === true && o?.healthy === true && o?.available === true
                             && !blocked.has(String(o.provider_id ?? "").toLowerCase()));
}

// Both lists are read from Surplus, which takes a second or three; a visitor must never wait for that. What is
// cached is served at once even when it is old, and one refresh at a time runs in the background. Only the very
// first read, with nothing cached yet, waits.
export class ModelCatalogue {
  constructor({ url, fetchImpl = fetch, now = Date.now, blocked = [] }) {
    Object.assign(this, { url, fetchImpl, now });
    this.blocked = new Set(blocked.map((p) => String(p).toLowerCase()));
    this.served = null;  // ids of the models that can be answered now; null until first read
    this.servedAt = 0;
    this.loadingServed = null;
    this.models = null;
    this.images = null;   // image models, from the same list
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
        if (models.size) { this.models = models; this.loadedAt = this.now(); }
        if (images.size) this.images = images;
      } catch { /* keep the last list: a failed refresh must not take the endpoint down */ }
      finally { this.loadingModels = null; }
    })();
    return this.loadingModels;
  }

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
        let next = 0;
        const worker = async () => {
          while (next < ids.length) {
            const id = ids[next++];
            try {
              const response = await this.fetchImpl(`${this.url}/api/markets/${encodeURIComponent(id)}`,
                                                    { signal: AbortSignal.timeout(10_000) });
              const book = response.ok ? await response.json() : null;
              if (book ? canServe(book, this.blocked) : (this.served?.has(id) ?? true)) served.add(id);
            } catch { if (this.served?.has(id) ?? true) served.add(id); }
            if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
          }
        };
        await Promise.all(Array.from({ length: 2 }, worker));
        const floor = this.served ? this.served.size / 2 : ids.length / 4;
        if (ids.length && served.size >= floor) { this.served = served; this.servedAt = this.now(); }
        else if (ids.length) this.servedAt = this.now();  // keep what was offered; try again next time
      } finally { this.loadingServed = null; }
    })();
    return this.loadingServed;
  }

  // Whether a model can be answered now: true until the order books have been read once.
  async canAnswer(id) {
    if (this.served && this.now() - this.servedAt >= MARKET_TTL_MS) this.loadServed();
    return this.served ? this.served.has(id) : true;
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
    this.timer ??= setInterval(() => {
      this.loadModels(); this.loadPrices();
      if (this.now() - this.servedAt >= MARKET_TTL_MS) this.loadServed();
    }, everyMs);
    this.timer.unref?.();
  }

  async resolve(id) {
    const model = (await this.all()).get(String(id ?? "").trim());
    if (!model) throw new UnknownModel("That model is not available.");
    return model;
  }

  async list() {
    return [...(await this.all()).values()].sort((a, b) => a.completionUsdPerToken - b.completionUsdPerToken);
  }

  async imageModels() {
    await this.all().catch(() => null);
    if (!this.images) throw new UnknownModel("The image model list is unavailable. Try again.");
    return this.images;
  }

  async resolveImage(id) {
    const model = (await this.imageModels()).get(String(id ?? "").trim());
    if (!model) throw new UnknownModel("That image model is not available. See GET /v1/images/models.");
    return model;
  }
}

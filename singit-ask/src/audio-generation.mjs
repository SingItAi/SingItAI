import { x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { declareDiscoveryExtension } from './binary-discovery.mjs';
import { attachPaymentFailureCodes } from './payment-failure-hooks.mjs';
import { addPaymentRoute, isDiscoveryProbe } from './metered.mjs';
import { ASSET, BASE, ICON_URL, discoveryTags } from './pricing.mjs';
import { imagePrice } from './images.mjs';
import { paymentDigest, reservePayment } from './media-payment-replay.mjs';
import { runMediaJob } from './media-jobs.mjs';

export const SFX_ROUTE = '/v1/audio/sound-effects';
export const MUSIC_ROUTE = '/v1/audio/generations';
export const MEDIA_MODELS_ROUTE = '/v1/audio/generation-models';
export const AUDIO_ROUTES = [SFX_ROUTE, MUSIC_ROUTE];
// Pinned from the owner's offline Surplus catalogue, 2026-11-05. Prices are per job.
export const AUDIO_MODELS = Object.freeze([
  { id: 'elevenlabs/sound-effects-v2', upstream: 'venice-elevenlabs-sound-effects-v2', kind: 'sound-effects', listAtomic: 20000 },
  { id: 'sonilo/sound-effects-1.0', upstream: 'sonilo-sound-effects-v1-0', kind: 'sound-effects', listAtomic: 2070 },
  { id: 'minimax/music-2', upstream: 'venice-minimax-music-v2', kind: 'music', listAtomic: 40000, lyrics_required: true, instrumental: false },
  { id: 'minimax/music-2.5', upstream: 'venice-minimax-music-v25', kind: 'music', listAtomic: 240000, lyrics_required: false, instrumental: true },
  { id: 'minimax/music-2.6', upstream: 'venice-minimax-music-v26', kind: 'music', listAtomic: 240000, lyrics_required: false, instrumental: true },
].map(Object.freeze));
export const audioPrices = () => AUDIO_MODELS.map(m => ({ ...m, route: m.kind === 'music' ? MUSIC_ROUTE : SFX_ROUTE,
  exact: Object.fromEntries([['base', BASE]].map(([name, network]) => {
    const p = imagePrice(m.listAtomic, network);
    return [name, { ceilingAtomic: p.totalAtomic, usd: Number(p.totalAtomic) / 1e6 }];
  })) }));
// Fail closed: an operator-supplied synchronous readiness snapshot must confirm credit,
// submission support, current flat pricing and a healthy route for each upstream model.
// No live probe is made by discovery. Missing/unknown readiness is unavailable.
export function availableAudioPrices(config, catalogue) {
  if (config.audioSold !== true || !config.surplusKey || !config.surplusUrl || !config.payToBase) return [];
  return audioPrices().filter(m => {
    try { return config.audioGenerationReady?.(m.upstream, { listAtomic: m.listAtomic }) === true
      && !catalogue?.isUnservable?.(m.upstream)
      && !catalogue?.isSuspended?.(m.upstream); } catch { return false; }
  });
}
const invalid = message => { throw Object.assign(new Error(message), { status: 422 }); };
export function readAudioGeneration(body, kind) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Send a JSON object.');
  const model = AUDIO_MODELS.find(m => m.id === (body.model ?? (kind === 'music' ? 'minimax/music-2' : 'elevenlabs/sound-effects-v2')) && m.kind === kind);
  if (!model) invalid('Unknown model for this route.');
  const field = kind === 'music' ? 'prompt' : 'text';
  const limit = kind === 'music' ? 2000 : 1000;
  if (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > limit) invalid(`${field} must contain 1–${limit} characters.`);
  const request = { model: model.id, [field]: body[field] };
  const duration = body.duration_seconds;
  const [min, max] = kind === 'music' ? [5, 240] : [0.5, 22];
  if (duration !== undefined) {
    if (!Number.isFinite(duration) || duration < min || duration > max) invalid(`duration_seconds must be ${min}–${max}.`);
    request.duration_seconds = duration;
  } else if (kind === 'music') request.duration_seconds = 60;
  if (kind === 'music') {
    if (body.lyrics !== undefined && (typeof body.lyrics !== 'string' || body.lyrics.length > 5000)) invalid('lyrics must be a string of up to 5000 characters.');
    if (model.lyrics_required && !body.lyrics?.trim()) invalid('This model requires lyrics.');
    if (body.instrumental !== undefined && (typeof body.instrumental !== 'boolean' || !model.instrumental)) invalid('This model does not support that instrumental parameter.');
    if (body.instrumental && body.lyrics?.trim()) invalid('Instrumental music cannot include lyrics.');
    if (body.lyrics !== undefined) request.lyrics = body.lyrics;
    if (body.instrumental !== undefined) request.instrumental = body.instrumental;
  } else if (body.response_format !== undefined) {
    if (!['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(body.response_format)) invalid('Unsupported response_format.');
    request.response_format = body.response_format;
  }
  return { model, request };
}
// Official music-generations fields; the buyer API retains text/lyrics/instrumental.
export function surplusAudioRequest(request) {
  const model = AUDIO_MODELS.find(m => m.id === request.model);
  const body = { model: model.upstream, prompt: request.prompt ?? request.text };
  for (const [publicField, upstreamField] of [['lyrics', 'lyrics_prompt'], ['instrumental', 'force_instrumental'], ['duration_seconds', 'duration_seconds']]) {
    if (request[publicField] !== undefined) body[upstreamField] = request[publicField];
  }
  return body;
}
export const audioSchema = kind => ({ type: 'object', required: [kind === 'music' ? 'prompt' : 'text'], properties: {
  model: { type: 'string', description: 'A public model id from the generation models list.', enum: AUDIO_MODELS.filter(m => m.kind === kind).map(m => m.id), default: kind === 'music' ? 'minimax/music-2' : 'elevenlabs/sound-effects-v2' },
  [kind === 'music' ? 'prompt' : 'text']: { type: 'string', minLength: 1, maxLength: kind === 'music' ? 2000 : 1000, description: kind === 'music' ? 'Describe the song to generate.' : 'Describe the sound effect to generate.' },
  duration_seconds: { type: 'number', description: 'Audio duration in seconds; flat price per job.', minimum: kind === 'music' ? 5 : 0.5, maximum: kind === 'music' ? 240 : 22, ...(kind === 'music' ? { default: 60 } : {}) },
  ...(kind === 'music' ? { lyrics: { type: 'string', maxLength: 5000, description: 'Required for music-2. Omit for instrumental.' }, instrumental: { type: 'boolean', description: 'Supported by music-2.5 and music-2.6 only.' } }
    : { response_format: { type: 'string', description: 'Preferred audio format (selection unconfirmed upstream); response Content-Type follows validated bytes.', enum: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'] } }),
} });
export const audioExample = kind => kind === 'music' ? { prompt: 'A gentle folk song', lyrics: 'Morning light across the sea', duration_seconds: 60 } : { text: 'Gentle rain on a tin roof', duration_seconds: 3 };
export const audioOpenapi = (paidErrors, invalidResponse) => Object.fromEntries(AUDIO_ROUTES.map((route, i) => {
  const kind = i ? 'music' : 'sound-effects';
  const prices = audioPrices().filter(m => m.kind === kind).map(m => m.exact.base.usd);
  return [route, { post: { operationId: i ? 'createMusic' : 'createSoundEffects', summary: i ? 'Generate music from a text prompt' : 'Generate sound effects from text',
    description: `Exact per job on Base only (Solana is refused): list price + 30% + network fee. Audio bytes, as with speech. Server polls up to ${i ? 180 : 60} seconds, then downloads at most ${i ? 25 : 5} MiB; any failure returns 503 without settlement. See ${MEDIA_MODELS_ROUTE} for prices and capabilities.`,
    security: [{ x402: [] }],
    'x-payment-info': { price: { mode: Math.min(...prices) === Math.max(...prices) ? 'fixed' : 'dynamic', currency: 'USD', min: String(Math.min(...prices)), max: String(Math.max(...prices)) }, protocols: [{ x402: {} }] },
    requestBody: { required: true, content: { 'application/json': { schema: audioSchema(kind), example: audioExample(kind) } } },
    responses: { 200: { description: 'Validated audio bytes; Content-Type follows detected audio format.', content: Object.fromEntries(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/mp4'].map(t => [t, { schema: { type: 'string', format: 'binary' } }])) },
      ...paidErrors({ exactTimeout: i ? 240 : 120, duplicate: true, noAnswer: 'No audio; no settlement', exampleMessage: 'No audio was delivered. You were not charged.', exampleCode: 'no_billable_answer' }), 422: invalidResponse } } }];
}));

export function addAudioGenerationRoutes(app, config, { facilitatorClient, publicClient, fetchImpl = fetch, log = console.error, open, catalogue }) {
  app.get(MEDIA_MODELS_ROUTE, open, (_req, res) => res.json({ object: 'list', data: availableAudioPrices(config, catalogue), defaults: { music: 'minimax/music-2', 'sound-effects': 'elevenlabs/sound-effects-v2' } }));
  for (const [i, route] of AUDIO_ROUTES.entries()) {
    const kind = i ? 'music' : 'sound-effects';
    const server = new x402ResourceServer(facilitatorClient).register(BASE, new ExactEvmScheme());
    attachPaymentFailureCodes(server);
    const priced = new WeakMap();
    // Runs before payment verification, including discovery GET/HEAD requests.
    app.use(route, (req, res, next) => {
      const models = availableAudioPrices(config, catalogue).filter(m => m.route === route);
      if (!models.length) {
        return res.status(503).json({ error: { type: 'upstream_error', code: 'no_billable_answer', message: 'Audio generation is unavailable. You were not charged.' } });
      }
      next();
    });
    app.post(route, (req, res, next) => {
      if (isDiscoveryProbe(req)) return next();
      try {
        const parsed = readAudioGeneration(req.body, kind);
        if (!availableAudioPrices(config, catalogue).some(m => m.id === parsed.model.id)) {
          return res.status(503).json({ error: { type: 'upstream_error', code: 'no_billable_answer', message: 'Audio generation is unavailable. You were not charged.' } });
        }
        priced.set(req.body, parsed); next();
      }
      catch (error) { res.status(422).json({ error: { type: 'invalid_request_error', code: 'invalid_request', message: error.message } }); }
    });
    const price = network => ctx => {
      const model = priced.get(ctx.adapter.getBody())?.model ?? AUDIO_MODELS[i ? 2 : 0];
      const amount = imagePrice(model.listAtomic, network).totalAtomic;
      return { asset: ASSET, amount, extra: { name: 'USD Coin', version: '2' } };
    };
    addPaymentRoute(app, { [`POST ${route}`]: {
      accepts: [BASE].map(network => ({ scheme: 'exact', network, payTo: config.payToBase, maxTimeoutSeconds: i ? 240 : 120, price: price(network) })),
      mimeType: 'audio/mpeg', description: i ? 'Music generation API: MiniMax songs or instrumental audio. USDC on Base only, no key.' : 'Sound effects API: ElevenLabs or Sonilo audio from text. USDC on Base only, no key.',
      serviceName: i ? 'SingIt Music' : 'SingIt Sound Effects', iconUrl: ICON_URL, tags: discoveryTags(kind, 'audio', 'base'),
      extensions: declareDiscoveryExtension({ bodyType: 'json', input: audioExample(kind), inputSchema: audioSchema(kind), output: { type: "audio/mpeg", format: "binary" } }),
    } }, server, { log, publicClient });
    app.post(route, async (req, res) => {
      const payment = JSON.parse(Buffer.from(req.get('payment-signature') ?? req.get('x-payment'), 'base64').toString());
      // Defense in depth: never hold a signed Solana transaction across an async job.
      if (payment.accepted.network !== BASE) return res.status(402).json({ error: { code: 'unsupported_network', message: 'Audio generation accepts Base only.' } });
      const digest = paymentDigest(payment);
      const reservation = reservePayment(digest);
      if (reservation === 'duplicate') return res.status(409).json({ error: { type: 'invalid_request_error', code: 'payment_duplicate', message: 'This payment was already used.' } });
      const fail = () => res.set('Retry-After', '30').status(503).json({ error: { type: 'upstream_error', code: 'no_billable_answer', message: 'No audio was delivered. You were not charged.' } });
      if (reservation === 'full') return fail();
      const { model, request } = priced.get(req.body);
      if (!availableAudioPrices(config, catalogue).some(m => m.id === model.id)) return fail();
      const started = Date.now();
      try {
        const { audio, contentType } = await runMediaJob({ baseUrl: config.surplusUrl, key: config.surplusKey,
          request: surplusAudioRequest(request), idempotencyKey: `singit-${digest}`, timeoutMs: i ? 180000 : 60000,
          maxBytes: (i ? 25 : 5) * 1024 * 1024, fetchImpl, ...config.mediaJobOptions });
        const billing = imagePrice(model.listAtomic, payment.accepted.network);
        res.set({ 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-SingIt-Charged-Atomic': billing.totalAtomic, 'X-SingIt-List-Atomic': billing.listAtomic });
        res.send(audio);
      } catch (error) {
        // Log only bounded diagnostic fields, never upstream messages or credentials.
        const safe = value => String(value ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
        // Upstream strings are logged only when they are known Surplus vocabulary.
        const known = (value, list) => list.includes(value) ? value : (value == null ? 'unknown' : 'other');
        const STATUSES = ['queued', 'running', 'processing', 'pending', 'succeeded', 'failed', 'canceled', 'cancelled', 'expired'];
        const CODES = ['invalid_request', 'invalid_request_error', 'provider_error', 'provider_unavailable', 'expired', 'execution_start_failed', 'unknown',
          'insufficient_credit', 'insufficient_balance', 'insufficient_allowance', 'account_frozen', 'org_frozen', 'org_closed', 'model_not_found',
          'no_sellers_for_model', 'no_healthy_sellers', 'rate_limit_exceeded', 'rate_limited', 'not_found', 'failed', 'canceled', 'upstream_error'];
        const http = Number.isInteger(error.upstreamStatus) ? error.upstreamStatus : 'unknown';
        log(`audio job fail ${kind} ${model.id} code=${safe(error.code)} job=${safe(error.jobId)} last=${known(error.lastStatus, STATUSES)} http=${http} upstream=${known(error.upstreamCode, CODES)} ms=${Date.now() - started}`);
        return fail();
      }
    });
  }
}

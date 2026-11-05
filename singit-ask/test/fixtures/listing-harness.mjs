import { BASE, SOLANA, createApp } from "../../src/app.mjs";
import { UnknownModel, parseImageModels, parseVoiceModels } from "../../src/catalogue.mjs";
import { MODEL_ROUTES } from "../../src/model-routes.mjs";

export const CONFIG = { payToSolana: "1".repeat(32),
  payToBase: "0x" + "1".repeat(40), audioGenerationReady: () => true, surplusKey: "fixture", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash", probeShare: "live" };
const chatModel = (id) => ({ id, name: id, provider: "test", contextLength: 1e6, promptUsdPerToken: 3e-6, completionUsdPerToken: 12e-6 });
const CHAT_IDS = new Set([CONFIG.model, "claude-sonnet-5.5", "gpt-5.5", ...MODEL_ROUTES.map((m) => m.id)]);
const IMAGES = parseImageModels({ data: [{ id: "venice-seedream-v5-lite", name: "Seedream", provider: "venice", metering: "per_image",
  pricing: { image: "0.05" }, sizes: ["1024x1024"],
  architecture: { modality: "text->image", input_modalities: ["text"], output_modalities: ["image"] },
  supported_parameters: ["prompt", "model", "n", "size", "response_format"] }] });
const VOICE = parseVoiceModels({ data: [{ id: "venice-kokoro-tts", architecture: { modality: "text->audio" },
  pricing: { image: "0.0035", media_unit: "1K characters" }, voices: ["af_heart"] }] });
const neverAsked = () => { throw new Error("a discovery probe must never ask upstream"); };
const catalogue = {
  async resolve(id) { if (!CHAT_IDS.has(id)) throw new UnknownModel("That model is not available."); return chatModel(id); },
  async canAnswer() { return true; }, async list() { return [...CHAT_IDS].map(chatModel); },
  async imageModels() { return IMAGES; },
  async resolveImage(id) { const m = IMAGES.get(id); if (!m) throw new UnknownModel("no"); return m; },
  async voiceModels() { return VOICE; },
  async resolveSpeech(id) { const m = VOICE.speech.get(id); if (!m) throw new UnknownModel("no"); return m; },
  async videoModels() { return new Map(); }, async resolveVideo() { throw new UnknownModel("no"); },
};

function fakeFacilitator() {
  const calls = { verify: 0, settle: [] };
  return { calls,
    async getSupported() {
      return { kinds: [
        { x402Version: 2, scheme: "exact", network: BASE },
        { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "1".repeat(32) } },
        { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
        { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "1".repeat(32),
          receiverAuthorizer: "1".repeat(32) } },
      ], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} };
    },
    async verify() { calls.verify += 1; return { isValid: true, payer: "0x" + "2".repeat(40) }; },
    async settle(_payload, requirements) {
      calls.settle.push([requirements.network, requirements.amount]);
      return { success: true, transaction: "0x" + "a".repeat(64), network: requirements.network };
    } };
}

const apps = new Map();
export async function serve(t, cat, options = {}) {
  const facilitator = fakeFacilitator();
  const app = createApp({ ...CONFIG, ...options }, { facilitatorClient: facilitator, catalogue: { ...catalogue, ...cat }, exaKey: "fixture",
    fetchImpl: neverAsked, log: () => {}, upstream: neverAsked });
  const url = `http://fixture-${apps.size}.test`;
  apps.set(url, app);
  t.after(() => apps.delete(url));
  return { url, facilitator };
}

// Dispatch HTTP-shaped requests in memory: no listening socket, DNS, or outbound traffic.
export async function request(url, options = {}) {
  const { Duplex } = await import('node:stream');
  const { IncomingMessage, ServerResponse } = await import('node:http');
  const target = new URL(url);
  const chunks = [];
  const socket = new Duplex({ read() {}, write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  socket.remoteAddress = '127.0.0.1';
  const req = new IncomingMessage(socket);
  req.httpVersion = '1.1'; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
  req.method = options.method ?? 'GET'; req.url = target.pathname + target.search;
  req.headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([k,v]) => [k.toLowerCase(), v]));
  req.headers.host ??= target.host;
  if (options.body) req.headers['content-length'] = String(Buffer.byteLength(options.body));
  const res = new ServerResponse(req); res.assignSocket(socket);
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  res.write = chunk => { if (chunk) chunks.push(Buffer.from(chunk)); return true; };
  res.end = function(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); this.finished = true; this.emit('finish'); finish(); return this; };
  apps.get(target.origin)(req, res);
  if (options.body) req.push(options.body);
  req.push(null);
  await finished;
  return new Response(req.method === 'HEAD' ? null : Buffer.concat(chunks), { status: res.statusCode,
    headers: Object.fromEntries(Object.entries(res.getHeaders()).map(([k,v]) => [k, String(v)])) });

}

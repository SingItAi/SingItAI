// SingIt speech: the list price for the text + 30% + the fee, Surplus asked once with this service's key, the audio
// checked before settlement and served with its requested Content-Type, nothing charged without audio.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, createApp } from "../src/app.mjs";
import { ModelCatalogue, UnknownModel, parseVoiceModels } from "../src/catalogue.mjs";
import { SPEECH_ROUTE, SPEECH_CONTENT_TYPES, speechContentType, transcodeWavToMp3, matchesSpeechFormat, readSpeechRequest, speechListAtomic, speechPrice } from "../src/speech.mjs";

const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash" };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const decode = (header) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));
const STT = ["venice-xai-stt-v1", "venice-whisper-1", "venice-whisper-large-v3", "venice-parakeet-asr", "fal-wizper", "elevenlabs-scribe-v2"];
const VOICE = parseVoiceModels({ data: [
  ...STT.map(id => ({ id, architecture: { modality: "audio->text" }, pricing: { image: "0.006", media_unit: "minute" } })),
  { id: "venice-kokoro-tts", architecture: { modality: "text->audio" }, pricing: { image: "0.0035", media_unit: "1K characters" },
    voices: ["af_heart", "am_adam"] },
  { id: "venice-elevenlabs-tts-turbo-v2-5", architecture: { modality: "text->audio" }, pricing: { image: "0.0625", media_unit: "1K characters" } },
  { id: "deepseek-v4.1-flash", architecture: { modality: "text->text" }, pricing: { prompt: "0.0000001" } },
] });
const catalogue = { async voiceModels() { return VOICE; }, async imageModels() { return new Map(); },
  async resolveSpeech(id) { const m = VOICE.speech.get(id); if (!m) throw new UnknownModel("That speech model is not available."); return m; },
  async resolveImage() { throw new UnknownModel("no"); }, async list() { return []; }, async resolve() { throw new Error("no"); } };

function fakeFacilitator() {
  const calls = { settle: [] };
  return { calls,
    async getSupported() {
      return { kinds: [
        { x402Version: 2, scheme: "exact", network: BASE },
        { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
        { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
        { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
          receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
      ], extensions: ["bazaar"], signers: {} };
    },
    async verify() { return { isValid: true, payer: "0x2222222222222222222222222222222222222222" }; },
    async settle(_payload, requirements) {
      calls.settle.push([requirements.network, requirements.amount]);
      return { success: true, transaction: "0x" + "a".repeat(64), network: requirements.network };
    } };
}

const AUDIO = Buffer.from("ID3\x04fake-mp3-bytes");
function fakeSurplus({ status = 200, type = "audio/mpeg", body = AUDIO, cost = "80" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return new Response(body, { status, headers: { "content-type": type, "x-si-buyer-cost-micro": cost } });
  };
  return { calls, fetchImpl };
}

async function serve(t, { surplus = fakeSurplus(), modelCatalogue = catalogue, ffmpeg } = {}) {
  const facilitator = fakeFacilitator();
  const logs = [];
  const app = createApp(CONFIG, { facilitatorClient: facilitator, catalogue: modelCatalogue, ffmpeg, fetchImpl: surplus.fetchImpl, resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
    log: (line) => logs.push(line), upstream: async () => { throw new Error("no answer is asked"); } });
  const listener = await new Promise((resolve, reject) => { const l = app.listen(0, "127.0.0.1", error => error ? reject(error) : resolve(l)); l.once("error", reject); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}`, facilitator, surplus, logs };
}

const post = (url, body, headers = {}) => fetch(url, { method: "POST",
  headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const pay = (required, network) => ({ "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource: required.resource,
  accepted: required.accepts.find((a) => a.network === network), payload: { signature: "0xsigned" },
  extensions: required.extensions }) });
const TEXT = "x".repeat(2000);
const SPEECH = { model: "venice-kokoro-tts", input: TEXT, voice: "af_heart" };

test("speech is offered at the list price for its text + 30% + the network's fee", async (t) => {
  const { url, surplus } = await serve(t);
  const unpaid = await post(`${url}${SPEECH_ROUTE}`, SPEECH);
  assert.equal(unpaid.status, 402);
  const required = decode(unpaid.headers.get("payment-required"));
  // 2000 characters at $0.0035 per 1000 = 7000, + 2100 markup, + the fee. exact on Base leads (SI-61).
  assert.deepEqual(required.accepts.map((a) => [a.network, a.amount]), [[BASE, "10100"], [SOLANA, "11100"]]);
  assert.ok(required.extensions?.bazaar);
  assert.equal(required.resource.mimeType, "application/json");
  assert.equal(required.extensions.bazaar.info.input.body.response_format, "b64_json");
  assert.equal(required.extensions.bazaar.info.output.type, "json");
  assert.equal(required.extensions.bazaar.info.output.example.audio_base64, "SUQzBA==");
  assert.equal(required.extensions.bazaar.info.output.example.bytes, 4);
  assert.deepEqual(surplus.calls, []);
});

test("paid speech comes back as audio, made once with this service's key, then the payer is settled", async (t) => {
  const { url, surplus, facilitator } = await serve(t);
  const required = decode((await post(`${url}${SPEECH_ROUTE}`, SPEECH)).headers.get("payment-required"));
  const paid = await post(`${url}${SPEECH_ROUTE}`, SPEECH, pay(required, BASE));
  assert.equal(paid.status, 200);
  assert.equal(paid.headers.get("content-type"), "audio/mpeg");
  assert.equal(paid.headers.get("x-singit-charged-atomic"), "10100");
  assert.deepEqual(Buffer.from(await paid.arrayBuffer()), AUDIO);
  assert.deepEqual(surplus.calls.map((c) => [c.url, c.auth, c.body]), [["https://surplus.test/v1/audio/speech", "Bearer inf_test",
    { model: "venice-kokoro-tts", input: TEXT, voice: "af_heart" }]]);
  assert.deepEqual(facilitator.calls.settle, [[BASE, "10100"]]);
  assert.equal((await post(`${url}${SPEECH_ROUTE}`, SPEECH, pay(required, BASE))).status, 409);
});

test("Accept: application/json without response_format still returns binary audio", async (t) => {
  const { url, surplus, facilitator } = await serve(t);
  const required = decode((await post(`${url}${SPEECH_ROUTE}`, SPEECH)).headers.get("payment-required"));
  const paid = await post(`${url}${SPEECH_ROUTE}`, SPEECH, { ...pay(required, BASE), Accept: "application/json" });
  assert.equal(paid.status, 200);
  assert.equal(paid.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await paid.arrayBuffer()), AUDIO);
  assert.deepEqual(surplus.calls.map((c) => c.body), [{ model: "venice-kokoro-tts", input: TEXT, voice: "af_heart" }]);
  assert.equal(facilitator.calls.settle.length, 1);
});

for (const envelope of ["json", "b64_json"]) {
  test(`paid speech with response_format ${envelope} returns a JSON envelope and settles once`, async (t) => {
    const { url, surplus, facilitator } = await serve(t);
    const body = { ...SPEECH, response_format: envelope };
    const required = decode((await post(`${url}${SPEECH_ROUTE}`, body)).headers.get("payment-required"));
    assert.equal(required.resource.mimeType, "application/json");
    const paid = await post(`${url}${SPEECH_ROUTE}`, body, pay(required, BASE));
    assert.equal(paid.status, 200);
    assert.match(paid.headers.get("content-type"), /^application\/json/);
    assert.equal(paid.headers.get("x-singit-charged-atomic"), "10100");
    assert.deepEqual(await paid.json(), {
      object: "audio", model: "venice-kokoro-tts", voice: "af_heart", format: "mp3",
      content_type: "audio/mpeg", audio_base64: AUDIO.toString("base64"), bytes: AUDIO.length,
    });
    assert.deepEqual(surplus.calls.map((c) => c.body), [{ model: "venice-kokoro-tts", input: TEXT, voice: "af_heart" }]);
    assert.equal(facilitator.calls.settle.length, 1);
  });
}

test("no audio, no charge", async (t) => {
  for (const surplus of [fakeSurplus({ status: 500 }), fakeSurplus({ type: "application/json", body: "{}" }), fakeSurplus({ body: "" })]) {
    const { url, facilitator } = await serve(t, { surplus });
    const required = decode((await post(`${url}${SPEECH_ROUTE}`, SPEECH)).headers.get("payment-required"));
    assert.equal((await post(`${url}${SPEECH_ROUTE}`, SPEECH, pay(required, SOLANA))).status, 503);
    assert.deepEqual(facilitator.calls.settle, []);
  }
});

test("what is not sold is refused before any payment is asked", async (t) => {
  const { url, surplus } = await serve(t);
  for (const [body, status] of [[{ ...SPEECH, model: "venice-whisper-1" }, 404], [{ ...SPEECH, model: "tts-9" }, 404],
    [{ ...SPEECH, input: "" }, 400], [{ ...SPEECH, input: "x".repeat(4097) }, 400], [{ ...SPEECH, voice: "nobody" }, 400],
    [{ ...SPEECH, response_format: "midi" }, 400], [{ ...SPEECH, speed: 9 }, 400]]) {
    const refused = await post(`${url}${SPEECH_ROUTE}`, body);
    assert.equal(refused.status, status, JSON.stringify(body).slice(0, 80));
    assert.equal(refused.headers.get("payment-required"), null);
  }
  assert.deepEqual(surplus.calls, []);
});

test("x402scan's empty, unpaid probe gets the standing offer; a payment header does not excuse an invalid body", async (t) => {
  const { url, surplus } = await serve(t);
  for (const init of [{ method: "POST" }, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }]) {
    const probe = await fetch(`${url}${SPEECH_ROUTE}`, init);
    assert.equal(probe.status, 402);
    const required = decode(probe.headers.get("payment-required"));
    assert.deepEqual(required.accepts.map((a) => [a.scheme, a.network]), [["exact", BASE], ["exact", SOLANA]]);
    assert.ok(required.extensions?.bazaar?.info, "x402scan needs the input schema to index the route");
    assert.ok(required.extensions?.bazaar?.schema);
  }
  const required = decode((await post(`${url}${SPEECH_ROUTE}`, SPEECH)).headers.get("payment-required"));
  const paidEmpty = await fetch(`${url}${SPEECH_ROUTE}`, { method: "POST", headers: pay(required, BASE) });
  // Not a probe (it carries a payment attempt): refused with no body's model lookup failing first (404), same as
  // any other unknown-model request; never waved through, never charged.
  assert.equal(paidEmpty.status, 404, "a payment header with no body is still refused, not waved through as a probe");
  assert.deepEqual(surplus.calls, []);
});

test("prices, and the free list of voice models", async (t) => {
  const kokoro = VOICE.speech.get("venice-kokoro-tts");
  assert.equal(speechListAtomic(kokoro, { input: "hi" }), 7);
  assert.equal(speechListAtomic(kokoro, { input: "x".repeat(57) }), 200);
  assert.deepEqual(speechPrice(200, SOLANA), { listAtomic: "200", markupAtomic: "60", feeAtomic: "2000", totalAtomic: "2260" });
  assert.deepEqual(readSpeechRequest({ input: "hi", response_format: "wav", speed: 1.5 }, kokoro),
    { model: "venice-kokoro-tts", input: "hi", response_format: "wav", speed: 1.5 });
  assert.deepEqual(readSpeechRequest({ input: "hi", response_format: "b64_json" }, kokoro),
    { model: "venice-kokoro-tts", input: "hi", envelope: "json" });
  assert.deepEqual(readSpeechRequest({ input: "hi", response_format: "json" }, kokoro),
    { model: "venice-kokoro-tts", input: "hi", envelope: "json" });
  const asyncModel = { id: "elevenlabs/v3", usdPerJob: 0.12, voices: ["Aria"] };
  assert.deepEqual(readSpeechRequest({ input: "Hello", voice: "Aria", response_format: "b64_json" }, asyncModel),
    { model: "elevenlabs/v3", input: "Hello", voice: "Aria", envelope: "json" });
  assert.throws(() => readSpeechRequest({ input: "Hello", response_format: "wav" }, asyncModel), /not supported/);
  assert.throws(() => readSpeechRequest({ input: "Hello", speed: 1 }, asyncModel), /not supported/);
  const { url } = await serve(t);
  const list = await (await fetch(`${url}/v1/audio/models`)).json();
  assert.deepEqual(list.data.map((m) => [m.id, m.kind]), [["venice-kokoro-tts", "speech"],
    ["venice-elevenlabs-tts-turbo-v2-5", "speech"], ...STT.map(id => [id, "transcription"])]);
  for (const model of list.data) {
    assert.equal(model.x402, model.kind === "speech");
    assert.equal(model.route, model.kind === "speech" ? "/v1/audio/speech" : null);
    if (model.kind === "transcription") {
      assert.equal(model.access, "api-key");
      assert.equal(model.listUsdPerMinute, 0.006);
      assert.equal(model.singitUsdPerMinute, 0.0078);
    }
  }
  assert.match(list.note, /Transcription models are priced here for API-key use/);
  assert.match(list.note, /not payable on \/v1\/audio\/speech over x402/);
  assert.equal(list.data[0].singitUsdPer1kChars, 0.00455);
});

const FORMAT_BODIES = {
  mp3: AUDIO, wav: Buffer.from("RIFF0000WAVE"), flac: Buffer.from("fLaC"),
  opus: Buffer.from("OggS"), aac: Buffer.from([0xff, 0xf1]), pcm: Buffer.from([0, 1]),
};

for (const [format, body] of Object.entries(FORMAT_BODIES)) {
  test(`speech signature check: ${format}`, () => {
    assert.equal(matchesSpeechFormat(body, format), true);
    if (format === "pcm") {
      assert.equal(matchesSpeechFormat(Buffer.alloc(0), format), true); // Handler separately rejects empty bodies.
      return;
    }
    assert.equal(matchesSpeechFormat(Buffer.from("{}<html>xxxx"), format), false);
    for (let length = 0; length < (format === "mp3" ? 2 : body.length); length++) {
      assert.equal(matchesSpeechFormat(body.subarray(0, length), format), false, `length ${length}`);
    }
  });
}

test("pcm is labelled audio/pcm and MP4-packaged aac audio/mp4", () => {
  assert.equal(SPEECH_CONTENT_TYPES.pcm, "audio/pcm");
  assert.equal(speechContentType("aac", Buffer.from("0000ftypM4A ")), "audio/mp4");
  assert.equal(speechContentType("aac", Buffer.from([0xff, 0xf1, 0, 0, 0, 0, 0, 0])), "audio/aac");
  assert.equal(speechContentType("wav", Buffer.from("0000ftypM4A ")), "audio/wav");
});

test("speech signature alternatives and reserved sync bits", () => {
  assert.equal(matchesSpeechFormat(Buffer.from("ID")), false);
  assert.equal(matchesSpeechFormat(Buffer.from("RIFF0000NOPE"), "wav"), false);
  assert.equal(matchesSpeechFormat(Buffer.from("NOPE0000WAVE"), "wav"), false);
  for (const second of [0xfb, 0xf3, 0xe2]) assert.equal(matchesSpeechFormat(Buffer.from([0xff, second])), true);
  for (const second of [0xf0, 0xf8, 0xe0, 0xdf]) assert.equal(matchesSpeechFormat(Buffer.from([0xff, second])), false);
  for (const body of [Buffer.from("ADIF"), Buffer.from("0000ftyp"), Buffer.from([0xff, 0xf9])]) {
    assert.equal(matchesSpeechFormat(body, "aac"), true);
    assert.equal(matchesSpeechFormat(body.subarray(0, body.length - 1), "aac"), false);
  }
  assert.equal(matchesSpeechFormat(Buffer.from([0xff, 0xf3]), "aac"), false);
  assert.equal(matchesSpeechFormat(AUDIO, "unknown"), false);
});

for (const [format, type] of [["mp3", "audio/mp3"], ["mp3", "application/octet-stream"],
  ...["wav", "flac", "opus", "aac", "pcm"].map((f) => [f, "application/octet-stream"])]) {
  test(`paid ${format} with upstream ${type} uses our Content-Type and settles once`, async (t) => {
    const { url, facilitator, logs } = await serve(t, { surplus: fakeSurplus({ type, body: FORMAT_BODIES[format] }) });
    const body = format === "mp3" ? SPEECH : { ...SPEECH, response_format: format };
    const required = decode((await post(`${url}${SPEECH_ROUTE}`, body)).headers.get("payment-required"));
    assert.equal(required.resource.mimeType, "application/json");
    assert.match(required.resource.description, /OpenAI-compatible text-to-speech API/);
    const paid = await post(`${url}${SPEECH_ROUTE}`, body, pay(required, BASE));
    assert.equal(paid.status, 200);
    assert.equal(paid.headers.get("content-type"), SPEECH_CONTENT_TYPES[format]);
    assert.deepEqual(Buffer.from(await paid.arrayBuffer()), FORMAT_BODIES[format]);
    assert.equal(facilitator.calls.settle.length, 1);
    const success = logs.find((line) => line.includes("characters read by"));
    assert.ok(success.includes(`upstream content-type "${type}"`));
    assert.ok(success.includes(`format ${format}`));
    assert.ok(success.includes(`${FORMAT_BODIES[format].length} bytes`));
    assert.ok(!logs.some((line) => line.includes(TEXT)));
  });
}

for (const [format, type, audio] of [
  ["mp3", "audio/mpeg", Buffer.from('{"error":true}')],
  ["mp3", "audio/mpeg", Buffer.from("<html>error</html>")],
  ...["wav", "flac", "opus", "aac"].map((f) => [f, "audio/mpeg", AUDIO]),
  ...["application/json", "text/plain", "text/html"].map((type) => ["pcm", type, Buffer.from("error")]),
]) {
  test(`invalid ${format} body from ${type} is never settled (${audio.subarray(0, 4).toString("hex")})`, async (t) => {
    const { url, facilitator, logs } = await serve(t, { surplus: fakeSurplus({ type, body: audio }) });
    const body = { ...SPEECH, response_format: format };
    const required = decode((await post(`${url}${SPEECH_ROUTE}`, body)).headers.get("payment-required"));
    const refused = await post(`${url}${SPEECH_ROUTE}`, body, pay(required, BASE));
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("retry-after"), "30");
    assert.deepEqual((await refused.json()).error, { type: "upstream_error", code: "no_billable_answer",
      message: "No audio was made. You were not charged." });
    assert.equal(facilitator.calls.settle.length, 0);
    assert.ok(logs.some((line) => line.includes(SPEECH.model) && line.includes(`format ${format}`)
      && line.includes(`upstream content-type "${type}"`) && line.includes(`${audio.length} bytes`)
      && line.includes(`first4 ${audio.subarray(0, 4).toString("hex")}`)));
  });
}

test("an MP4-packaged aac answer is served as audio/mp4 and settled once", async (t) => {
  const audio = Buffer.from("0000ftypM4A 0000");
  const { url, facilitator } = await serve(t, { surplus: fakeSurplus({ type: "audio/aac", body: audio }) });
  const body = { ...SPEECH, response_format: "aac" };
  const required = decode((await post(`${url}${SPEECH_ROUTE}`, body)).headers.get("payment-required"));
  const paid = await post(`${url}${SPEECH_ROUTE}`, body, pay(required, BASE));
  assert.equal(paid.status, 200);
  assert.equal(paid.headers.get("content-type"), "audio/mp4");
  assert.equal(facilitator.calls.settle.length, 1);
});

for (const scenario of ['success', 'failed', 'timeout', 'no-credit', 'invalid', 'empty', 'oversize', 'loopback', 'private', 'metadata', 'http', 'redirect-limit']) {
  test(`async speech HTTP ${scenario}: settlement requires validated audio`, async t => {
    const model = { id: 'elevenlabs/v3', upstreamId: 'venice-elevenlabs-tts-v3', usdPerJob: 0.12, voices: ['Aria'] };
    VOICE.speech.set(model.id, model);
    t.after(() => VOICE.speech.delete(model.id));
    let calls = 0;
    const surplus = { fetchImpl: async (url, init) => {
      calls++;
      assert.equal(init.headers.Authorization, 'Bearer inf_test');
      if (url.endsWith('/v1/music/generations')) {
        assert.deepEqual(JSON.parse(init.body), { model: model.upstreamId, prompt: 'Hello', voice: 'Aria' });
        if (scenario === 'no-credit') return new Response('{}', { status: 402 });
        if (scenario === 'timeout') throw new DOMException('Deadline exceeded', 'TimeoutError');
        return Response.json({ id: 'job_123', status: scenario === 'failed' ? 'failed' : 'succeeded', results: [{}] });
      }
      assert.ok(url.endsWith('/v1/media/artifacts/job_123/0'));
      const redirects = { loopback: 'https://127.0.0.1/a', private: 'https://10.1.2.3/a', metadata: 'https://169.254.169.254/a', http: 'http://cdn.test/a', 'redirect-limit': '/v1/media/artifacts/job_123/0' };
      if (redirects[scenario]) return new Response(null, { status: 302, headers: { location: redirects[scenario] } });
      return new Response(scenario === 'invalid' ? '{}' : scenario === 'empty' ? '' : AUDIO,
        { headers: scenario === 'oversize' ? { 'content-length': '999999999' } : {} });
    } };
    const { url, facilitator } = await serve(t, { surplus });
    const body = { model: model.id, input: 'Hello', voice: 'Aria' };
    const models = await (await fetch(`${url}/v1/audio/models`)).json();
    const listed = models.data.find(m => m.id === model.id);
    assert.equal(listed.modality, 'speech');
    assert.equal(listed.upstream_id, model.upstreamId);
    assert.equal(listed.listUsdPerJob, 0.12);
    const required = decode((await post(`${url}${SPEECH_ROUTE}`, body)).headers.get('payment-required'));
    assert.equal(calls, 0);
    const result = await post(`${url}${SPEECH_ROUTE}`, body, pay(required, BASE));
    assert.equal(result.status, scenario === 'success' ? 200 : 503);
    assert.equal(facilitator.calls.settle.length, scenario === 'success' ? 1 : 0);
    if (scenario === 'success') assert.deepEqual(Buffer.from(await result.arrayBuffer()), AUDIO);
  });
}

for (const price of [undefined, 'not-a-price', 'Infinity', '0', '-1', '2']) {
  test(`async invalid live price ${price}: 503 before payment`, async t => {
    const modelCatalogue = new ModelCatalogue({ url: CONFIG.surplusUrl });
    const voice = parseVoiceModels({ data: [{ id: 'venice-elevenlabs-tts-v3', architecture: { modality: 'music' },
      pricing: { image: price, media_unit: 'job' } }] });
    modelCatalogue.voiceModels = async () => voice;
    const { url, facilitator, surplus } = await serve(t, { modelCatalogue });
    const listed = await (await fetch(`${url}/v1/audio/models`)).json();
    assert.ok(!listed.data.some(m => m.id === 'elevenlabs/v3'));
    const result = await post(`${url}${SPEECH_ROUTE}`, { model: 'elevenlabs/v3', input: 'Hello' });
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('payment-required'), null);
    assert.deepEqual(surplus.calls, []);
    assert.deepEqual(facilitator.calls.settle, []);
  });
}

test("async speech with b64_json returns a JSON envelope and does not send response_format upstream", async t => {
  const model = { id: "elevenlabs/v3", upstreamId: "venice-elevenlabs-tts-v3", usdPerJob: 0.12, voices: ["Aria"] };
  VOICE.speech.set(model.id, model);
  t.after(() => VOICE.speech.delete(model.id));
  const surplus = { fetchImpl: async (url, init) => {
    if (url.endsWith("/v1/music/generations")) {
      assert.deepEqual(JSON.parse(init.body), { model: model.upstreamId, prompt: "Hello", voice: "Aria" });
      return Response.json({ id: "job_123", status: "succeeded", results: [{}] });
    }
    return new Response(AUDIO);
  } };
  const { url, facilitator } = await serve(t, { surplus });
  const body = { model: model.id, input: "Hello", voice: "Aria", response_format: "b64_json" };
  const required = decode((await post(`${url}${SPEECH_ROUTE}`, body)).headers.get("payment-required"));
  const paid = await post(`${url}${SPEECH_ROUTE}`, body, pay(required, BASE));
  assert.equal(paid.status, 200);
  assert.match(paid.headers.get("content-type"), /^application\/json/);
  assert.deepEqual(await paid.json(), {
    object: "audio", model: model.id, voice: "Aria", format: "mp3",
    content_type: "audio/mpeg", audio_base64: AUDIO.toString("base64"), bytes: AUDIO.length,
  });
  assert.equal(facilitator.calls.settle.length, 1);
});

for (const response_format of [undefined, "mp3", "json", "b64_json"]) {
  test(`WAV upstream is transcoded before settlement: ${response_format ?? "default"}`, async t => {
    const wav = Buffer.from("RIFF0000WAVE");
    let calls = 0;
    const { url, facilitator, logs } = await serve(t, {
      surplus: fakeSurplus({ body: wav, type: "audio/wav" }),
      ffmpeg: async audio => { calls++; assert.deepEqual(audio, wav); return AUDIO; },
    });
    const body = { ...SPEECH, ...(response_format ? { response_format } : {}) };
    const required = decode((await post(`${url}${SPEECH_ROUTE}`, body)).headers.get("payment-required"));
    const paid = await post(`${url}${SPEECH_ROUTE}`, body, pay(required, BASE));
    assert.equal(paid.status, 200);
    let audio;
    if (["json", "b64_json"].includes(response_format)) {
      assert.match(paid.headers.get("content-type"), /^application\/json/);
      const envelope = await paid.json();
      assert.equal(envelope.format, "mp3");
      assert.equal(envelope.content_type, "audio/mpeg");
      audio = Buffer.from(envelope.audio_base64, "base64");
    } else {
      assert.equal(paid.headers.get("content-type"), "audio/mpeg");
      audio = Buffer.from(await paid.arrayBuffer());
    }
    assert.deepEqual(audio, AUDIO);
    assert.ok(matchesSpeechFormat(audio, "mp3"));
    assert.equal(calls, 1);
    assert.equal(facilitator.calls.settle.length, 1);
    assert.ok(logs.some(line => line.includes(SPEECH.model) && line.includes("transcoded WAV to mp3")
      && line.includes(`${wav.length} in bytes`) && line.includes(`${AUDIO.length} out bytes`)));
  });
}

for (const outcome of ["failure", "garbage", "empty"]) {
  test(`transcoding ${outcome} never settles`, async t => {
    const { url, facilitator } = await serve(t, {
      surplus: fakeSurplus({ body: Buffer.from("RIFF0000WAVE") }),
      ffmpeg: async () => {
        if (outcome === "failure") throw new Error("ffmpeg failed");
        return Buffer.from(outcome === "empty" ? "" : "garbage");
      },
    });
    const required = decode((await post(`${url}${SPEECH_ROUTE}`, SPEECH)).headers.get("payment-required"));
    const refused = await post(`${url}${SPEECH_ROUTE}`, SPEECH, pay(required, BASE));
    assert.equal(refused.status, 503);
    assert.equal((await refused.json()).error.code, "no_billable_answer");
    assert.equal(refused.headers.get("x-singit-charged-atomic"), null);
    assert.equal(facilitator.calls.settle.length, 0);
  });
}

test("real MP3 skips transcoding", async t => {
  let calls = 0;
  const { url, facilitator } = await serve(t, { ffmpeg: async () => { calls++; throw new Error("unexpected"); } });
  const required = decode((await post(`${url}${SPEECH_ROUTE}`, SPEECH)).headers.get("payment-required"));
  const paid = await post(`${url}${SPEECH_ROUTE}`, SPEECH, pay(required, BASE));
  assert.equal(paid.status, 200);
  assert.deepEqual(Buffer.from(await paid.arrayBuffer()), AUDIO);
  assert.equal(calls, 0);
  assert.equal(facilitator.calls.settle.length, 1);
});

test("system ffmpeg helper converts PCM WAV and rejects malformed WAV", async (t) => {
  // Injected-ffmpeg tests above cover delivery. This optional check needs a working
  // system ffmpeg with an MP3 encoder (present on the VPS; often missing in CI).
  const wav = Buffer.alloc(44 + 1600);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(1600, 40);
  let mp3;
  try {
    mp3 = await transcodeWavToMp3(wav);
  } catch (error) {
    t.skip(`system ffmpeg unavailable here (${error.message})`);
    return;
  }
  assert.ok(mp3.length > 0);
  assert.ok(matchesSpeechFormat(mp3, "mp3"));
  await assert.rejects(transcodeWavToMp3(Buffer.from("RIFF0000WAVE")), /transcoding/);
});

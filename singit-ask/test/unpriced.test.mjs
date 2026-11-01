import { Readable, Writable } from "node:stream";
import { ServerResponse } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, createApp, chooseModel, RequestError } from "../src/app.mjs";
import { ModelCatalogue, UnknownModel, UnpricedModel } from "../src/catalogue.mjs";
import { ceilingAtomic, UnpricedError, TERMS } from "../src/pricing.mjs";
import { ceilings } from "../src/metered.mjs";
import { chooseAuto } from "../src/auto-router.mjs";
import { chooseModelRoute } from "../src/model-routes.mjs";
function request(app, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    Object.assign(req, { method, url: path, headers: { host: 'ask.test', ...headers }, httpVersionMajor: 1,
      httpVersionMinor: 1, httpVersion: '1.1', socket: { remoteAddress: '127.0.0.1' } });
    if (body !== undefined) req.headers['content-length'] = String(Buffer.byteLength(body));
    const res = new ServerResponse(req);
    const chunks = [];
    const socket = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    res.assignSocket(socket);
    res.on('error', reject);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      const text = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      try { resolve({ status: res.statusCode, headers: res.getHeaders(), body: text ? JSON.parse(text) : null }); }
      catch (e) { reject(new Error(text, { cause: e })); }
    });
    app.handle(req, res);
  });
}
function facilitator() {
  const calls = { verify: 0, settle: 0 };
  return { calls,
    async getSupported() { return { kinds: [
      { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
      { x402Version: 2, scheme: "exact", network: BASE },
          { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
          { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
        receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } } ], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} }; },
    async verify() { calls.verify += 1; return { isValid: true }; },
    async settle() { calls.settle += 1; return { success: true }; } };
}

const CONFIG = {
  payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", payToBase: "0x1111111111111111111111111111111111111111",
  surplusKey: "inf_test", surplusUrl: "https://surplus.test", model: "deepseek-v4.1-flash",
  freeModels: ["deepseek-v4.1-flash"], freeLimits: { perVisitorPerDay: 2, perDay: 3 },
};

const prices = [
  ["deepseek-v4.1-flash", 4.5e-8, 5e-7],
  ["claude-haiku-4.5", 1e-6, 5e-6],
  ["glm-5.3-flash", 2.85e-8, 9.23e-8],
  ["gpt-6-luna", 1e-7, 5e-7],
];
async function catalogue() {
  const data = [...prices, ["zero", 0, 0], ["zero-input", 0, 1e-6], ["zero-output", 1e-6, 0],
    ["negative", -1, 1], ["nan", "bad", 1]].map(([id, prompt, completion]) => ({ id,
      pricing: { prompt: String(prompt), completion: String(completion) }, architecture: { modality: "text->text" },
      supported_parameters: ["max_tokens"] }));
  const c = new ModelCatalogue({ url: "https://unused.test", fetchImpl: async () => new Response(JSON.stringify({ data })) });
  await c.all();
  c.canAnswer = async () => true;
  c.market = async () => new Map();
  return c;
}
test("zero prices remain in all(), are hidden by list(), and require explicit resolution permission", async () => {
  const c = await catalogue();
  for (const id of ["zero", "zero-input", "zero-output"]) {
    const m = await c.resolve(id, { allowUnpriced: true });
    assert.equal(m.unpriced, true);
    await assert.rejects(c.resolve(id), e => e instanceof UnpricedModel && e instanceof UnknownModel);
    assert.throws(() => ceilingAtomic(m, {}, TERMS), UnpricedError);
  }
  assert.deepEqual((await c.list()).map(m => m.id).sort(), prices.map(p => p[0]).sort());
  for (const id of ["negative", "nan"]) assert.equal((await c.all()).has(id), false);
  assert.doesNotThrow(() => ceilingAtomic({ promptUsdPerToken: 0, completionUsdPerToken: 0 },
    { chars: 1, maxTokens: 1, messageCount: 1 }, TERMS));
});
test("unpriced default keeps the standing ceiling; pinned paid route refuses", async () => {
  const c = await catalogue();
  for (const model of [undefined, "zero"]) {
    const chosen = await chooseModel({ ...CONFIG, model: "zero" }, c, { model });
    assert.equal(chosen.info, null);
    assert.equal(ceilings(chosen.info, chosen).upto[BASE], TERMS.maxChargeAtomic);
  }
  await assert.rejects(chooseModelRoute(c, "zero", 1, {}), { status: 404 });
});
test("auto skips a zero-priced candidate", async () => {
  const c = await catalogue();
  c.models.get("deepseek-v4.1-flash").unpriced = true;
  c.models.set("claude-haiku-5.5", { ...c.models.get("claude-haiku-4.5"), id: "claude-haiku-5.5" });
  const picked = await chooseAuto(CONFIG, c, { messages: [{ content: "Hi" }], chars: 2, messageCount: 1, maxTokens: 32 }, RequestError);
  assert.equal(picked.model, "claude-haiku-5.5");
});
test("HTTP refuses unpriced models before payment, omits listings, and preserves free access", async () => {
  const c = await catalogue(), fac = facilitator();
  const asked = [];
  const app = createApp({ ...CONFIG, freeModels: ["zero"] }, { catalogue: c, facilitatorClient: fac,
    log: () => {}, fetchImpl: async () => { throw new Error("Unexpected upstream fetch"); },
    upstream: async (...args) => { asked.push(args[4]); return { content: "Hi", finishReason: "stop", usage: { buyer_cost_micro: 1 } }; } });
  const post = (path, body) => request(app, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const model of ["zero", "zero-input", "zero-output"]) {
    for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses"]) {
      const res = await post(path, { model, messages: [{ role: "user", content: "Hello" }], input: "Hello", max_tokens: 32 });
      assert.equal(res.status, path === "/v1/chat/completions" ? 400 : 404, path);  // as for an unknown model on each route
      assert.equal(res.body.error.code, "model_not_found");
      assert.equal(res.body.error.message, new UnpricedModel().message);
      assert.equal(res.headers["payment-required"], undefined);
    }
  }
  for (const path of ["/v1/models", "/pricing.json"]) {
    const res = await request(app, path);
    assert.equal(res.status, 200);
    const models = res.body.data ?? res.body.models;
    assert.equal(models.some(m => ["zero", "zero-input", "zero-output"].includes(m.id)), false);
  }
  const free = await post("/v1/chat/completions", { model: "free/zero", messages: [{ role: "user", content: "Hi" }], max_tokens: 32 });
  assert.equal(free.status, 200);
  assert.deepEqual(asked, ["zero"]);
  assert.deepEqual(fac.calls, { verify: 0, settle: 0 });
});

// Fixed formula baseline: input 404 tokens for upto / 104 for exact, output 1000 / 300,
// 30% markup rounded up, plus Base 1000 / Solana 2000, with the 1500 floor.
const quoteBaseline = [
  ["1675", "2675", "1500", "2202"],
  ["8026", "9026", "3086", "4086"],
  ["1500", "2136", "1500", "2041"],
  ["1704", "2704", "1500", "2210"],
];
test("four paying-agent models retain identical HTTP 402 amounts", async () => {
  const c = await catalogue(), fac = facilitator();
  // Separate default so each fixture exercises its full per-model price without the default clamp.
  const app = createApp({ ...CONFIG, model: "other-default" }, { catalogue: c,
    facilitatorClient: fac, log: () => {}, fetchImpl: async () => { throw new Error("Unexpected fetch"); } });
  for (const [i, [model]] of prices.entries()) {
    const res = await request(app, "/v1/chat/completions", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "a".repeat(400) }], max_tokens: 1000 }) });
    assert.equal(res.status, 402);
    const challenge = JSON.parse(Buffer.from(res.headers["payment-required"], "base64"));
    assert.deepEqual(["upto", "exact"].flatMap(scheme => [BASE, SOLANA].map(network =>
      challenge.accepts.find(a => a.scheme === scheme && a.network === network).amount)), quoteBaseline[i], model);
  }
  assert.deepEqual(fac.calls, { verify: 0, settle: 0 });
});

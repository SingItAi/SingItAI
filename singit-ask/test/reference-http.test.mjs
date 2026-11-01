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

import { REFERENCE_PRICES } from "../src/reference-prices.mjs";
import { LIMITS } from "../src/app.mjs";
async function setup() {
  const c = new ModelCatalogue({ url: "https://fixture", fetchImpl: async () => Response.json({ data: Object.keys(REFERENCE_PRICES).map(id => ({
    id, pricing: { prompt: "0.0000000000", completion: "0.0000000000" }, architecture: { modality: "text->text" }, supported_parameters: ["max_tokens"] })) }) });
  await c.all(); c.market = async () => new Map(); c.canAnswer = async () => true;
  return createApp({ ...CONFIG, model: "other-default" }, { catalogue: c, facilitatorClient: facilitator(), log: () => {}, fetchImpl: async () => { throw Error("Unexpected fetch"); } });
}
test("all twelve reference models offer paid quotes above the floor and expose honest discovery", async () => {
  const app = await setup();
  assert.equal((await request(app, "/v1/models")).body.savings.field, "savingsVsListPct");
  for (const [id, ref] of Object.entries(REFERENCE_PRICES)) {
    for (const length of [2, 24000]) {
      const res = await request(app, "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: id, messages: [{ role: "user", content: "a".repeat(length) }] }) });
      assert.equal(res.status, 402, id);
      const q = JSON.parse(Buffer.from(res.headers["payment-required"], "base64"));
      for (const scheme of ["upto", "exact"]) {
        const amount = Number(q.accepts.find(a => a.network === BASE && a.scheme === scheme).amount);
        assert.ok(amount >= 1500, id);
        if (length === 24000 && ["gemini-3.1-pro", "claude-opus-4.6-fast", "claude-opus-4-7-fast"].includes(id)) assert.ok(amount > 2500, id);
        if (["gemini-3.1-pro", "claude-opus-4.6-fast"].includes(id)) {
          const prompt = Math.ceil(length / (scheme === "upto" ? 1 : 4)) + 4;
          const output = scheme === "upto" ? LIMITS.defaultTokens : Math.ceil(LIMITS.defaultTokens * .3);
          const cost = Math.ceil((prompt * (ref.inputUsdPerM / 1e6) + output * (ref.outputUsdPerM / 1e6)) * 1e6);
          assert.equal(amount, cost + Math.ceil(cost * .3) + 1000, id + scheme);
        }
      }
    }
  }
  for (const path of ["/v1/models", "/pricing.json"]) {
    const res = await request(app, path);
    for (const id of Object.keys(REFERENCE_PRICES)) {
      const m = (res.body.data ?? res.body.models).find(m => m.id === id);
      assert.equal(m.priceBasis, "reference"); assert.ok(m.usdPerMillionTokens);
      for (const field of ["singitUsdPerMillionTokens", "savingsVsListPct", "expectedUsdPerMillionTokens", "perMillion"]) assert.equal(m[field], undefined);
    }
  }
});

test("paid reference answers settle actual offer cost, omit discount headers and audit only low estimates", async () => {
  const id = "gemini-3.1-pro", logs = [], settled = [], headers = [];
  const c = new ModelCatalogue({ url: "https://fixture", fetchImpl: async () => Response.json({ data: [{ id,
    pricing: { prompt: 0, completion: 0 }, architecture: { modality: "text->text" }, supported_parameters: ["max_tokens"] }] }) });
  await c.all(); c.market = async () => new Map(); c.canAnswer = async () => true;
  const fac = facilitator(); fac.settle = async (_p, r) => { settled.push(r.amount); return { success: true, network: BASE, transaction: "0x" + "1".repeat(64) }; };
  let low = false;
  const app = createApp({ ...CONFIG, model: "other-default" }, { catalogue: c, facilitatorClient: fac, log: line => logs.push(line),
    fetchImpl: async (_url, options) => {
      headers.push(options.headers);
      return Response.json({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }], usage: {
        prompt_tokens: 6, completion_tokens: 26, buyer_cost_micro: low ? 1000 : Math.ceil(6 * 1.88 + 26 * 11.28) } });
    } });
  const body = JSON.stringify({ model: id, messages: [{ role: "user", content: "Hi" }] });
  const send = extra => request(app, "/v1/chat/completions", { method: "POST", body, headers: { "content-type": "application/json", ...extra } });
  for (const cost of [Math.ceil(6 * 1.88 + 26 * 11.28), 1000]) {
    low = cost === 1000;
    const first = await send({});
    const q = JSON.parse(Buffer.from(first.headers["payment-required"], "base64"));
    const accepted = q.accepts.find(a => a.scheme === "upto" && a.network === BASE);
    const paid = await send({ "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, resource: q.resource, accepted,
      payload: { signature: "0xsigned" }, extensions: q.extensions })).toString("base64") });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(settled.at(-1), String(cost + Math.ceil(cost * .3) + 1000));
    assert.ok(Number(settled.at(-1)) <= Number(accepted.amount));
    assert.equal(logs.filter(l => l.includes("reference_price_low")).length, low ? 1 : 0);
  }
  // Answers from a reference-priced model teach no share: its price moves with the order books.
  const listed = (await request(app, "/v1/models")).body.data.find(m => m.id === id);
  assert.equal(listed.priceBasis, "reference");
  for (const field of ["expectedUsdPerMillionTokens", "singitUsdPerMillionTokens", "savingsVsListPct"]) assert.equal(listed[field], undefined);
  assert.equal(headers.length, 2);
  for (const h of headers) assert.equal(new Headers(h).has("X-Min-Discount"), false);
});

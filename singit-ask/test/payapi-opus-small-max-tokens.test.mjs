import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, createApp, askSurplus } from "../src/app.mjs";
import { readFileSync } from "node:fs";
import { ceilingAtomic, reasoningHeadroom, setReasoningHeadroomOverrides, TERMS, SOLANA_TERMS } from "../src/pricing.mjs";
import { DEFAULT_FREE_EXAMPLE, DEFAULT_FREE_MODELS } from "../src/free.mjs";
import { UnknownModel } from "../src/catalogue.mjs";
import { MODEL_ROUTES, modelRoutePaths, routePath, discoveryDescription, modelExample } from "../src/model-routes.mjs";

const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash" };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const decode = (header) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));

const PRICEY = { id: "claude-opus-5.5", name: "Opus", provider: "anthropic", contextLength: 1e6, promptUsdPerToken: 4e-6, completionUsdPerToken: 20e-6 };
const catalogue = {
  async resolve(id) { if (id !== PRICEY.id) throw new UnknownModel("That model is not available."); return PRICEY; },
  async canAnswer() { return true; },
  async list() { return [PRICEY]; },
};

function fakeFacilitator() {
  const calls = { verify: 0, settle: [] };
  return { calls,
    async getSupported() {
      return { kinds: [
        { x402Version: 2, scheme: "exact", network: BASE },
        { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
        { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
        { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
          receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
      ], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} };
    },
    async verify() { calls.verify += 1; return { isValid: true, payer: "0x2222222222222222222222222222222222222222" }; },
    async settle(_payload, requirements) {
      calls.settle.push([requirements.network, requirements.amount]);
      return { success: true, transaction: "0x" + "a".repeat(64), network: requirements.network };
    } };
}

async function serve(t, { reasoningEffort } = {}) {
  const facilitator = fakeFacilitator();
  const asked = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    asked.push(body);
    const answers = body.reasoning_effort === "low";
    return new Response(JSON.stringify({ choices: [{ message: { content: answers ? "Try a nearby coffee bar." : "" },
      finish_reason: answers ? "stop" : "length" }], usage: { completion_tokens: answers ? 40 : body.max_tokens,
      buyer_cost_micro: 100 } }), { status: 200 });
  };
  const app = createApp({ ...CONFIG, reasoningEffort }, { facilitatorClient: facilitator, fetchImpl,
    log: () => {}, catalogue });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}`, facilitator, asked };
}

const post = (url, body, headers = {}) => fetch(url, { method: "POST",
  headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const pay = (required, network, scheme = "upto") => ({ "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource: required.resource,
  accepted: required.accepts.find((a) => a.network === network && a.scheme === scheme), payload: { signature: "0xsigned" },
  extensions: required.extensions }) });


const OPUS = MODEL_ROUTES.find((m) => m.id === PRICEY.id);
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] }));

test("model defaults, explicit efforts and the none refusal fallback preserve the upstream budget", async () => {
  for (const [model, effort, wanted] of [[PRICEY.id, undefined, "low"], ["claude-sonnet-5.5", undefined, "none"],
    [CONFIG.model, undefined, "none"], [PRICEY.id, "none", "none"], [PRICEY.id, "medium", "medium"]]) {
    let body;
    await askSurplus({ ...CONFIG, reasoningEffort: effort ? { [model]: effort } : undefined },
      modelExample(OPUS).messages, 400, async (_url, init) => { body = JSON.parse(init.body); return reply(); }, model);
    assert.equal(body.reasoning_effort, wanted);
    assert.equal(body.max_tokens, 400 + (model === PRICEY.id ? 256 : 0));
  }
  const seen = [];
  await askSurplus({ ...CONFIG, reasoningEffort: { [PRICEY.id]: "none" } }, modelExample(OPUS).messages, 400,
    async (_url, init) => {
      seen.push(JSON.parse(init.body).reasoning_effort);
      return seen.length === 1 ? new Response(JSON.stringify({ error: { code: "request_rejected",
        message: "Reasoning cannot be disabled" } }), { status: 400 }) : reply();
    }, PRICEY.id);
  assert.deepEqual(seen, ["none", "low"]);
});

for (const effort of [undefined, "none"]) test(`example paid route with simulated adaptive thinking, effort=${effort}`, async (t) => {
  const { url, facilitator, asked } = await serve(t, { reasoningEffort: effort ? { [PRICEY.id]: effort } : undefined });
  const endpoint = url + routePath(PRICEY.id);
  const probe = decode((await fetch(endpoint)).headers.get("payment-required"));
  const body = probe.extensions.bazaar.info.input.body;
  const required = decode((await post(endpoint, body)).headers.get("payment-required"));
  const paid = await post(endpoint, body, pay(required, BASE));
  assert.equal(paid.status, effort ? 422 : 200);
  const result = await paid.json();
  if (effort) assert.match(JSON.stringify(result), /max_tokens_too_small/);
  else assert.ok(result.choices[0].message.content);
  assert.equal(facilitator.calls.settle.length, effort ? 0 : 1);
  assert.equal(asked[0].reasoning_effort, effort ?? "low");
  assert.equal(asked[0].max_tokens, 656);
});

test("example quotes match discovery and pricing; larger caps clamp at 1200 on both networks", async (t) => {
  const { url } = await serve(t);
  const endpoint = url + routePath(PRICEY.id);
  const body = modelExample(OPUS);
  const quote = async (body) => decode((await post(endpoint, body)).headers.get("payment-required"));
  const small = await quote(body);
  const probe = decode((await fetch(endpoint)).headers.get("payment-required"));
  const large = await quote({ ...body, max_tokens: 1200 });
  const clamped = await quote({ ...body, max_tokens: 2000 });
  const amount = (q, network, scheme) => q.accepts.find((a) => a.network === network && a.scheme === scheme).amount;
  for (const network of [BASE, SOLANA]) for (const scheme of ["upto", "exact"]) {
    const value = Number(amount(small, network, scheme));
    const bigger = Number(amount(large, network, scheme));
    assert.equal(amount(small, network, scheme), amount(probe, network, scheme));
    assert.equal(amount(large, network, scheme), amount(clamped, network, scheme));
    assert.ok(bigger > value && bigger < value * 3);
    if (scheme === "upto") assert.equal(amount(small, network, scheme), ceilingAtomic(PRICEY,
      { chars: body.messages[0].content.length, maxTokens: 400, messageCount: 1, charsPerToken: 1 },
      network === BASE ? TERMS : SOLANA_TERMS, 1));
  }
});

test("all examples request one sentence and OpenAPI explains the cap without lengthening Bazaar metadata", async (t) => {
  const { url } = await serve(t);
  const doc = await (await fetch(url + "/openapi.json")).json();
  for (const model of MODEL_ROUTES) {
    const example = modelExample(model);
    assert.match(example.messages[0].content, /Answer in one sentence/);
    assert.equal(example.max_tokens, 400);
    assert.equal(example.model, model.id);
    const required = decode((await fetch(url + routePath(model.id))).headers.get("payment-required"));
    assert.equal(required.resource.description, discoveryDescription(model));
    assert.ok(required.resource.description.length <= 160);
    assert.deepEqual(required.extensions.bazaar.info.input.body, example);
  }
  const operation = doc.paths[routePath(PRICEY.id)].post;
  assert.ok(operation.description.length <= 160);
  const maxTokens = operation.requestBody.content["application/json"].schema.properties.max_tokens;
  assert.match(maxTokens.description, /ceiling grows with it/);
  assert.match(maxTokens.description, /larger value counts as 1200/);
  assert.equal(maxTokens.maximum, 1200);
});

// The free first call. Surplus lists no reasoning control for openai-gpt-oss-20b and it thinks about 200 tokens every
// time, so free/openai-gpt-oss-20b with max_tokens 100 used to come back 422 (2 November).
const GPT_OSS = { id: "openai-gpt-oss-20b", name: "GPT OSS 20B", provider: "openai", contextLength: 131072,
  promptUsdPerToken: 0.03e-6, completionUsdPerToken: 0.14e-6 };
const THINKS = 220;
async function serveFree(t) {
  const asked = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    asked.push(body);
    const answers = body.max_tokens > THINKS;
    return new Response(JSON.stringify({ choices: [{ message: { content: answers ? "Hey there buddy." : "" },
      finish_reason: answers ? "stop" : "length" }], usage: { prompt_tokens: 73, completion_tokens: answers ? THINKS + 5 : body.max_tokens,
      buyer_cost_micro: 0 } }), { status: 200 });
  };
  const free = { async resolve(id) { if (id !== GPT_OSS.id) throw new UnknownModel("no"); return GPT_OSS; },
    async canAnswer() { return true; }, async list() { return [GPT_OSS]; } };
  const app = createApp({ ...CONFIG, freeModels: [GPT_OSS.id] }, { facilitatorClient: fakeFacilitator(), fetchImpl, log: () => {}, catalogue: free });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => { listener.close(); setReasoningHeadroomOverrides({}); });
  return { url: `http://127.0.0.1:${listener.address().port}`, asked };
}
const freeCall = (url, maxTokens) => post(`${url}/v1/chat/completions`, { model: "free/" + GPT_OSS.id, max_tokens: maxTokens,
  messages: [{ role: "user", content: "Say hi in three words." }] });

test("free/openai-gpt-oss-20b answers at max_tokens 100: its thinking has priced room upstream", async (t) => {
  assert.equal(reasoningHeadroom(GPT_OSS.id), 256);
  const { url, asked } = await serveFree(t);
  const response = await freeCall(url, 100);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.choices[0].message.content, "Hey there buddy.");
  assert.equal(result.billing.free, true);
  assert.equal(asked[0].max_tokens, 356);
});

test("without the headroom the same free call is the old 422, so the test above discriminates", async (t) => {
  setReasoningHeadroomOverrides({ [GPT_OSS.id]: 0 });
  const { url } = await serveFree(t);
  const response = await freeCall(url, 100);
  assert.equal(response.status, 422);
  assert.match(JSON.stringify(await response.json()), /max_tokens_too_small/);
});

test("the free first call named in llms.txt and SKILL.md is the free example, and it is a free model", async () => {
  const site = new URL("../../website/", import.meta.url);
  for (const file of ["llms.txt", "llms-full.txt", "SKILL.md"]) {
    const text = readFileSync(new URL(file, site), "utf8");
    const named = [...text.matchAll(/free\/([a-z0-9.-]+)/g)].map((m) => m[1]);
    assert.ok(named.length > 0, file);
    for (const id of named) assert.equal(id, DEFAULT_FREE_EXAMPLE, `${file} names free/${id}`);
  }
  assert.ok(DEFAULT_FREE_MODELS.includes(DEFAULT_FREE_EXAMPLE));
});

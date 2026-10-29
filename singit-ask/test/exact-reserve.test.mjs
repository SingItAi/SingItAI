// EXACT_RESERVE (29 October): for Claude Opus, `exact` prices R = clamp(round(0.25 * max_tokens), 32, 256) thinking
// tokens instead of the whole 256-token headroom. The headroom still goes upstream and `upto` is unchanged.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, ROUTE, createApp, askSurplus } from "../src/app.mjs";
import { UnknownModel } from "../src/catalogue.mjs";
import { ceilings } from "../src/metered.mjs";
import { DEFAULT_EXACT_RESERVE, EXACT_RESERVE_FULL, exactReserveTokens, parseExactReserve, setExactReserve,
  setReasoningHeadroomOverrides, TERMS, ceilingAtomic } from "../src/pricing.mjs";

const OPUS = { id: "claude-opus-5.5", name: "Claude Opus 5.5", provider: "anthropic", contextLength: 1e6,
  promptUsdPerToken: 4e-6, completionUsdPerToken: 20e-6 };
const SONNET = { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: "anthropic", contextLength: 1e6,
  promptUsdPerToken: 2e-6, completionUsdPerToken: 10e-6 };
const GEMINI = { id: "gemini-3.1-pro-preview", promptUsdPerToken: 2e-6, completionUsdPerToken: 12e-6 };
const DEFAULT = { id: "deepseek-v4.1-flash", name: "DeepSeek", provider: "deepseek", contextLength: 1e5,
  promptUsdPerToken: 0.14e-6, completionUsdPerToken: 0.28e-6 };
afterEach(() => { setExactReserve(DEFAULT_EXACT_RESERVE); setReasoningHeadroomOverrides({}); });

test("parseExactReserve: unset is the default, 'full' restores the old pricing, anything else must be factor,min,max", () => {
  assert.deepEqual(parseExactReserve(undefined), { factor: 0.25, min: 32, max: 256 });
  assert.deepEqual(parseExactReserve(""), DEFAULT_EXACT_RESERVE);
  assert.equal(parseExactReserve(" FULL "), EXACT_RESERVE_FULL);
  assert.deepEqual(parseExactReserve("0.5, 16, 128"), { factor: 0.5, min: 16, max: 128 });
  for (const bad of ["0.25", "0.25,32", "0.25,32,256,1", "0,32,256", "1.1,32,256", "-1,32,256", "x,32,256", "0.25,-1,256",
    "0.25,32.5,256", "0.25,300,256", "0.25,32,4096", "0.25,,256", "off"])
    assert.throws(() => parseExactReserve(bad), /SINGIT_ASK_EXACT_RESERVE/, bad);
});

test("exactReserveTokens: clamp(round(0.25 * max_tokens), 32, 256) for Opus, nothing for other models", () => {
  const r = (m) => exactReserveTokens("claude-opus-5.5", m);
  assert.deepEqual([0, 64, 100, 150, 500, 1000, 1024, 1200, 100000].map(r), [32, 32, 32, 38, 125, 250, 256, 256, 256]);
  assert.equal(r(undefined), 32);
  for (const id of ["claude-sonnet-5.5", "deepseek-v4.1-flash", "gemini-3.1-pro-preview", undefined, "my-claude-opus-5.5"])
    assert.equal(exactReserveTokens(id, 500), null, String(id));
  assert.equal(exactReserveTokens("claude-opus-4.8", 500), null, "no headroom listed for it, so nothing to scale");
});

test("exact for Opus: expected amounts at max_tokens 150, 500 and 1200 (full list price, then the 0.22 guard); upto is unchanged", () => {
  const BASE_NET = BASE;
  const at = (maxTokens, share) => ceilings(OPUS, { chars: 44, messageCount: 1, maxTokens, share });
  // exact = worst + 30% + 1000 fee; worst = (15 input tokens * 4e-6 + (ceil(0.3 * max) + R) * 20e-6) * share.
  assert.deepEqual([150, 500, 1200].map((m) => at(m, 1).exact[BASE_NET]), ["3238", "8230", "17094"]);
  assert.deepEqual([150, 500, 1200].map((m) => at(m, 0.22).exact[BASE_NET]), ["1500", "2592", "4542"]);
  assert.equal(at(500, 0.22).exact[SOLANA], "3592", "Solana's fee is 1000 higher");
  // upto: the whole max_tokens plus the whole 256 headroom at one char per token, exactly as before.
  assert.deepEqual([150, 500, 1200].map((m) => at(m, 1).upto[BASE_NET]), ["11806", "20907", "39107"]);
  for (const m of [150, 500, 1200])
    assert.equal(at(m, 0.22).upto[BASE_NET], ceilingAtomic(OPUS, { chars: 44, messageCount: 1, maxTokens: m, charsPerToken: 1 }, TERMS, 0.22));
});

test("restoring the old behaviour ('full'): exact prices the whole 256 headroom again; upto is the same either way", () => {
  const input = { chars: 44, messageCount: 1, maxTokens: 500, share: 0.22 };
  const scaled = ceilings(OPUS, input);
  setExactReserve(parseExactReserve("full"));
  const full = ceilings(OPUS, input);
  assert.equal(full.exact[BASE], ceilingAtomic(OPUS, { chars: 44, messageCount: 1, maxTokens: 150, charsPerToken: 4 }, TERMS, 0.22));
  assert.equal(full.exact[BASE], "3340");
  assert.equal(scaled.exact[BASE], "2592");
  assert.deepEqual(full.upto, scaled.upto);
});

test("configured factor and bounds are used; the reserve never exceeds the model's headroom", () => {
  setExactReserve(parseExactReserve("0.5,64,200"));
  assert.deepEqual([0, 100, 300, 500].map((m) => exactReserveTokens("claude-opus-5.5", m)), [64, 64, 150, 200]);
  setExactReserve(DEFAULT_EXACT_RESERVE);
  setReasoningHeadroomOverrides({ "claude-opus-5.5": 20 });
  assert.equal(exactReserveTokens("claude-opus-5.5", 500), 20, "the headroom override caps it");
  setReasoningHeadroomOverrides({ "claude-opus-5.5": 0 });
  assert.equal(exactReserveTokens("claude-opus-5.5", 500), null, "no headroom: nothing to scale");
});

test("other models' exact and every model's upto are the same with the reserve on or off", () => {
  const input = { chars: 44, messageCount: 1, maxTokens: 500, share: 0.5 };
  const on = [SONNET, GEMINI, DEFAULT].map((m) => ceilings(m, input));
  setExactReserve(EXACT_RESERVE_FULL);
  assert.deepEqual([SONNET, GEMINI, DEFAULT].map((m) => ceilings(m, input)), on);
  assert.deepEqual(ceilings(null, {}), ceilings(null, {}), "no catalogue entry: the standing ceiling");
});

test("the upstream max_tokens still carries the whole 256 headroom", async () => {
  let sent;
  await askSurplus({ surplusUrl: "https://surplus.invalid", surplusKey: "k" }, [{ role: "user", content: "hi" }], 500,
    async (_u, init) => { sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: {} })); },
    "claude-opus-5.5", { params: ["max_tokens", "reasoning", "reasoning_effort"] });
  assert.equal(sent.max_tokens, 500 + 256);
});

// The advertised amounts (GET /pricing.json) equal the 402 for the same question, as for every model.
const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", payToBase: "0x1111111111111111111111111111111111111111",
  surplusKey: "inf_test", surplusUrl: "https://surplus.test", model: "deepseek-v4.1-flash" };
const decode = (header) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));
const MODELS = [DEFAULT, SONNET, OPUS];
const catalogue = {
  async resolve(id) { const m = MODELS.find((x) => x.id === id); if (!m) throw new UnknownModel("That model is not available."); return m; },
  async list() { return MODELS; }, async canAnswer() { return true; }, async market() { return new Map(); },
};
const facilitator = { async getSupported() {
  return { kinds: [
    { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
    { x402Version: 2, scheme: "exact", network: BASE },
    { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
    { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
      receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
  ], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} }; },
  async verify() { throw new Error("unused"); }, async settle() { throw new Error("unused"); } };
const never = () => { throw new Error("never called"); };
async function serve(t) {
  const app = createApp(CONFIG, { facilitatorClient: facilitator, catalogue, fetchImpl: never, upstream: never, log: () => {} });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return `http://127.0.0.1:${listener.address().port}`;
}
const offers = async (url, model, maxTokens) => {
  const response = await fetch(`${url}${ROUTE}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, ...(maxTokens ? { max_tokens: maxTokens } : {}),
      messages: [{ role: "user", content: "What is the capital of France?" }] }) });
  assert.equal(response.status, 402);
  const { accepts } = decode(response.headers.get("payment-required"));
  const amount = (scheme, network) => accepts.find((a) => a.scheme === scheme && a.network === network).amount;
  return { exactBase: amount("exact", BASE), exactSolana: amount("exact", SOLANA), uptoBase: amount("upto", BASE), uptoSolana: amount("upto", SOLANA) };
};
const priced = async (url, id) => {
  const m = (await (await fetch(`${url}/pricing.json`)).json()).models.find((x) => x.id === id);
  return { exactBase: m.exact.base.ceilingAtomic, exactSolana: m.exact.solana.ceilingAtomic,
           uptoBase: m.upto.base.priceAtomic, uptoSolana: m.upto.solana.priceAtomic };
};

test("/pricing.json and the 402 advertise the same Opus amounts, with the reserve on and off", async (t) => {
  const url = await serve(t);
  const scaled = await offers(url, OPUS.id);
  assert.deepEqual(await priced(url, OPUS.id), scaled);
  setExactReserve(EXACT_RESERVE_FULL);
  const full = await offers(url, OPUS.id);
  assert.deepEqual(await priced(url, OPUS.id), full);
  // Only exact moves: by (256 - 200) reserve tokens at $20/M = 1120 micro-USD of list cost, +30% markup (default
  // max_tokens 800: R = clamp(200, 32, 256) = 200).
  assert.equal(BigInt(full.exactBase) - BigInt(scaled.exactBase), 1120n + 336n);
  assert.equal(BigInt(full.exactSolana) - BigInt(scaled.exactSolana), 1120n + 336n);
  assert.equal(full.uptoBase, scaled.uptoBase);
  assert.equal(full.uptoSolana, scaled.uptoSolana);
});

test("the 402 for an explicit max_tokens carries the scaled reserve, and Sonnet's offers do not depend on the setting", async (t) => {
  const url = await serve(t);
  const small = await offers(url, OPUS.id, 150);
  const large = await offers(url, OPUS.id, 1200);
  // worst (list, share 1) = (input tokens * 4e-6 + (ceil(0.3 * max) + R) * 20e-6); the same input, so the gap is output only:
  // (360 + 256) - (45 + 38) = 533 tokens * 20e-6 = 10660 micro-USD, +30% markup = 13858 (+-1 from rounding up).
  const gap = BigInt(large.exactBase) - BigInt(small.exactBase);
  assert.ok(gap >= 13857n && gap <= 13859n, `gap ${gap}`); // rounding up in each of the two amounts
  const sonnet = await offers(url, SONNET.id, 150);
  setExactReserve(EXACT_RESERVE_FULL);
  assert.deepEqual(await offers(url, SONNET.id, 150), sonnet);
});

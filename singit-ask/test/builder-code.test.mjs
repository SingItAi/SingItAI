// Base Builder Code (ERC-8021): every Base-payable 402 declares the app code from the environment, and a
// payment that echoes it (or echoes nothing) still settles. "bc_test1234" is an obviously-fake example code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, createApp } from "../src/app.mjs";
import { CREDIT_ROUTE } from "../src/credit.mjs";
import { BUILDER_CODE_ENV, appBuilderCode, withBuilderCode } from "../src/builder-code.mjs";

const CODE = "bc_test1234";
const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", model: "deepseek-v4.1-flash" };

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
      ], extensions: [], signers: {} };
    },
    async verify() { return { isValid: true, payer: "0x2222222222222222222222222222222222222222" }; },
    async settle(payload, requirements) {
      calls.settle.push({ network: requirements.network, extensions: payload.extensions });
      return { success: true, transaction: "0x" + "a".repeat(64), network: requirements.network };
    } };
}

async function serve(t, code) {
  if (code === undefined) delete process.env[BUILDER_CODE_ENV]; else process.env[BUILDER_CODE_ENV] = code;
  t.after(() => { delete process.env[BUILDER_CODE_ENV]; });
  const facilitator = fakeFacilitator();
  const app = createApp(CONFIG, { facilitatorClient: facilitator, catalogue: null, log: () => {},
    upstream: async () => { throw new Error("no model is asked for credit"); } });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}${CREDIT_ROUTE}`, facilitator };
}

const post = (url, body, headers = {}) => fetch(url, { method: "POST",
  headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const decode = (header) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));
const pay = (required, network, extensions) => ({ "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2,
  resource: required.resource, accepted: required.accepts.find((a) => a.network === network),
  payload: { signature: "0xsigned" }, ...(extensions ? { extensions } : {}) })).toString("base64") });

test("with the code set, the 402 declares it as the app code", async (t) => {
  const { url } = await serve(t, CODE);
  const required = decode((await post(url, { amountAtomic: "5000000" })).headers.get("payment-required"));
  assert.equal(required.extensions["builder-code"].info.a, CODE);
  assert.equal(required.extensions["builder-code"].info.w, undefined);
});

test("a Base payment that echoes the declaration settles with it, and one that echoes nothing still settles", async (t) => {
  const { url, facilitator } = await serve(t, CODE);
  const required = decode((await post(url, { amountAtomic: "5000000" })).headers.get("payment-required"));
  const echoed = await post(url, { amountAtomic: "5000000" }, pay(required, BASE, required.extensions));
  assert.equal(echoed.status, 200);
  assert.equal(facilitator.calls.settle.at(-1).extensions["builder-code"].info.a, CODE);
  const plain = await post(url, { amountAtomic: "5000000" }, pay(required, BASE));
  assert.equal(plain.status, 200);
  assert.equal(facilitator.calls.settle.length, 2);
});

test("an echo that changes the app code is refused before settlement", async (t) => {
  const { url, facilitator } = await serve(t, CODE);
  const required = decode((await post(url, { amountAtomic: "5000000" })).headers.get("payment-required"));
  const forged = { ...required.extensions, "builder-code": { ...required.extensions["builder-code"], info: { a: "bc_other" } } };
  const response = await post(url, { amountAtomic: "5000000" }, pay(required, BASE, forged));
  assert.notEqual(response.status, 200);
  assert.equal(facilitator.calls.settle.length, 0);
});

test("unset or invalid: the 402 has no builder-code extension at all", async (t) => {
  for (const code of [undefined, "", "BC-Not-Valid"]) {
    const { url } = await serve(t, code);
    const required = decode((await post(url, { amountAtomic: "5000000" })).headers.get("payment-required"));
    assert.equal(required.extensions?.["builder-code"], undefined, String(code));
  }
});

test("withBuilderCode leaves Solana-only routes alone and never logs the value", () => {
  const server = { exts: new Set(), hasExtension(k) { return this.exts.has(k); }, registerExtension(e) { this.exts.add(e.key); } };
  const routes = withBuilderCode({
    "POST /sol": { accepts: [{ network: SOLANA }] },
    "POST /base": { accepts: [{ network: SOLANA }, { network: BASE }], extensions: { bazaar: { info: {} } } },
    "POST /dynamic": { accepts: () => [] },
  }, server, CODE);
  assert.equal(routes["POST /sol"].extensions, undefined);
  assert.deepEqual(Object.keys(routes["POST /base"].extensions), ["bazaar", "builder-code"]);
  assert.equal(routes["POST /dynamic"].extensions["builder-code"].info.a, CODE);
  assert.ok(server.exts.has("builder-code"));
  const lines = [];
  assert.equal(appBuilderCode({ [BUILDER_CODE_ENV]: "Not valid; secret" }, (line) => lines.push(line)), null);
  assert.ok(lines.every((line) => !line.includes("secret")));
});

test("the metered chat route declares it on its Base offers too", async (t) => {
  const { url } = await serve(t, CODE);
  const chat = url.replace(CREDIT_ROUTE, "/v1/chat/completions");
  const response = await post(chat, { model: CONFIG.model, messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 402);
  const required = decode(response.headers.get("payment-required"));
  assert.ok(required.accepts.some((a) => a.network === BASE));
  assert.equal(required.extensions["builder-code"].info.a, CODE);
  assert.ok(required.extensions.bazaar, "discovery stays declared");
});

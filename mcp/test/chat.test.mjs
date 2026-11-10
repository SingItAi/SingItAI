// singit_chat end to end, offline: a real MCP client -> this server -> @singitai/sdk -> a local mock merchant
// that issues a real x402 challenge for Base and verifies the wallet's signature (test/helpers/merchant.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { NETWORKS } from "@singitai/sdk";
import { startMerchant } from "./helpers/merchant.mjs";
import { connect, tempHome } from "./helpers/client.mjs";

const FACILITATOR = `0x${"0".repeat(39)}2`;
// The offer @singitai/sdk is pinned to on Base (asset and payee come from the SDK's own pins).
const baseOffer = (overrides = {}) => ({
  scheme: "upto", network: NETWORKS.base.caip, asset: NETWORKS.base.asset, payTo: NETWORKS.base.payTo,
  amount: "9000", maxTimeoutSeconds: 120,
  extra: { facilitatorAddress: FACILITATOR, assetTransferMethod: "permit2", name: "USD Coin", version: "2",
    billing: { mode: "actual_usage", maxChargeAtomic: "9000" } },
  ...overrides,
});
const messages = [{ role: "user", content: "Hello" }];
const storedKey = home => JSON.parse(readFileSync(path.join(home, "session"), "utf8")).privateKey;

async function setup(t, merchantOptions, extraEnv = {}) {
  const merchant = await startMerchant({ offer: baseOffer(), ...merchantOptions });
  t.after(() => merchant.close());
  const env = { SINGIT_HOME: tempHome(t), SINGIT_ASK_URL: merchant.url, ...extraEnv };
  return { merchant, env, ...(await connect(t, { env })) };
}

test("singit_chat pays the 402 from a wallet it creates and returns the 200 completion", async t => {
  const { merchant, env, call } = await setup(t);
  const result = await call("singit_chat", { messages });

  assert.equal(result.isError, false, result.text);
  assert.equal(result.data.choices[0].message.content, "Hello back.");
  assert.equal(result.data.model, "deepseek-v4.1-flash"); // the default model was sent
  assert.deepEqual(result.data.payment, { scheme: "upto", network: "base", amountAtomic: "4500", txHash: `0x${"ab".repeat(32)}` });

  // Two requests: the unpaid one got 402 (not an answer), the signed retry got 200.
  assert.deepEqual(merchant.requests.map(r => r.status), [402, 200]);
  assert.equal(merchant.requests[0].headers["payment-signature"], undefined);
  assert.equal(merchant.requests[0].headers.authorization, undefined);

  // The payment was signed by the wallet persisted on first use, and the key stayed out of the result.
  const wallet = await call("singit_wallet", { action: "status" });
  assert.equal(merchant.requests[1].payer.toLowerCase(), wallet.data.address.toLowerCase());
  assert.equal(result.raw.toLowerCase().includes(storedKey(env.SINGIT_HOME).slice(2).toLowerCase()), false);
});

test("a 402 is never an answer: a refused payment is an error with the funding hint, and is not retried", async t => {
  const { merchant, env, call } = await setup(t, { funded: false });
  const result = await call("singit_chat", { messages, model: "deepseek-v4.1-flash" });

  assert.equal(result.isError, true);
  assert.match(result.text, /HTTP 402/);
  assert.match(result.text, /USDC on Base/);
  assert.equal(result.text.includes("Payment refused."), false); // the 402 body is not passed off as content
  assert.deepEqual(merchant.requests.map(r => r.status), [402, 402]);
  assert.equal(result.raw.toLowerCase().includes(storedKey(env.SINGIT_HOME).slice(2).toLowerCase()), false);
});

test("an offer above SINGIT_MAX_PER_CALL_USD is refused before anything is signed", async t => {
  const { merchant, call } = await setup(t, {}, { SINGIT_MAX_PER_CALL_USD: "0.001" }); // offer asks up to $0.009
  const result = await call("singit_chat", { messages });
  assert.equal(result.isError, true);
  assert.match(result.text, /per-call ceiling/);
  assert.deepEqual(merchant.requests.map(r => r.status), [402]); // no signed retry left the machine
});

test("an offer paying someone other than SingIt is refused before anything is signed", async t => {
  const { merchant, call } = await setup(t, { offer: baseOffer({ payTo: `0x${"0".repeat(36)}dead` }) });
  const result = await call("singit_chat", { messages });
  assert.equal(result.isError, true);
  assert.match(result.text, /Unexpected payee/);
  assert.deepEqual(merchant.requests.map(r => r.status), [402]);
});

test("SINGIT_MAX_PER_DAY_USD caps the session across calls", async t => {
  // Each call reserves the $0.009 ceiling and settles at $0.0045: two fit under $0.015, a third
  // ($0.009 spent + $0.009 ceiling) does not, and is refused before signing.
  const { merchant, call } = await setup(t, {}, { SINGIT_MAX_PER_DAY_USD: "0.015" });
  assert.equal((await call("singit_chat", { messages })).isError, false);
  assert.equal((await call("singit_chat", { messages })).isError, false);
  const third = await call("singit_chat", { messages });
  assert.equal(third.isError, true);
  assert.match(third.text, /Daily spend cap/);
  assert.deepEqual(merchant.requests.map(r => r.status), [402, 200, 402, 200, 402]);
});

test("singit_models is free: one GET, no payment, no wallet", async t => {
  const { merchant, env, call } = await setup(t);
  const result = await call("singit_models");
  assert.equal(result.isError, false);
  assert.equal(result.data.data[0].id, "deepseek-v4.1-flash");
  assert.deepEqual(merchant.requests.map(r => [r.method, r.path, r.status]), [["GET", "/v1/models", 200]]);
  assert.equal(existsSync(env.SINGIT_HOME), false);
});

test("API-key mode sends the Bearer key, signs nothing and never writes ~/.singit/session", async t => {
  const apiKey = "sk_singit_test_not_a_real_key";
  const { merchant, env, call } = await setup(t, { acceptBearer: apiKey }, { SINGIT_API_KEY: apiKey });

  const chat = await call("singit_chat", { messages });
  assert.equal(chat.isError, false, chat.text);
  assert.equal(chat.data.choices[0].message.content, "Hello back.");
  assert.equal(merchant.requests.length, 1);
  assert.equal(merchant.requests[0].headers.authorization, `Bearer ${apiKey}`);
  assert.equal(merchant.requests[0].headers["payment-signature"], undefined);

  for (const action of ["status", "setup"]) {
    const wallet = await call("singit_wallet", { action });
    assert.equal(wallet.data.mode, "api_key");
    assert.equal(wallet.data.walletExists, false);
    assert.match(wallet.data.message, /no local wallet/);
    assert.equal(wallet.raw.includes(apiKey), false);
  }
  await call("singit_models");
  assert.equal(existsSync(env.SINGIT_HOME), false);
  assert.equal(chat.raw.includes(apiKey), false);
});

test("API-key mode: a 402 is an error, not an answer, and no wallet is created to pay it", async t => {
  const apiKey = "sk_singit_test_not_a_real_key";
  const { merchant, env, call } = await setup(t, {}, { SINGIT_API_KEY: apiKey }); // merchant ignores the key
  const chat = await call("singit_chat", { messages });
  assert.equal(chat.isError, true);
  assert.match(chat.text, /HTTP 402/);
  assert.deepEqual(merchant.requests.map(r => r.status), [402]);
  assert.equal(existsSync(env.SINGIT_HOME), false);
  assert.equal(chat.raw.includes(apiKey), false);
});

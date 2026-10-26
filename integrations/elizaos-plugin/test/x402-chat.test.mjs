import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey } from "viem/accounts";
import { payAskRequest } from "../src/x402/pay.js";
import { DailyLimiter, usdToAtomic, SingItPaymentError, BASE_PIN } from "../src/x402/guards.js";
import { singitPaidChatAction } from "../src/actions/paid-chat.js";
import { startMockMerchant, uptoOffer, exactOffer } from "./helpers/mock-merchant.mjs";

function makeRuntime(settings = {}) {
  return { getSetting: key => (key in settings ? settings[key] : null) };
}

const privateKey = generatePrivateKey();

test("payAskRequest pays the upto offer and settles for the actual (lower) billed amount", async () => {
  const merchant = await startMockMerchant({
    accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "9000", facilitatorAddress: "0x0000000000000000000000000000000000000002" })],
  });
  try {
    const limiter = new DailyLimiter(usdToAtomic(1));
    const { response, payment } = await payAskRequest({
      body: { messages: [{ role: "user", content: "Hello" }] }, baseUrl: merchant.url,
      evmPrivateKey: privateKey, limiter, maxPerCallAtomic: usdToAtomic(0.01),
    });
    assert.equal(response.choices[0].message.content, "Hello back.");
    assert.equal(payment.scheme, "upto");
    assert.equal(payment.network, "base");
    assert.equal(payment.amountAtomic, "4500"); // merchant bills half the 9000 ceiling for upto
  } finally {
    await merchant.close();
  }
});

test("payAskRequest refuses an offer whose payTo is not the pinned SingIt Ask address", async () => {
  const otherAddress = "0x000000000000000000000000000000000000dead";
  const merchant = await startMockMerchant({
    accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: otherAddress, amount: "9000", facilitatorAddress: "0x0000000000000000000000000000000000000002" })],
  });
  try {
    const limiter = new DailyLimiter(usdToAtomic(1));
    await assert.rejects(payAskRequest({
      body: { messages: [{ role: "user", content: "Hello" }] }, baseUrl: merchant.url,
      evmPrivateKey: privateKey, limiter, maxPerCallAtomic: usdToAtomic(0.01),
    }), SingItPaymentError);
  } finally {
    await merchant.close();
  }
});

test("payAskRequest refuses an offer over the configured per-call ceiling", async () => {
  const merchant = await startMockMerchant({
    accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "50000", facilitatorAddress: "0x0000000000000000000000000000000000000002" })],
  });
  try {
    const limiter = new DailyLimiter(usdToAtomic(1));
    await assert.rejects(payAskRequest({
      body: { messages: [{ role: "user", content: "Hello" }] }, baseUrl: merchant.url,
      evmPrivateKey: privateKey, limiter, maxPerCallAtomic: usdToAtomic(0.01), // 10000 micro-USDC cap
    }), /per-call ceiling/);
  } finally {
    await merchant.close();
  }
});

test("payAskRequest enforces the daily cap across repeated calls", async () => {
  const merchant = await startMockMerchant({
    accepts: () => [exactOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "4000" })],
  });
  try {
    const limiter = new DailyLimiter(usdToAtomic(0.006)); // 6000 micro-USDC/day
    await payAskRequest({
      body: { messages: [{ role: "user", content: "First" }] }, baseUrl: merchant.url, scheme: "exact",
      evmPrivateKey: privateKey, limiter, maxPerCallAtomic: usdToAtomic(0.01),
    });
    await assert.rejects(payAskRequest({
      body: { messages: [{ role: "user", content: "Second" }] }, baseUrl: merchant.url, scheme: "exact",
      evmPrivateKey: privateKey, limiter, maxPerCallAtomic: usdToAtomic(0.01),
    }), /Daily spend cap/);
  } finally {
    await merchant.close();
  }
});

test("SINGIT_PAID_CHAT validate() is false unless the wallet key and both caps are all configured", async () => {
  assert.equal(await singitPaidChatAction.validate(makeRuntime(), { content: { text: "ask singit ask: hello" } }), false);
  assert.equal(await singitPaidChatAction.validate(
    makeRuntime({ SINGIT_EVM_PRIVATE_KEY: privateKey }), { content: { text: "ask singit ask: hello" } },
  ), false);
  assert.equal(await singitPaidChatAction.validate(
    makeRuntime({ SINGIT_EVM_PRIVATE_KEY: privateKey, SINGIT_MAX_PER_CALL_USD: "0.01", SINGIT_MAX_PER_DAY_USD: "1" }),
    { content: { text: "ask singit ask: hello" } },
  ), true);
});

test("SINGIT_PAID_CHAT handler refuses without configured caps and never attempts a payment", async () => {
  const merchant = await startMockMerchant({
    accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "9000", facilitatorAddress: "0x0000000000000000000000000000000000000002" })],
  });
  try {
    const runtime = makeRuntime({ SINGIT_ASK_BASE_URL: merchant.url });
    let callback;
    const result = await singitPaidChatAction.handler(
      runtime, { content: { text: "ask singit ask: hello" } }, undefined, undefined, args => { callback = args; },
    );
    assert.equal(result.success, false);
    assert.equal(result.error, "missing_wallet_or_caps");
    assert.match(callback.text, /needs SINGIT_EVM_PRIVATE_KEY/);
  } finally {
    await merchant.close();
  }
});

test("SINGIT_PAID_CHAT handler pays over x402 once the wallet key and caps are configured", async () => {
  const merchant = await startMockMerchant({
    accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "9000", facilitatorAddress: "0x0000000000000000000000000000000000000002" })],
  });
  try {
    const runtime = makeRuntime({
      SINGIT_ASK_BASE_URL: merchant.url, SINGIT_EVM_PRIVATE_KEY: privateKey,
      SINGIT_MAX_PER_CALL_USD: "0.01", SINGIT_MAX_PER_DAY_USD: "1",
    });
    let callback;
    const result = await singitPaidChatAction.handler(
      runtime, { content: { text: "ask singit ask: hello" } }, undefined, undefined, args => { callback = args; },
    );
    assert.equal(result.success, true);
    assert.equal(result.data.payment.network, "base");
    assert.match(callback.text, /Hello back\./);
    assert.match(callback.text, /paid \d+ atomic USDC on Base/);
  } finally {
    await merchant.close();
  }
});

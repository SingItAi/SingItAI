// End-to-end: SingIt.chat() against a local mock merchant on Base Sepolia (eip155:84532), with a
// real EIP-712 signature produced by @x402/evm's client schemes and verified by the merchant
// (test/helpers/merchant.mjs) using viem — no facilitator, no chain, no network access.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generatePrivateKey } from "viem/accounts";
import { SingIt } from "../src/index.js";
import { SingItPaymentError } from "../src/guards.js";
import { startMerchant, uptoOffer, exactOffer } from "./helpers/merchant.mjs";

const addr = suffix => `0x${"0".repeat(40 - suffix.length)}${suffix}`;

const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC
const NETWORK = "eip155:84532";
const PAY_TO = addr("ab1e");
const FACILITATOR = addr("2");
const OTHER_ADDRESS = addr("dead");
const privateKey = generatePrivateKey();

function makeSingIt({ merchant, maxPerCallUsd = 1, maxPerDayUsd = 10, payTo = PAY_TO }) {
  return new SingIt({ evmPrivateKey: privateKey, network: "base-sepolia", baseUrl: merchant.url,
    payTo, maxPerCallUsd, maxPerDayUsd });
}

test("chat() pays the upto offer (default scheme) and settles for the actual (lower) billed amount", async () => {
  const merchant = await startMerchant({
    accepts: () => [uptoOffer({ network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: "9000", facilitatorAddress: FACILITATOR })],
  });
  try {
    const singit = makeSingIt({ merchant, maxPerCallUsd: 0.01 });
    const result = await singit.chat({ messages: [{ role: "user", content: "Hello" }] });
    assert.equal(result.choices[0].message.content, "Hello back.");
    assert.equal(result.payment.scheme, "upto");
    assert.equal(result.payment.network, "base-sepolia");
    assert.equal(result.payment.amountAtomic, "4500"); // merchant bills half the 9000 ceiling for upto
    assert.equal(result.payment.txHash, `0x${"ab".repeat(32)}`);
  } finally {
    await merchant.close();
  }
});

test("chat({ scheme: 'exact' }) pays the flat ceiling and the merchant bills exactly that", async () => {
  const merchant = await startMerchant({
    accepts: () => [exactOffer({ network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: "3000" })],
  });
  try {
    const singit = makeSingIt({ merchant, maxPerCallUsd: 0.01 });
    const result = await singit.chat({ messages: [{ role: "user", content: "Hello" }], scheme: "exact" });
    assert.equal(result.payment.scheme, "exact");
    assert.equal(result.payment.amountAtomic, "3000");
  } finally {
    await merchant.close();
  }
});

test("chat() refuses to sign when the merchant's payTo does not match the pinned address", async () => {
  const merchant = await startMerchant({
    accepts: () => [uptoOffer({ network: NETWORK, asset: ASSET, payTo: OTHER_ADDRESS, amount: "9000", facilitatorAddress: FACILITATOR })],
  });
  try {
    const singit = makeSingIt({ merchant, maxPerCallUsd: 0.01, payTo: PAY_TO });
    await assert.rejects(singit.chat({ messages: [{ role: "user", content: "Hello" }] }), SingItPaymentError);
  } finally {
    await merchant.close();
  }
});

test("chat() refuses to sign when the merchant's asset does not match the pinned asset", async () => {
  const merchant = await startMerchant({
    accepts: () => [uptoOffer({ network: NETWORK, asset: OTHER_ADDRESS, payTo: PAY_TO, amount: "9000", facilitatorAddress: FACILITATOR })],
  });
  try {
    const singit = makeSingIt({ merchant, maxPerCallUsd: 0.01 });
    await assert.rejects(singit.chat({ messages: [{ role: "user", content: "Hello" }] }), SingItPaymentError);
  } finally {
    await merchant.close();
  }
});

test("chat() refuses an offer over the configured per-call ceiling", async () => {
  const merchant = await startMerchant({
    accepts: () => [uptoOffer({ network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: "50000", facilitatorAddress: FACILITATOR })],
  });
  try {
    const singit = makeSingIt({ merchant, maxPerCallUsd: 0.01 }); // 0.01 USD = 10000 micro-USDC cap
    await assert.rejects(singit.chat({ messages: [{ role: "user", content: "Hello" }] }), /per-call ceiling/);
  } finally {
    await merchant.close();
  }
});

test("chat() enforces the daily cap across repeated calls", async () => {
  const merchant = await startMerchant({
    accepts: () => [uptoOffer({ network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: "4000", facilitatorAddress: FACILITATOR })],
    bill: () => "4000", // this merchant always bills the full ceiling
  });
  try {
    const singit = makeSingIt({ merchant, maxPerCallUsd: 0.01, maxPerDayUsd: 0.006 }); // cap: 6000 micro-USDC/day
    await singit.chat({ messages: [{ role: "user", content: "First" }] }); // spends 4000, 2000 left
    await assert.rejects(
      singit.chat({ messages: [{ role: "user", content: "Second" }] }), // would need another 4000
      /Daily spend cap/,
    );
  } finally {
    await merchant.close();
  }
});

test("chat() returns payment: null when the merchant answers without a 402 (e.g. a free model)", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "free-1", object: "chat.completion", created: 0, model: "free/demo",
      choices: [{ index: 0, message: { role: "assistant", content: "Free answer." }, finish_reason: "stop" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const singit = new SingIt({ evmPrivateKey: privateKey, network: "base-sepolia", baseUrl: url,
      payTo: PAY_TO, maxPerCallUsd: 0.01, maxPerDayUsd: 1 });
    const result = await singit.chat({ messages: [{ role: "user", content: "Hello" }], model: "free/demo" });
    assert.equal(result.payment, null);
    assert.equal(result.choices[0].message.content, "Free answer.");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("SingIt refuses to construct for base-sepolia without an explicit payTo", () => {
  assert.throws(() => new SingIt({ evmPrivateKey: privateKey, network: "base-sepolia", maxPerCallUsd: 0.01, maxPerDayUsd: 1 }),
    /no deployment on base-sepolia/);
});

test("SingIt refuses to construct without spending ceilings", () => {
  assert.throws(() => new SingIt({ evmPrivateKey: privateKey, network: "base", maxPerCallUsd: 0.01 }),
    /never pays without a ceiling/);
});

for (const billed of ["1000", "4001"]) {
  test(`exact billing ${billed} keeps the full authorization reserved`, async () => {
    let paid = 0;
    const merchant = await startMerchant({
      accepts: () => [exactOffer({ network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: "4000" })],
      bill: () => { paid++; return billed; },
    });
    try {
      const client = makeSingIt({ merchant, maxPerCallUsd: 0.004, maxPerDayUsd: 0.006 });
      const invoke = () => client.chat({ messages: [{ role: "user", content: "Hello" }], scheme: "exact" });
      await assert.rejects(invoke(), /invoice does not match.*unresolved/);
      assert.equal(client.limiter.remainingAtomic(), 2000n);
      await assert.rejects(invoke(), /Daily spend cap/);
      assert.equal(paid, 1);
    } finally {
      await merchant.close();
    }
  });
}

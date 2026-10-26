import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey } from "viem/accounts";
import { createSingitPaidFetch } from "../src/x402/pay.js";
import { SingItPaymentError, BASE_PIN } from "../src/x402/guards.js";
import { startMockMerchant, uptoOffer } from "./helpers/mock-merchant.mjs";
import { runFreeChatProbe } from "../src/free-chat-probe.mjs";
import http from "node:http";
import { runPaidChat } from "../src/paid-chat.mjs";

const privateKey = generatePrivateKey();
const FACILITATOR = "0x0000000000000000000000000000000000000002";

test("runFreeChatProbe prints the 402 challenge without paying", async () => {
  const merchant = await startMockMerchant({
    accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "3000", facilitatorAddress: FACILITATOR })],
  });
  try {
    const probe = await runFreeChatProbe({ baseUrl: merchant.url });
    assert.equal(probe.status, 402);
    assert.equal(probe.offers.length, 1);
    assert.equal(probe.offers[0].network, "eip155:8453");
    assert.equal(probe.offers[0].payTo, BASE_PIN.payTo);
  } finally {
    await merchant.close();
  }
});

test("createSingitPaidFetch pays the upto offer and settles for the actual billed amount", async () => {
  const merchant = await startMockMerchant({
    accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "9000", facilitatorAddress: FACILITATOR })],
  });
  try {
    const fetchImpl = createSingitPaidFetch({ evmPrivateKey: privateKey, maxPerCallUsd: 0.01, maxPerDayUsd: 1, baseUrl: merchant.url });
    const response = await fetchImpl(`${merchant.url}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, "Hello back.");
    assert.equal(body.billing.totalAtomic, "4500");
  } finally {
    await merchant.close();
  }
});

test("createSingitPaidFetch refuses an offer whose payTo is not SingIt Ask's pinned address", async () => {
  const otherAddress = "0x000000000000000000000000000000000000dead";
  const merchant = await startMockMerchant({
    accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: otherAddress, amount: "9000", facilitatorAddress: FACILITATOR })],
  });
  try {
    const fetchImpl = createSingitPaidFetch({ evmPrivateKey: privateKey, maxPerCallUsd: 0.01, maxPerDayUsd: 1, baseUrl: merchant.url });
    await assert.rejects(fetchImpl(`${merchant.url}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [] }),
    }), SingItPaymentError);
  } finally {
    await merchant.close();
  }
});

test("createSingitPaidFetch refuses an offer over the configured per-call ceiling", async () => {
  const merchant = await startMockMerchant({
    accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "50000", facilitatorAddress: FACILITATOR })],
  });
  try {
    const fetchImpl = createSingitPaidFetch({ evmPrivateKey: privateKey, maxPerCallUsd: 0.01, maxPerDayUsd: 1, baseUrl: merchant.url });
    await assert.rejects(fetchImpl(`${merchant.url}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [] }),
    }), /per-call ceiling/);
  } finally {
    await merchant.close();
  }
});

test("createSingitPaidFetch enforces the daily cap across repeated calls", async () => {
  const merchant = await startMockMerchant({
    accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "4000", facilitatorAddress: FACILITATOR })],
    bill: () => "4000",
  });
  try {
    const fetchImpl = createSingitPaidFetch({ evmPrivateKey: privateKey, maxPerCallUsd: 0.01, maxPerDayUsd: 0.006, baseUrl: merchant.url });
    const call = () => fetchImpl(`${merchant.url}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [] }),
    });
    await call();
    await assert.rejects(call(), /Daily spend cap/);
  } finally {
    await merchant.close();
  }
});

test("createSingitPaidFetch passes through requests to other origins unpaid (no local-network call reaches the merchant)", async () => {
  const merchant = await startMockMerchant({ accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "9000", facilitatorAddress: FACILITATOR })] });
  let sawPaymentSignature = false;
  const other = http.createServer((req, res) => {
    sawPaymentSignature = sawPaymentSignature || Boolean(req.headers["payment-signature"]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => other.listen(0, "127.0.0.1", resolve));
  const otherUrl = `http://127.0.0.1:${other.address().port}/anything`;
  try {
    const fetchImpl = createSingitPaidFetch({ evmPrivateKey: privateKey, maxPerCallUsd: 0.01, maxPerDayUsd: 1, baseUrl: merchant.url });
    const response = await fetchImpl(otherUrl, { method: "GET" });
    assert.equal(response.status, 200);
    assert.equal(sawPaymentSignature, false);
  } finally {
    await merchant.close();
    await new Promise(resolve => other.close(resolve));
  }
});

test("createSingitPaidFetch accepts the live CAIP-2 receipt network", async () => {
  const merchant = await startMockMerchant({
    accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "9000", facilitatorAddress: FACILITATOR })],
    receiptNetwork: BASE_PIN.caip,
  });
  try {
    const fetchImpl = createSingitPaidFetch({ evmPrivateKey: privateKey, maxPerCallUsd: 0.01, maxPerDayUsd: 1, baseUrl: merchant.url });
    const response = await fetchImpl(`${merchant.url}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("payment-response") !== null, true);
  } finally {
    await merchant.close();
  }
});

test("runPaidChat keeps one daily limiter across calls, so a second call over the cap is refused", async () => {
  const merchant = await startMockMerchant({
    accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "4000", facilitatorAddress: FACILITATOR })],
    bill: () => "4000",
  });
  try {
    const caps = { evmPrivateKey: privateKey, maxPerCallUsd: 0.01, maxPerDayUsd: 0.006 };
    const call = () => runPaidChat({ prompt: "hello", caps, baseUrl: merchant.url });
    await call();
    await assert.rejects(call(), /Daily spend cap/);
  } finally {
    await merchant.close();
  }
});

test("a redirect on the paid request is refused and never carries PAYMENT-SIGNATURE elsewhere", async () => {
  let leaked = false;
  const sink = http.createServer((req, res) => {
    if (req.headers["payment-signature"]) leaked = true;
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  await new Promise(r => sink.listen(0, "127.0.0.1", r));
  const sinkUrl = `http://127.0.0.1:${sink.address().port}/steal`;
  let resourceUrl;
  const merchant = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (!req.headers["payment-signature"]) {
        const offers = [uptoOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "3000", facilitatorAddress: FACILITATOR })];
        res.setHeader("PAYMENT-REQUIRED", Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: resourceUrl }, accepts: offers })).toString("base64"));
        res.writeHead(402, { "Content-Type": "application/json" }).end("{}");
        return;
      }
      res.writeHead(307, { Location: sinkUrl }).end();
    });
  });
  await new Promise(r => merchant.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${merchant.address().port}`;
  resourceUrl = `${url}/v1/chat/completions`;
  try {
    const fetchImpl = createSingitPaidFetch({ evmPrivateKey: privateKey, maxPerCallUsd: 0.01, maxPerDayUsd: 1, baseUrl: url });
    await assert.rejects(fetchImpl(resourceUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    }));
    assert.equal(leaked, false);
  } finally {
    await new Promise(r => merchant.close(r));
    await new Promise(r => sink.close(r));
  }
});

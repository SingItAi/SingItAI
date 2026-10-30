// singit.paidFetch(): the guarded fetch for LangChain / Vercel AI SDK / OpenAI SDK, against the same local
// mock merchant on Base Sepolia as chat.test.mjs. Real EIP-712 signatures, no facilitator, no chain, no network.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generatePrivateKey } from "viem/accounts";
import { SingIt } from "../src/index.js";
import { SingItPaymentError } from "../src/guards.js";
import { startMerchant, uptoOffer, exactOffer } from "./helpers/merchant.mjs";

const addr = suffix => `0x${"0".repeat(40 - suffix.length)}${suffix}`;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:84532";
const PAY_TO = addr("ab1e");
const FACILITATOR = addr("2");
const OTHER_ADDRESS = addr("dead");
const privateKey = generatePrivateKey();

const make = (merchant, { maxPerCallUsd = 0.01, maxPerDayUsd = 1, payTo = PAY_TO } = {}) =>
  new SingIt({ evmPrivateKey: privateKey, network: "base-sepolia", baseUrl: merchant.url, payTo, maxPerCallUsd, maxPerDayUsd });
const post = (singitFetch, url) => singitFetch(`${url}/v1/chat/completions`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
});

test("paidFetch() pays a 402 with the upto offer and returns a readable response", async () => {
  const merchant = await startMerchant({
    accepts: () => [uptoOffer({ network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: "9000", facilitatorAddress: FACILITATOR })],
  });
  try {
    const response = await post(make(merchant).paidFetch(), merchant.url);
    assert.equal(response.status, 200);
    const answer = await response.json();
    assert.equal(answer.choices[0].message.content, "Hello back.");
    assert.equal(answer.billing.totalAtomic, "4500");
  } finally {
    await merchant.close();
  }
});

test("paidFetch({ scheme: 'exact' }) pays the flat offer", async () => {
  const merchant = await startMerchant({
    accepts: () => [exactOffer({ network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: "3000" })],
  });
  try {
    const answer = await (await post(make(merchant).paidFetch({ scheme: "exact" }), merchant.url)).json();
    assert.equal(answer.billing.totalAtomic, "3000");
  } finally {
    await merchant.close();
  }
});

test("paidFetch() refuses a wrong payee and an offer over the per-call ceiling before signing", async () => {
  const wrongPayee = await startMerchant({
    accepts: () => [uptoOffer({ network: NETWORK, asset: ASSET, payTo: OTHER_ADDRESS, amount: "9000", facilitatorAddress: FACILITATOR })],
  });
  const tooDear = await startMerchant({
    accepts: () => [uptoOffer({ network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: "50000", facilitatorAddress: FACILITATOR })],
  });
  try {
    await assert.rejects(post(make(wrongPayee).paidFetch(), wrongPayee.url), SingItPaymentError);
    await assert.rejects(post(make(tooDear).paidFetch(), tooDear.url), /per-call ceiling/);
  } finally {
    await wrongPayee.close();
    await tooDear.close();
  }
});

test("paidFetch() and chat() share one daily cap on the same instance", async () => {
  const merchant = await startMerchant({
    accepts: () => [uptoOffer({ network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: "4000", facilitatorAddress: FACILITATOR })],
    bill: () => "4000",
  });
  try {
    const singit = make(merchant, { maxPerDayUsd: 0.006 }); // 6000 micro-USDC a day
    await singit.chat({ messages: [{ role: "user", content: "First" }] });
    await assert.rejects(post(singit.paidFetch(), merchant.url), /Daily spend cap/);
  } finally {
    await merchant.close();
  }
});

test("paidFetch() passes other origins and non-402 answers through, never paying", async () => {
  let seen = 0;
  const server = http.createServer((req, res) => {
    seen += 1;
    res.writeHead(402, { "payment-required": "AAAA" });
    res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const other = `http://127.0.0.1:${server.address().port}`;
  const merchant = await startMerchant({ accepts: () => [] });
  try {
    const singit = make(merchant);
    const response = await post(singit.paidFetch(), other); // other origin: returned as is, even a 402
    assert.equal(response.status, 402);
    assert.equal(seen, 1);
  } finally {
    await merchant.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test("paidFetch() treats a paid answer without a billing invoice as unresolved and keeps its ceiling counted", async () => {
  let paidRequests = 0;
  const server = http.createServer(async (req, res) => {
    if (!req.headers["payment-signature"]) {
      const challenge = { x402Version: 2, resource: { url: `http://127.0.0.1:${server.address().port}/v1/chat/completions` },
        accepts: [uptoOffer({ network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: "4000", facilitatorAddress: FACILITATOR })] };
      res.writeHead(402, { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") });
      return res.end("{}");
    }
    paidRequests += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("data: {}\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const singit = new SingIt({ evmPrivateKey: privateKey, network: "base-sepolia", baseUrl: url, payTo: PAY_TO,
      maxPerCallUsd: 0.01, maxPerDayUsd: 0.006 });
    const pay = singit.paidFetch();
    await assert.rejects(post(pay, url), /invoice does not match/);
    await assert.rejects(post(pay, url), /Daily spend cap/); // the first ceiling (4000) is still counted
    assert.equal(paidRequests, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("paidFetch() rejects an unknown scheme", () => {
  const singit = new SingIt({ evmPrivateKey: privateKey, network: "base-sepolia", payTo: PAY_TO, maxPerCallUsd: 0.01, maxPerDayUsd: 1 });
  assert.throws(() => singit.paidFetch({ scheme: "other" }), /scheme must be/);
});

for (const billed of ["1000", "4001"]) {
  test(`exact billing ${billed} keeps the full authorization reserved`, async () => {
    let paid = 0;
    const merchant = await startMerchant({
      accepts: () => [exactOffer({ network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: "4000" })],
      bill: () => { paid++; return billed; },
    });
    try {
      const client = make(merchant, { maxPerCallUsd: 0.004, maxPerDayUsd: 0.006 });
      const invoke = () => post(client.paidFetch({ scheme: "exact" }), merchant.url);
      await assert.rejects(invoke(), /invoice does not match.*unresolved/);
      assert.equal(client.limiter.remainingAtomic(), 2000n);
      await assert.rejects(invoke(), /Daily spend cap/);
      assert.equal(paid, 1);
    } finally {
      await merchant.close();
    }
  });
}

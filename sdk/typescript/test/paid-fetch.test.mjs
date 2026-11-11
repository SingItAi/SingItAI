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

test("paidFetch() treats a paid stream without a billing invoice as unresolved and keeps its ceiling counted", async () => {
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
    // The stream is handed back live; its body errors when it ends without an invoice.
    await assert.rejects(post(pay, url).then(response => response.text()), /ended without an invoice.*unresolved/);
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

// A merchant that pays out an SSE answer in pieces: the first token, a pause, then the terminal event with the invoice.
async function streamingMerchant({ amount = "4000", billed = "1500", scheme = "upto", pauseMs = 150, terminal } = {}) {
  const wrote = {};
  const server = http.createServer((req, res) => {
    if (!req.headers["payment-signature"]) {
      const offer = scheme === "exact" ? exactOffer({ network: NETWORK, asset: ASSET, payTo: PAY_TO, amount })
        : uptoOffer({ network: NETWORK, asset: ASSET, payTo: PAY_TO, amount, facilitatorAddress: FACILITATOR });
      const challenge = { x402Version: 2, resource: { url: `http://127.0.0.1:${server.address().port}/v1/chat/completions` }, accepts: [offer] };
      res.writeHead(402, { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") });
      return res.end("{}");
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`);
    wrote.first = performance.now();
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`);
      res.write(terminal ?? `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], billing: { totalAtomic: billed } })}\n\n`);
      wrote.last = performance.now();
      res.end("data: [DONE]\n\n");
    }, pauseMs);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, wrote, close: () => new Promise(resolve => server.close(resolve)) };
}
const client = (merchant, maxPerDayUsd = 0.006) => new SingIt({ evmPrivateKey: privateKey, network: "base-sepolia", baseUrl: merchant.url, payTo: PAY_TO, maxPerCallUsd: 0.01, maxPerDayUsd });
const askStream = (pay, url) => pay(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }], stream: true }) });

test("paidFetch() returns a live stream and reads the invoice from a later SSE event", async () => {
  const merchant = await streamingMerchant({ billed: "1500" });
  try {
    const singit = client(merchant);
    const response = await askStream(singit.paidFetch(), merchant.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader();
    const first = await reader.read();
    const firstAt = performance.now();
    assert.match(new TextDecoder().decode(first.value), /Hel/);
    assert.ok(!merchant.wrote.last, "the first token arrived before the merchant wrote its last event");
    assert.ok(firstAt < merchant.wrote.first + 100);
    let rest = "";
    for (let chunk; !(chunk = await reader.read()).done;) rest += new TextDecoder().decode(chunk.value);
    assert.match(rest, /billing/);
    // The reservation (4000) settled down to the billed 1500: 6000 - 1500 left, so a 4000 call still fits twice.
    assert.equal(singit.limiter.remainingAtomic(), 4500n);
  } finally {
    await merchant.close();
  }
});

for (const [name, options] of [["above the offer", { billed: "4001" }], ["not atomic", { billed: "1.5" }], ["off a flat exact offer", { scheme: "exact", billed: "1000" }]]) {
  test(`paidFetch() errors a stream whose invoice is ${name} and keeps the ceiling counted`, async () => {
    const merchant = await streamingMerchant({ pauseMs: 10, ...options });
    try {
      const singit = client(merchant);
      const response = await askStream(singit.paidFetch({ scheme: options.scheme ?? "upto" }), merchant.url);
      await assert.rejects(response.text(), /invoice does not match.*unresolved/);
      assert.equal(singit.limiter.remainingAtomic(), 2000n);
    } finally {
      await merchant.close();
    }
  });
}

test("paidFetch() accepts an exact stream billed at the signed amount", async () => {
  const merchant = await streamingMerchant({ scheme: "exact", amount: "4000", billed: "4000", pauseMs: 10 });
  try {
    const response = await askStream(client(merchant).paidFetch({ scheme: "exact" }), merchant.url);
    assert.match(await response.text(), /"totalAtomic":"4000"/);
  } finally {
    await merchant.close();
  }
});

test("paidFetch() finds the invoice in Messages and Responses terminal events", async () => {
  for (const terminal of [
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: {}, billing: { totalAtomic: "900" } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { billing: { totalAtomic: "900" } } })}\n\n`,
  ]) {
    const merchant = await streamingMerchant({ pauseMs: 5, terminal });
    try {
      const singit = client(merchant);
      await (await askStream(singit.paidFetch(), merchant.url)).text();
      assert.equal(singit.limiter.remainingAtomic(), 5100n);
    } finally {
      await merchant.close();
    }
  }
});

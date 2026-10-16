// Free prices: Chainlink on Base for crypto, metals and the currencies it has, the ECB for the rest; read rarely, said
// where they came from, limited per visitor, never paid.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";
import { PRICE_TERMS, PriceBook } from "../src/prices.mjs";
import FEEDS from "../src/price-feeds.json" with { type: "json" };

const NOW = 1_792_100_000_000;
const FEED = { BTC: { class: "crypto", name: "Bitcoin", symbol: "BTC", address: "0xb", decimals: 8, heartbeat: 1200 },
  ETH: { class: "crypto", name: "Ethereum", symbol: "ETH", address: "0xe", decimals: 8, heartbeat: 1200 },
  XAU: { class: "metal", name: "Gold", symbol: "XAU", address: "0xa", decimals: 8, heartbeat: 86400 },
  EUR: { class: "fiat", name: "Euro", symbol: "EUR", address: "0xu", decimals: 8, heartbeat: 3600 },
  GBP: { class: "fiat", name: "Pound", symbol: "GBP", address: "0xg", decimals: 8, heartbeat: 86400 } };
const ROUNDS = { "0xb": [8_225_430_000_000n, 600], "0xe": [244_186_209_071n, 60_000], "0xa": [416_998_300_000n, 100],
  "0xu": [112_102_500n, 50], "0xg": [132_636_000n, 900] };

function fakes() {
  const calls = { multicall: 0, ecb: 0 };
  const publicClient = { async multicall({ contracts }) {
    calls.multicall += 1;
    return contracts.map(({ address }) => ({ status: "success",
      result: [1n, ROUNDS[address][0], 0n, BigInt(NOW / 1000 - ROUNDS[address][1]), 1n] }));
  } };
  const fetchImpl = async (url) => {
    calls.ecb += 1;
    assert.equal(url, "https://api.frankfurter.dev/v1/latest?base=USD");
    return new Response(JSON.stringify({ base: "USD", date: "2026-10-15", rates: { EUR: 0.89222, JPY: 157.98, PLN: 3.899 } }));
  };
  return { calls, publicClient, fetchImpl };
}

test("crypto and metals in USD from Chainlink, with their age and source", async () => {
  const { publicClient, fetchImpl, calls } = fakes();
  const book = new PriceBook({ publicClient, fetchImpl, now: () => NOW, feeds: FEED });
  assert.deepEqual(await book.usd("crypto", "btc"), { symbol: "BTC", name: "Bitcoin", quote: "USD", price: 82254.3,
    updatedAt: new Date(NOW - 600_000).toISOString(), ageSeconds: 600, stale: false,
    source: "Chainlink Data Feeds on Base", feed: "0xb" });
  assert.equal((await book.usd("crypto", "ETH")).stale, true, "older than 1.5 heartbeats");
  assert.equal((await book.usd("metal", "XAU")).price, 4169.983);
  assert.equal(await book.usd("crypto", "XAU"), null, "gold is a metal");
  assert.equal(await book.usd("crypto", "NOPE"), null);
  assert.equal(calls.multicall, 1, "one multicall serves a minute of questions");
});

test("currencies: Chainlink when both sides have a feed, else the ECB's daily rates", async () => {
  const { publicClient, fetchImpl, calls } = fakes();
  const book = new PriceBook({ publicClient, fetchImpl, now: () => NOW, feeds: FEED });
  const eurUsd = await book.fx("eur", "usd");
  assert.equal((eurUsd.rate).toFixed(6), "1.121025");
  assert.equal(eurUsd.source, "Chainlink Data Feeds on Base");
  assert.equal((await book.fx("GBP", "EUR")).rate.toFixed(5), "1.18317");
  const usdJpy = await book.fx("USD", "JPY");
  assert.deepEqual([usdJpy.rate, usdJpy.date, usdJpy.source.startsWith("European")], [157.98, "2026-10-15", true]);
  assert.equal((await book.fx("EUR", "PLN")).rate.toFixed(4), (3.899 / 0.89222).toFixed(4));
  assert.equal(await book.fx("USD", "XYZ"), null);
  assert.equal(await book.fx("US", "EUR"), null);
  assert.equal(calls.ecb, 1, "the ECB's rates are read once an hour at most");
});

test("a failed refresh keeps the last prices", async () => {
  const { publicClient, fetchImpl } = fakes();
  let clock = NOW;
  const book = new PriceBook({ publicClient, fetchImpl, now: () => clock, feeds: FEED });
  await book.usd("crypto", "BTC");
  publicClient.multicall = async () => { throw new Error("rpc down"); };
  clock += (PRICE_TERMS.chainlinkSeconds + 1) * 1000;
  await book.usd("crypto", "BTC");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await book.usd("crypto", "BTC")).price, 82254.3);
});

test("over HTTP: free, CORS-open, and limited per visitor", async (t) => {
  const { publicClient, fetchImpl } = fakes();
  const book = new PriceBook({ publicClient, fetchImpl, now: () => NOW, feeds: FEED });
  const app = createApp({ payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", payToBase: "0x" + "1".repeat(40),
    surplusKey: "inf_test", model: "deepseek-v4.1-flash" }, { facilitatorClient: { getSupported: async () => ({ kinds: [
      { x402Version: 2, scheme: "exact", network: "eip155:8453" },
      { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
      { x402Version: 2, scheme: "upto", network: "eip155:8453", extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
      { x402Version: 2, scheme: "upto", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", extra: {
        feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88", receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
    ], extensions: [], signers: {} }) }, catalogue: null, priceBook: book, log: () => {} });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  const url = `http://127.0.0.1:${listener.address().port}`;
  const btc = await fetch(`${url}/v1/prices/crypto/BTC`);
  assert.equal(btc.status, 200);
  assert.equal(btc.headers.get("access-control-allow-origin"), "*");
  assert.equal((await btc.json()).price, 82254.3);
  assert.equal((await (await fetch(`${url}/v1/prices/fx/EUR/USD`)).json()).object, "rate");
  assert.equal((await fetch(`${url}/v1/prices/metal/BTC`)).status, 404);
  const list = await (await fetch(`${url}/v1/prices`)).json();
  assert.deepEqual([list.crypto, list.metal, list.fx], [["BTC", "ETH"], ["XAU"], ["EUR", "JPY", "PLN", "USD"]]);
  const spec = await (await fetch(`${url}/openapi.json`)).json();
  assert.deepEqual(spec.paths["/v1/prices/crypto/{symbol}"].get.security, []);
  for (let i = 0; i < PRICE_TERMS.perVisitorPerMinute; i += 1) await fetch(`${url}/v1/prices/crypto/ETH`);
  const limited = await fetch(`${url}/v1/prices/crypto/ETH`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
});

test("the stored feed list: Chainlink proxies on Base, one per symbol", () => {
  const feeds = Object.entries(FEEDS.feeds);
  assert.equal(feeds.length, 70);
  for (const [symbol, feed] of feeds) {
    assert.equal(symbol, symbol.toUpperCase());
    assert.match(feed.address, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(["crypto", "fiat", "metal"].includes(feed.class));
  }
  assert.deepEqual(["BTC", "ETH", "SOL", "XAU", "XAG", "EUR"].map((s) => FEEDS.feeds[s]?.class),
    ["crypto", "crypto", "crypto", "metal", "metal", "fiat"]);
});

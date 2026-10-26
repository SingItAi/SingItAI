import test from "node:test";
import assert from "node:assert/strict";
import { startMockMcpServer } from "./helpers/mock-mcp-server.mjs";
import { extractPriceArgs } from "../src/price-args.js";
import { getSingitPriceAction } from "../src/actions/get-price.js";
import { listSingitPriceSymbolsAction } from "../src/actions/list-price-symbols.js";
import { listSingitModelsAction } from "../src/actions/list-models.js";
import { singitToolsProvider } from "../src/providers/singit-tools-provider.js";

function makeRuntime(settings = {}) {
  return { getSetting: key => (key in settings ? settings[key] : null) };
}

test("SINGIT_GET_PRICE calls the free get_price tool with no key and returns a result", async () => {
  const mock = await startMockMcpServer();
  try {
    const runtime = makeRuntime({ SINGIT_MCP_URL: mock.url });
    let callback;
    const result = await getSingitPriceAction.handler(
      runtime, { content: { text: "What's the price of ETH?" } }, undefined, undefined,
      args => { callback = args; },
    );
    assert.equal(result.success, true);
    assert.equal(result.data.args.symbol, "ETH");
    assert.match(callback.text, /ETH/);
    assert.deepEqual(mock.seenAuthorizationHeaders, [null]); // no key sent for a free tool
  } finally {
    await mock.close();
  }
});

test("extractPriceArgs does not turn contraction fragments into symbols", () => {
  assert.equal(extractPriceArgs("What's the price of BTC?").symbol, "BTC");
  assert.equal(extractPriceArgs("What\u2019s the price of ETH?").symbol, "ETH");
  assert.equal(extractPriceArgs("What's ETH at?").symbol, "ETH");
  assert.equal(extractPriceArgs("how much is eth worth").symbol, "ETH");
  assert.equal(extractPriceArgs("what's the price of ethereum").symbol, "ETH");
  assert.deepEqual(extractPriceArgs("it's worth how much, XAU"), { kind: "metal", symbol: "XAU" });
  assert.deepEqual(extractPriceArgs("What's the EUR to USD rate?"), { kind: "fx", base: "EUR", quote: "USD" });
});

test("extractPriceArgs sends crypto/metal pairs to the crypto/metal lookup and only fiat pairs to fx", () => {
  assert.deepEqual(extractPriceArgs("What is the price of BTC/USD?"), { kind: "crypto", symbol: "BTC" });
  assert.deepEqual(extractPriceArgs("Quote ETH to USD"), { kind: "crypto", symbol: "ETH" });
  assert.deepEqual(extractPriceArgs("XAU/USD please"), { kind: "metal", symbol: "XAU" });
  assert.deepEqual(extractPriceArgs("USD to BTC"), { kind: "crypto", symbol: "BTC" });
  assert.deepEqual(extractPriceArgs("GBP/JPY"), { kind: "fx", base: "GBP", quote: "JPY" });
  assert.deepEqual(extractPriceArgs("What's the EUR to USD rate?"), { kind: "fx", base: "EUR", quote: "USD" });
});

test("SINGIT_GET_PRICE validate() matches price-ish phrasing", async () => {
  assert.equal(await getSingitPriceAction.validate(makeRuntime(), { content: { text: "What's the price of BTC?" } }), true);
  assert.equal(await getSingitPriceAction.validate(makeRuntime(), { content: { text: "Tell me a joke" } }), false);
});

test("SINGIT_LIST_PRICE_SYMBOLS calls the free list_price_symbols tool", async () => {
  const mock = await startMockMcpServer();
  try {
    const runtime = makeRuntime({ SINGIT_MCP_URL: mock.url });
    let callback;
    const result = await listSingitPriceSymbolsAction.handler(
      runtime, { content: { text: "What symbols do you support?" } }, undefined, undefined,
      args => { callback = args; },
    );
    assert.equal(result.success, true);
    assert.match(callback.text, /BTC/);
  } finally {
    await mock.close();
  }
});

test("SINGIT_LIST_MODELS calls the free list_models tool", async () => {
  const mock = await startMockMcpServer();
  try {
    const runtime = makeRuntime({ SINGIT_MCP_URL: mock.url });
    let callback;
    const result = await listSingitModelsAction.handler(
      runtime, { content: { text: "Which models do you have?" } }, undefined, undefined,
      args => { callback = args; },
    );
    assert.equal(result.success, true);
    assert.match(callback.text, /deepseek/);
  } finally {
    await mock.close();
  }
});

test("a free action reports failure (not a throw) when the MCP server is unreachable", async () => {
  const runtime = makeRuntime({ SINGIT_MCP_URL: "http://127.0.0.1:1/mcp" });
  let callback;
  const result = await getSingitPriceAction.handler(
    runtime, { content: { text: "price of BTC" } }, undefined, undefined, args => { callback = args; },
  );
  assert.equal(result.success, false);
  assert.match(callback.text, /Could not get that price/);
});

test("SINGIT_TOOLS provider reports only the free actions when nothing is configured", async () => {
  const result = await singitToolsProvider.get(makeRuntime(), {}, {});
  assert.deepEqual(result.data.available, ["SINGIT_GET_PRICE", "SINGIT_LIST_PRICE_SYMBOLS", "SINGIT_LIST_MODELS"]);
  assert.equal(result.data.hasApiKey, false);
  assert.equal(result.data.hasWallet, false);
});

test("SINGIT_TOOLS provider adds the API-key actions once SINGIT_API_KEY is set", async () => {
  const result = await singitToolsProvider.get(makeRuntime({ SINGIT_API_KEY: "sk_singit_test" }), {}, {});
  assert.ok(result.data.available.includes("SINGIT_WEB_SEARCH"));
  assert.ok(result.data.available.includes("SINGIT_READ_PAGE"));
  assert.ok(!result.data.available.includes("SINGIT_PAID_CHAT"));
});

test("SINGIT_TOOLS provider adds SINGIT_PAID_CHAT only once the wallet key and both caps are set", async () => {
  const partial = await singitToolsProvider.get(makeRuntime({ SINGIT_EVM_PRIVATE_KEY: "0xabc" }), {}, {});
  assert.ok(!partial.data.available.includes("SINGIT_PAID_CHAT"));
  const full = await singitToolsProvider.get(
    makeRuntime({ SINGIT_EVM_PRIVATE_KEY: "0xabc", SINGIT_MAX_PER_CALL_USD: "0.01", SINGIT_MAX_PER_DAY_USD: "1" }), {}, {},
  );
  assert.ok(full.data.available.includes("SINGIT_PAID_CHAT"));
});

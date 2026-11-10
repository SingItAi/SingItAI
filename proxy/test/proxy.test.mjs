import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NETWORKS } from "@singitai/sdk";
import { startMerchant } from "../../mcp/test/helpers/merchant.mjs";
import { startProxy, VERSION } from "../src/server.js";
import { assertNetworkAllowed, SOLANA_MIN_SUCCESS_PCT } from "../src/config.js";

const FACILITATOR = `0x${"0".repeat(39)}2`;
const baseOffer = (overrides = {}) => ({
  scheme: "upto", network: NETWORKS.base.caip, asset: NETWORKS.base.asset, payTo: NETWORKS.base.payTo,
  amount: "9000", maxTimeoutSeconds: 120,
  extra: { facilitatorAddress: FACILITATOR, assetTransferMethod: "permit2", name: "USD Coin", version: "2",
    billing: { mode: "actual_usage", maxChargeAtomic: "9000" } },
  ...overrides,
});

async function listenProxy(t, { merchantOptions = {}, extraEnv = {}, fetchImpl } = {}) {
  const merchant = await startMerchant({ offer: baseOffer(), ...merchantOptions });
  t.after(() => merchant.close());
  const home = mkdtempSync(path.join(tmpdir(), "singit-proxy-"));
  const env = {
    SINGIT_HOME: home,
    SINGIT_ASK_URL: merchant.url,
    SINGIT_PROXY_HOST: "127.0.0.1",
    SINGIT_PROXY_PORT: "0",
    ...extraEnv,
  };
  // Port 0: pick an ephemeral port, then rewrite config after listen.
  const { server, config } = await startProxy({ env, fetchImpl: fetchImpl ?? fetch });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const addr = server.address();
  config.port = addr.port;
  const url = `http://127.0.0.1:${addr.port}`;
  return { merchant, env, url, config };
}

const post = (url, body, path = "/v1/chat/completions") => fetch(url + path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("a chat completion is paid over x402 and 402 is not returned as the answer", async t => {
  const { merchant, url, env } = await listenProxy(t, { extraEnv: { SINGIT_CLIENT: "continue" } });
  const response = await post(url, { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "Hello" }] });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "Hello back.");
  assert.deepEqual(merchant.requests.map(r => r.status), [402, 200]);
  assert.equal(merchant.requests[0].headers["payment-signature"], undefined);
  assert.equal(merchant.requests[0].headers["x-singit-client"], "continue");
  assert.match(merchant.requests[0].headers["user-agent"], /^singit-proxy\//);
  const key = JSON.parse(readFileSync(path.join(env.SINGIT_HOME, "session"), "utf8")).privateKey;
  assert.equal(JSON.stringify(body).toLowerCase().includes(key.slice(2).toLowerCase()), false);
});

test("a refused payment is an error, not a completion, and is not retried a third time", async t => {
  const { merchant, url, env } = await listenProxy(t, { merchantOptions: { funded: false } });
  const response = await post(url, { messages: [{ role: "user", content: "Hello" }] });
  assert.equal(response.status, 402);
  const body = await response.json();
  assert.equal(body.choices, undefined);
  assert.match(body.error.message, /HTTP 402/);
  assert.deepEqual(merchant.requests.map(r => r.status), [402, 402]);
  const raw = JSON.stringify(body);
  const key = JSON.parse(readFileSync(path.join(env.SINGIT_HOME, "session"), "utf8")).privateKey;
  assert.equal(raw.toLowerCase().includes(key.slice(2).toLowerCase()), false);
});

test("pinned /v1/chat/<id> is rewritten onto completions so the mock (and Ask) sees /v1/chat/completions", async t => {
  const { merchant, url } = await listenProxy(t);
  const response = await post(url, { messages: [{ role: "user", content: "Hello" }] }, "/v1/chat/claude-opus-5.5");
  assert.equal(response.status, 200);
  assert.equal(merchant.requests[0].path, "/v1/chat/completions");
  assert.equal(merchant.requests[0].body.model, "claude-opus-5.5");
});

test("stream:true is rejected before payment", async t => {
  const { merchant, url } = await listenProxy(t);
  const response = await post(url, { messages: [{ role: "user", content: "Hello" }], stream: true });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /stream/);
  assert.equal(merchant.requests.length, 0);
});

test("GET /wallet returns an address and never a private key; logs are not involved", async t => {
  const { url, env } = await listenProxy(t);
  const response = await fetch(url + "/wallet");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.walletExists, true);
  assert.match(body.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(body.network, "eip155:8453");
  assert.equal(body.privateKey, undefined);
  const key = JSON.parse(readFileSync(path.join(env.SINGIT_HOME, "session"), "utf8")).privateKey;
  assert.equal(JSON.stringify(body).toLowerCase().includes(key.slice(2).toLowerCase()), false);
});

test("GET /health does not include a wallet address or key", async t => {
  const { url, env } = await listenProxy(t);
  const body = await (await fetch(url + "/health")).json();
  assert.equal(body.ok, true);
  assert.equal(body.version, VERSION);
  const session = JSON.parse(readFileSync(path.join(env.SINGIT_HOME, "session"), "utf8"));
  assert.equal(JSON.stringify(body).includes(session.address), false);
  assert.equal(JSON.stringify(body).toLowerCase().includes(session.privateKey.slice(2).toLowerCase()), false);
});

test("an offer above the per-call cap is refused before anything is signed", async t => {
  const { merchant, url } = await listenProxy(t, { extraEnv: { SINGIT_MAX_PER_CALL_USD: "0.001" } });
  const response = await post(url, { messages: [{ role: "user", content: "Hello" }] });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /per-call ceiling/);
  assert.deepEqual(merchant.requests.map(r => r.status), [402]);
});

test("default x-singit-client is singit-proxy/<version>", async t => {
  const { merchant, url } = await listenProxy(t);
  await post(url, { messages: [{ role: "user", content: "Hello" }] });
  assert.equal(merchant.requests[0].headers["x-singit-client"], `singit-proxy/${VERSION}`);
});

test("Solana is refused unless numbers.json reports paid success at or above the gate", async t => {
  const fetchImpl = async url => {
    if (String(url).endsWith("/numbers.json")) {
      return new Response(JSON.stringify({ paid_call_success: { last_7d: { solana: { success_pct: 53.8 } } } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await assert.rejects(
    () => assertNetworkAllowed("solana", { askUrl: "https://ask.test", fetchImpl }),
    new RegExp(`at least ${SOLANA_MIN_SUCCESS_PCT}`)
  );
  await assertNetworkAllowed("base", { askUrl: "https://ask.test", fetchImpl });
  const ok = async url => {
    if (String(url).endsWith("/numbers.json")) {
      return new Response(JSON.stringify({ paid_call_success: { last_7d: { solana: { success_pct: 96 } } } }),
        { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await assertNetworkAllowed("solana", { askUrl: "https://ask.test", fetchImpl: ok });
});

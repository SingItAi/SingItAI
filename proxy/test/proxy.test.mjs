import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NETWORKS } from "@singitai/sdk";
import { startMerchant } from "./helpers/merchant.mjs";
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

test("stream:true after a paid JSON invoice is emitted as OpenAI SSE plus [DONE]", async t => {
  const { merchant, url } = await listenProxy(t);
  const response = await post(url, { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "Hello" }], stream: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /Hello back\./);
  assert.match(text, /data: \[DONE\]/);
  assert.match(text, /chat\.completion\.chunk/);
  assert.equal(text.includes('"object":"chat.completion"') && !text.includes("chat.completion.chunk"), false);
  assert.deepEqual(merchant.requests.map(r => r.status), [402, 402, 200]);
  assert.equal(merchant.requests[0].body.stream, true);
  assert.equal(merchant.requests[2].body.stream, false);
});

test("stream:true passes through live SSE from Ask when no payment is required", async t => {
  const { merchant, url } = await listenProxy(t, { merchantOptions: { freeSse: true } });
  const response = await post(url, { messages: [{ role: "user", content: "Hello" }], stream: true });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /Hel/);
  assert.match(text, /lo/);
  assert.match(text, /data: \[DONE\]/);
  assert.equal(merchant.requests.length, 1);
  assert.equal(merchant.requests[0].headers["payment-signature"], undefined);
});

test("a refused streamed payment is an error, not SSE", async t => {
  const { url } = await listenProxy(t, { merchantOptions: { funded: false } });
  const response = await post(url, { messages: [{ role: "user", content: "Hello" }], stream: true });
  assert.equal(response.status, 402);
  const body = await response.json();
  assert.equal(body.choices, undefined);
  assert.match(body.error.message, /HTTP 402/);
});

test("POST /v1/messages is translated onto completions and returned as an Anthropic message", async t => {
  const { merchant, url } = await listenProxy(t);
  const response = await post(url, {
    model: "deepseek-v4.1-flash", max_tokens: 32,
    system: "Be brief.",
    messages: [{ role: "user", content: "Hello" }],
  }, "/v1/messages");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.type, "message");
  assert.equal(body.role, "assistant");
  assert.equal(body.content[0].type, "text");
  assert.equal(body.content[0].text, "Hello back.");
  assert.equal(body.stop_reason, "end_turn");
  assert.equal(merchant.requests[0].path, "/v1/chat/completions");
  assert.equal(merchant.requests[0].body.model, "deepseek-v4.1-flash");
  assert.equal(merchant.requests[0].body.messages[0].role, "system");
  assert.equal(merchant.requests[0].body.messages[0].content, "Be brief.");
});

test("POST /v1/messages with stream:true emits Anthropic SSE events", async t => {
  const { url } = await listenProxy(t);
  const response = await post(url, {
    model: "deepseek-v4.1-flash", max_tokens: 32, stream: true,
    messages: [{ role: "user", content: "Hello" }],
  }, "/v1/messages");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: content_block_delta/);
  assert.match(text, /Hello back\./);
  assert.match(text, /event: message_stop/);
  assert.equal(text.includes('"type":"message"') && !text.includes("message_start"), false);
});

test("POST /v1/messages maps tools to tool_use blocks", async t => {
  const { merchant, url } = await listenProxy(t, { merchantOptions: { toolReply: true } });
  const response = await post(url, {
    model: "deepseek-v4.1-flash", max_tokens: 32,
    messages: [{ role: "user", content: "Look it up" }],
    tools: [{ name: "lookup", description: "Look something up", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
  }, "/v1/messages");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stop_reason, "tool_use");
  assert.equal(body.content[0].type, "tool_use");
  assert.equal(body.content[0].name, "lookup");
  assert.equal(body.content[0].input.q, "hi");
  assert.equal(merchant.requests[0].body.tools[0].type, "function");
  assert.equal(merchant.requests[0].body.tools[0].function.name, "lookup");
});

test("POST /v1/messages/count_tokens returns an estimate and does not pay", async t => {
  const { merchant, url } = await listenProxy(t);
  const response = await post(url, {
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: "Hello there, this is a longer prompt for counting." }],
  }, "/v1/messages/count_tokens");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.input_tokens, "number");
  assert.ok(body.input_tokens >= 1);
  assert.equal(merchant.requests.length, 0);
});

test("SINGIT_MODEL_MAP rewrites Anthropic model ids before they reach Ask", async t => {
  const { merchant, url } = await listenProxy(t, { extraEnv: { SINGIT_MODEL_MAP: "claude-haiku-5.5=deepseek-v4.1-flash" } });
  const response = await post(url, {
    model: "claude-haiku-5.5", max_tokens: 16,
    messages: [{ role: "user", content: "Hello" }],
  }, "/v1/messages");
  assert.equal(response.status, 200);
  assert.equal(merchant.requests[0].body.model, "deepseek-v4.1-flash");
});

test("a refused /v1/messages payment is an Anthropic error, not a message", async t => {
  const { url } = await listenProxy(t, { merchantOptions: { funded: false } });
  const response = await post(url, {
    model: "deepseek-v4.1-flash", max_tokens: 16,
    messages: [{ role: "user", content: "Hello" }],
  }, "/v1/messages");
  assert.equal(response.status, 402);
  const body = await response.json();
  assert.equal(body.type, "error");
  assert.equal(body.content, undefined);
  assert.match(body.error.message, /HTTP 402/);
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

test("Responses routes to chat completions with instructions and function outputs", async t => {
  const { merchant, url } = await listenProxy(t, { merchantOptions: { toolReply: true } });
  const response = await post(url, { model: "deepseek-v4.1-flash", instructions: "Be brief",
    input: ["Hi", { type: "function_call", call_id: "old", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "old", output: "result" }],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
  }, "/v1/responses");
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(answer.output[0].type, "function_call");
  assert.equal(answer.output[0].name, "lookup");
  assert.equal(merchant.requests[0].path, "/v1/chat/completions");
  const request = merchant.requests[0];
  assert.equal(request.body.messages[0].content, "Be brief");
  assert.equal(request.body.messages.at(-1).tool_call_id, "old");
  assert.equal(request.body.tools[0].function.name, "lookup");
});

test("Responses resolves auto catalog once and synthesizes paid SSE", async t => {
  const { merchant, url } = await listenProxy(t);
  for (const model of ["auto", "singit/auto"]) {
    const response = await post(url, { model, input: ["Hello"], stream: true }, "/v1/responses");
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: response.created/);
    assert.match(text, /Hello back\./);
    assert.ok(text.indexOf("event: response.output_item.added") < text.indexOf("event: response.output_text.delta"));
    assert.match(text, /event: response.completed/);
    assert.match(text, /"usage":/);
  }
  assert.equal(merchant.requests.filter(item => item.path === "/v1/models").length, 1);
  for (const request of merchant.requests.filter(item => item.path === "/v1/chat/completions")) assert.equal(request.body.model, "deepseek-v4.1-flash");
});

test("Responses translates free SSE and refuses unpaid 402 as JSON", async t => {
  const free = await listenProxy(t, { merchantOptions: { freeSse: true } });
  const response = await post(free.url, { model: "free/model", input: ["Hi"], stream: true }, "/v1/responses");
  assert.match(await response.text(), /event: response.completed/);
  const unpaid = await listenProxy(t, { merchantOptions: { funded: false } });
  const refused = await post(unpaid.url, { model: "x", input: ["Hi"], stream: true }, "/v1/responses");
  assert.equal(refused.status, 402);
  assert.equal((await refused.json()).error.type, "payment_required");
});

test("Responses catalog failure passes model through; upstream errors fail SSE", async t => {
  const seen = [];
  const { url } = await listenProxy(t, { fetchImpl: async (url, options) => {
    if (String(url).endsWith("/v1/models")) throw new Error("offline");
    seen.push(JSON.parse(options.body));
    return new Response('{"error":{"message":"Unavailable"}}', { status: 400 });
  } });
  const response = await post(url, { model: "auto", input: ["Hi"], stream: true }, "/v1/responses");
  const text = await response.text();
  assert.match(text, /response.failed/);
  assert.doesNotMatch(text, /response.completed/);
  assert.equal(seen[0].model, "auto");
});

test("Responses cap refusal is HTTP 402 JSON, with no signed retry", async t => {
  const { merchant, url } = await listenProxy(t, { extraEnv: { SINGIT_MAX_PER_CALL_USD: "0.001" } });
  const response = await post(url, { model: "x", input: ["Hi"], stream: true }, "/v1/responses");
  assert.equal(response.status, 402);
  assert.equal((await response.json()).error.type, "payment_required");
  assert.deepEqual(merchant.requests.map(item => item.status), [402, 402]);
  assert.ok(merchant.requests.every(item => !item.headers["payment-signature"]));
});

test("Responses non-stream upstream errors stay JSON; invalid input never reaches Ask", async t => {
  let calls = 0;
  const { url } = await listenProxy(t, { fetchImpl: async () => {
    calls++;
    return new Response("Unavailable", { status: 503 });
  } });
  const invalid = await post(url, { model: "x", stream: true }, "/v1/responses");
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
  const response = await post(url, { model: "x", input: ["Hi"] }, "/v1/responses");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.type, "api_error");
});

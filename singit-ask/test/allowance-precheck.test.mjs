import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { x402ResourceServer } from "@x402/express";
import { addPaymentRoute } from "../src/metered.mjs";
import { spendLimitMiddleware } from "../src/spend-limit.mjs";

const address = digit => "0x" + digit.repeat(40);
const requirements = { scheme: "upto", network: "eip155:8453", asset: address("1"), amount: "1500" };
const payment = { payload: { permit2Authorization: { from: address("2") } } };
function setup(readContract) {
  const app = express(), logs = [], hooks = [];
  const server = new x402ResourceServer({ getSupported: async () => ({ kinds: [], extensions: [], signers: {} }) });
  const register = server.onBeforeVerify.bind(server);
  server.onBeforeVerify = hook => { hooks.push(hook); return register(hook); };
  const options = { publicClient: readContract ? { readContract } : undefined,
    allowanceTimeoutMs: 5, log: line => logs.push(line), discoverable: false };
  for (const route of ["/one", "/two", "/three"]) addPaymentRoute(app,
    { [`POST ${route}`]: { accepts: [] } }, server, options);
  return { server, hooks, logs };
}
const context = (req = requirements, p = payment) => ({ requirements: req, paymentPayload: p,
  transportContext: { request: { path: "/two" } } });

test("low allowance aborts verification before the paid handler and registers once", async () => {
  let reads = 0, upstreamCalls = 0;
  const { server, hooks, logs } = setup(async request => {
    reads++;
    assert.equal(request.functionName, "allowance");
    assert.equal(request.blockTag, "latest");
    assert.equal(request.address, requirements.asset);
    assert.equal(request.args[0], payment.payload.permit2Authorization.from);
    return 1305n;
  });
  assert.equal(hooks.length, 1);
  const result = await server.verifyPayment(payment, requirements, {}, context().transportContext);
  if (result.isValid) upstreamCalls++;
  assert.equal(upstreamCalls, 0);
  assert.equal(reads, 1);
  assert.equal(result.invalidReason, "permit2_allowance_required");
  assert.match(result.invalidMessage, /Nothing was charged/);
  assert.deepEqual(logs, ["singit-ask: /two pre-verify allowance too low network=eip155:8453 scheme=upto amount=1500"]);
});

test("sufficient allowance, sponsorship, other schemes and networks pass", async () => {
  for (const value of [1500n, 2000n]) assert.equal(await setup(async () => value).hooks[0](context()), undefined);
  let reads = 0;
  const { hooks } = setup(async () => { reads++; return 0n; });
  for (const [extension, field] of [["eip2612GasSponsoring", "signature"], ["erc20ApprovalGasSponsoring", "signedTransaction"]]) {
    assert.equal(await hooks[0](context(requirements, { ...payment, extensions: { [extension]: { info: { [field]: "0x11" } } } })), undefined);
  }
  for (const req of [{ ...requirements, scheme: "exact" }, { ...requirements, network: "solana:test" }]) {
    assert.equal(await hooks[0](context(req)), undefined);
  }
  assert.equal(reads, 0);
});

test("an echoed, unsigned declared extension does not count as a permit", async () => {
  const { hooks } = setup(async () => 5n);
  for (const extensions of [{ eip2612GasSponsoring: { info: { version: "1" } } },
    { erc20ApprovalGasSponsoring: { info: { version: "1" } } }, { eip2612GasSponsoring: { info: { signature: "" } } }]) {
    const result = await hooks[0](context(requirements, { ...payment, extensions }));
    assert.equal(result?.reason, "permit2_allowance_required");
  }
});

test("RPC errors, timeout, missing client and malformed fields fail open", async () => {
  for (const reader of [undefined, async () => { throw new Error("unavailable"); }, () => new Promise(() => {})]) {
    assert.equal(await setup(reader).hooks[0](context()), undefined);
  }
  const { hooks } = setup(async () => { throw new Error("must not escape"); });
  for (const p of [null, {}, { payload: { permit2Authorization: {} } }]) assert.equal(await hooks[0](context(requirements, p)), undefined);
  assert.equal(await hooks[0](context({ ...requirements, amount: "odd" })), undefined);
});

test("402 wrapper exposes allowance reason and guidance from the core challenge", async () => {
  let body;
  const challenge = { error: "permit2_allowance_required", x402Version: 2, accepts: [] };
  const res = { statusCode: 412, setHeader() {}, getHeader: () => Buffer.from(JSON.stringify(challenge)).toString("base64"),
    json(value) { body = value; } };
  await spendLimitMiddleware()({ get() {}, method: "POST" }, res, () => {});
  res.json({});
  assert.equal(res.statusCode, 402);
  assert.equal(body.code, "permit2_allowance_required");
  assert.match(body.message, /Nothing was charged/);
  // No ceiling known here (empty accepts, no signature): the amount is left out rather than invented.
  assert.deepEqual(body.next_action, { type: "approve_allowance", missing: "permit2_allowance",
    network: "eip155:8453", asset: "USDC", docs: "https://singitai.app/docs/errors/" });
});

// End to end through createApp: the real x402 HTTP middleware, a fake facilitator and a fake chain reader.
const ASSET_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
async function paid(t, allowance, extensions) {
  const { createApp } = await import("../src/app.mjs");
  const { BASE, ASSET, PAY_TO, METERED_ROUTE } = await import("../src/pricing.mjs");
  const calls = { verify: 0, settle: 0, upstream: 0, reads: [] };
  const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const facilitator = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: BASE },
      { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu" } },
      { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x2A89407a98A0732b7fD578c4E156B7166540EB5A" } },
      { x402Version: 2, scheme: "upto", network: SOL, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88", receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } }],
      extensions: ["eip2612GasSponsoring"], signers: {} }),
    verify: async () => { calls.verify++; return { isValid: true, payer: address("2") }; },
    settle: async () => { calls.settle++; return { success: true, network: BASE, transaction: "0x" + "aa".repeat(32), payer: address("2") }; },
  };
  const publicClient = { readContract: async request => { calls.reads.push(request.args); return allowance; } };
  const app = createApp({ payToBase: PAY_TO, payToSolana: "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu", model: "test" },
    { facilitatorClient: facilitator, priceBook: { publicClient },
      upstream: async () => { calls.upstream++; return { content: "Hello", finishReason: "stop", usage: { buyer_cost_micro: 100 } }; }, log: () => {} });
  const listener = await new Promise(resolve => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  const url = `http://127.0.0.1:${listener.address().port}${METERED_ROUTE}`;
  const send = headers => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }) });
  const first = await send({});
  const q = JSON.parse(Buffer.from(first.headers.get("payment-required"), "base64").toString());
  const accepted = q.accepts.find(a => a.scheme === "upto" && a.network === BASE);
  const signature = Buffer.from(JSON.stringify({ x402Version: 2, resource: q.resource, accepted,
    payload: { signature: "0xsigned", permit2Authorization: { from: address("2"), permitted: { amount: accepted.amount } } },
    extensions: extensions ? Object.fromEntries(Object.entries(extensions).map(([key, value]) => [key,
      { ...q.extensions?.[key], ...value, info: { ...q.extensions?.[key]?.info, ...value.info } }])) : q.extensions })).toString("base64");
  const response = await send({ "PAYMENT-SIGNATURE": signature });
  return { response, calls, ceiling: accepted.amount };
}

test("HTTP: a payment whose allowance is below the ceiling is refused before the model runs", async t => {
  const { response, calls, ceiling } = await paid(t, 10n);
  assert.equal(response.status, 402);
  const body = await response.json();
  assert.equal(body.code, "permit2_allowance_required");
  assert.match(body.message, /Nothing was charged/);
  // D-PERMIT2: what to do next, machine-readable, with the old fields kept.
  assert.equal(body.error, "permit2_allowance_required");
  assert.equal(body.action, "use_exact_or_provide_permit");
  assert.deepEqual(body.details, { scheme: "upto", network: "eip155:8453", extension: "eip2612GasSponsoring" });
  assert.match(body.request_id, /^req_[0-9a-f-]{36}$/);
  assert.deepEqual(body.next_action, { type: "approve_allowance", missing: "permit2_allowance",
    amountAtomic: ceiling, amountUsd: Number(ceiling) / 1e6, network: "eip155:8453", asset: "USDC",
    docs: "https://singitai.app/docs/errors/" });
  assert.ok(!JSON.stringify(body.next_action).toLowerCase().includes("0x"), "no contract or payer address");
  assert.equal(response.headers.get("x-singit-error"), "permit2_allowance_required");
  assert.ok(Array.isArray(body.accepts) && body.accepts.length > 0);
  assert.equal(calls.upstream, 0);
  assert.equal(calls.verify, 0);
  assert.equal(calls.settle, 0);
  assert.equal(calls.reads.length, 1);
  assert.ok(BigInt(ceiling) > 10n);
});

test("HTTP: enough allowance, or a signed permit, goes through to the model and settlement", async t => {
  const ok = await paid(t, 10n ** 9n);
  assert.equal(ok.response.status, 200);
  assert.equal(ok.calls.upstream, 1);
  assert.equal(ok.calls.settle, 1);
  const sponsored = await paid(t, 0n, { eip2612GasSponsoring: { info: { from: address("2"), asset: ASSET_ADDRESS, spender: "0x000000000022d473030f116ddee9f6b43ac78ba3",
    amount: "3000", nonce: "0", deadline: "9999999999", signature: "0x" + "11".repeat(65), version: "1" } } });
  assert.equal(sponsored.response.status, 200);
  assert.equal(sponsored.calls.reads.length, 0);
  assert.equal(sponsored.calls.upstream, 1);
});

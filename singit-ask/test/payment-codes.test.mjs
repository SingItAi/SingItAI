import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { request } from "./helpers/http-request.mjs";
import { PAYMENT_ERROR_CODES, ACTIONS, classifyPaymentFailure, nextAction, unfundedMessage } from "../src/payment-codes.mjs";
import { attachPaymentFailureCodes, paymentFailureContext, paymentCodesMiddleware } from "../src/payment-failure-hooks.mjs";
import { withFacilitatorHints } from "../src/facilitator-hints.mjs";
import { createApp, BASE, SOLANA } from "../src/app.mjs";
import { HealthStats, numbersBody, HOUR } from "../src/health-stats.mjs";
import { errorCodesMiddleware } from "../src/errors.mjs";

const svm = "invalid_exact_svm_payload_transaction_simulation_failed";
const cases = [
  ["insufficient_funds", "contract call failed: unable to call contract: execution reverted", "payment_unfunded"],
  [svm, "simulation failed: transaction would fail on-chain: map[InstructionError:[2 InvalidAccountData]]", "payment_unfunded"],
  [svm, "simulation failed: transaction would fail on-chain: BlockhashNotFound", "payment_blockhash_stale"],
  ["invalid_payload", "authorization nonce already submitted; transaction already on-chain", "payment_replay"],
  ["invalid_exact_evm_permit2_payload_allowance_required", "simulation failed", "payment_invalid"],
  ["unknown_refusal", "unknown refusal detail", "payment_invalid"],
  ["invalid_upto_svm_channel_already_open", "channel already exists", "payment_replay"],
];
test("classifies production refusals and small case-insensitive variants in priority order", () => {
  for (const [reason, message, code] of cases) for (const transform of [s => s, s => s.toUpperCase()]) {
    assert.equal(classifyPaymentFailure({ reason: transform(reason), message: transform(message) }), code);
  }
  for (const text of ["insufficient balance", "token account is missing", "SPL InsufficientFunds", "map[Custom:1]"])
    assert.equal(classifyPaymentFailure({ message: text }), "payment_unfunded");
  for (const text of ["blockhash expired", "blockhash not found", "blockhash stale"])
    assert.equal(classifyPaymentFailure({ reason: text }), "payment_blockhash_stale");
  for (const text of ["already submitted", "already used", "already settled", "already processed", "nonce already", "already on-chain", "duplicate", "replay", "channel_already_open", "invalid_upto_svm_channel_already_open", "channel already exists"])
    assert.equal(classifyPaymentFailure({ message: text }), "payment_replay");
  assert.equal(classifyPaymentFailure({ message: "duplicate BlockhashNotFound InvalidAccountData" }), "payment_unfunded");
  assert.equal(classifyPaymentFailure({ message: "duplicate BlockhashNotFound" }), "payment_blockhash_stale");
  for (const value of [undefined, {}, { reason: "unknown" }, { reason: 1, message: {} }]) assert.equal(classifyPaymentFailure(value), "payment_invalid");
});
const payer = "0x" + "2".repeat(40), solPayer = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const config = { model: "test", payToBase: "0x" + "1".repeat(40), payToSolana: solPayer, exaKey: "fake-test" };
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64");
const decode = value => JSON.parse(Buffer.from(value, "base64"));
const info = { id: "test", promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000001 };
for (const scheme of ["upto", "exact"]) for (const [index, [reason, message, code]] of cases.entries()) {
  // Solana upto escrow validates during deposit settlement, without a facilitator verify call.
  for (const route of ["/v1/chat/completions", "/v1/exa/search"]) {
    if (route.includes("exa") && scheme === "upto") continue;
    test(`${route} ${scheme}: ${code} (${index})`, async () => {
      const network = index === 1 || index === 2 ? SOLANA : BASE;
      const phase = index < 2 && !(network === SOLANA && scheme === "upto") ? "verify" : "settle";
      let settles = 0, upstreamCalls = 0;
      const client = withFacilitatorHints({
        getSupported: async () => ({ kinds: [BASE, SOLANA].flatMap(network => ["upto", "exact"].map(scheme => ({
          x402Version: 2, network, scheme, extra: { feePayer: solPayer, receiverAuthorizer: solPayer, facilitatorAddress: payer },
        }))), extensions: [], signers: {} }),
        verify: async () => phase === "verify" ? { isValid: false, invalidReason: reason, invalidMessage: message }
          : { isValid: true, payer },
        settle: async () => { settles++; return { success: false, errorReason: reason, errorMessage: message, network }; },
      });
      const app = createApp(config, { facilitatorClient: client, log() {},
        catalogue: { resolve: async () => info, list: async () => [info], canAnswer: async () => true },
        upstream: async () => { upstreamCalls++; return { content: "PRIVATE ANSWER", usage: { buyer_cost_micro: 100 } }; },
        fetchImpl: async () => { throw new Error("unexpected fetch"); },
        exaFetch: async () => { upstreamCalls++; return new Response(JSON.stringify({ results: [{ title: "PRIVATE ANSWER", url: "https://example.test" }] })); },
      });
      const body = route.includes("exa") ? { query: "test" } : { model: "test", messages: [{ role: "user", content: "hello" }], max_tokens: 100 };
      const send = headers => request(app, route, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
      const challenge = await send({});
      assert.equal(challenge.status, 402);
      assert.equal(challenge.body.code, "payment_required");
      assert.equal(challenge.headers["x-singit-error"], undefined);
      const required = decode(challenge.headers["payment-required"]);
      const accepted = required.accepts.find(a => a.network === network && a.scheme === scheme);
      assert.ok(accepted);
      const result = await send({ "payment-signature": encode({ x402Version: 2, resource: required.resource, accepted,
        payload: { signature: "fake", authorization: { from: payer, nonce: "0x" + "3".repeat(64) }, transaction: "fake" } }) });
      assert.equal(result.status, 402);
      assert.equal(result.body.code, code);
      assert.equal(result.body.error, "payment_required");
      assert.equal(result.body.action, ACTIONS[code]);
      assert.equal(result.headers["x-singit-error"], code);
      assert.ok(result.headers["access-control-expose-headers"].includes("X-SingIt-Error"));
      assert.match(result.body.message, /Nothing was charged for this request/);
      assert.ok(!JSON.stringify(result.body).includes("PRIVATE ANSWER"));
      assert.ok(!JSON.stringify(result.body).includes(message));
      if (code === "payment_unfunded") {
        // SI-296: what is missing, how much (the signed amount) and where, with no addresses.
        const next = result.body.next_action;
        assert.equal(next.type, "fund_wallet");
        assert.equal(next.asset, "USDC");
        assert.equal(next.docs, "https://singitai.app/docs/errors/");
        assert.equal(next.network, network);
        assert.equal(next.missing, network === SOLANA ? "usdc_token_account" : "USDC");
        assert.equal(next.amountAtomic, accepted.amount);
        assert.equal(next.amountUsd, Number(accepted.amount) / 1e6);
        assert.ok(result.body.message.includes(network));
        assert.match(result.body.message, network === SOLANA ? /token account/ : /USDC on Base/);
        assert.match(result.body.message, /Nothing was charged for this request\.$/);
        for (const secret of [payer, solPayer, config.payToBase, accepted.asset, accepted.payTo])
          assert.ok(!JSON.stringify([next, result.body.message]).includes(secret), secret);
      } else assert.equal(result.body.next_action, undefined);
      if (phase === "verify") {
        assert.equal(settles, 0);
        assert.equal(upstreamCalls, 0);
        assert.deepEqual(result.body.accepts, decode(result.headers["payment-required"]).accepts);
      } else assert.ok(settles > 0);
      if (result.headers["payment-response"]) assert.notEqual(decode(result.headers["payment-response"]).success, true);
      const numbers = numbersBody(app.locals.healthStats);
      assert.equal(numbers.paid_calls.total, 0);
      for (const window of ["total", "last_24h", "last_7d"]) assert.equal(numbers.settlement_failures_by_code[window][code], 1);
      for (const address of [payer, solPayer]) assert.ok(!JSON.stringify(numbers).includes(address));
    });
  }
}
test("next_action omits an amount it cannot read and the unfunded message falls back without one", () => {
  for (const amount of [undefined, "", "1.5", "-1", "0x10", 10])
    assert.deepEqual(nextAction({ type: "fund_wallet", missing: "USDC", amount, network: BASE }),
      { type: "fund_wallet", missing: "USDC", network: BASE, asset: "USDC", docs: "https://singitai.app/docs/errors/" });
  assert.deepEqual(nextAction({ type: "fund_wallet", missing: "USDC", amount: "2500", network: BASE }),
    { type: "fund_wallet", missing: "USDC", amountAtomic: "2500", amountUsd: 0.0025, network: BASE, asset: "USDC", docs: "https://singitai.app/docs/errors/" });
  assert.equal(unfundedMessage({ missing: "USDC", network: BASE }), `Fund the wallet with enough USDC on Base (${BASE}). Nothing was charged for this request.`);
  assert.equal(unfundedMessage({ missing: "USDC", amount: "1500", network: SOLANA }),
    `Fund the wallet's USDC token account with at least 0.0015 USDC on Solana (${SOLANA}). Nothing was charged for this request.`);
  assert.equal(unfundedMessage({ missing: "USDC" }), "Fund the wallet and its token account. Nothing was charged for this request.");
});
test("hooks tolerate garbage contexts and absent ALS without affecting behavior", () => {
  const hooks = [];
  attachPaymentFailureCodes(Object.fromEntries(["onVerifyFailure", "onAfterVerify", "onSettleFailure"].map(k => [k, fn => hooks.push(fn)])));
  for (const hook of hooks) for (const ctx of [undefined, null, 1, {}, { result: null }, { get error() { throw Error(); } }]) {
    assert.doesNotThrow(() => hook(ctx));
    const store = {};
    paymentFailureContext.run(store, () => assert.doesNotThrow(() => hook(ctx)));
    assert.deepEqual(store, {});
  }
});
test("409 legacy bodies remain identical and gain only the header", async () => {
  for (const code of ["payment_duplicate", "stale_payment_permit"]) {
    const body = { error: { code, type: "invalid_request_error", message: "Existing message" } };
    const app = express(); app.use(errorCodesMiddleware, paymentCodesMiddleware());
    app.get("/", (_req, res) => res.status(409).json(body));
    const result = await request(app, "/");
    assert.equal(JSON.stringify(result.body), JSON.stringify(body));
    assert.equal(result.headers["x-singit-error"], code);
  }
});
test("refusal counters persist, age by window, accept old state and reject invalid state as a unit", () => {
  const dir = mkdtempSync(join(tmpdir(), "payment-codes-")), file = join(dir, "stats.json");
  let now = Date.now();
  try {
    const stats = new HealthStats({ file, now: () => now });
    for (const code of PAYMENT_ERROR_CODES) stats.recordPaymentFailure({ code, network: BASE });
    stats.recordPaymentFailure({ code: "unknown" }); stats.flush();
    const loaded = new HealthStats({ file, now: () => now });
    assert.deepEqual(numbersBody(loaded).settlement_failures_by_code, numbersBody(stats).settlement_failures_by_code);
    now += 25 * HOUR;
    assert.equal(numbersBody(loaded).settlement_failures_by_code.last_24h.payment_unfunded, 0);
    assert.equal(numbersBody(loaded).settlement_failures_by_code.last_7d.payment_unfunded, 1);
    now += 7 * 24 * HOUR;
    assert.equal(numbersBody(loaded).settlement_failures_by_code.last_7d.payment_unfunded, 0);
    const state = JSON.parse(readFileSync(file));
    delete state.paymentFailures;
    for (const b of Object.values(state.buckets)) delete b.paymentFailures;
    writeFileSync(file, JSON.stringify(state));
    const old = new HealthStats({ file });
    assert.equal(numbersBody(old).settlement_failures_by_code.total.payment_unfunded, 0);
    old.recordPaymentFailure({ code: "payment_unfunded" });
    assert.equal(numbersBody(old).settlement_failures_by_code.total.payment_unfunded, 1);
    for (const bad of [{ payment_unfunded: -1 }, { unknown: 1 }, { payment_invalid: "1" }]) {
      writeFileSync(file, JSON.stringify({ ...state, paymentFailures: bad }));
      assert.equal(numbersBody(new HealthStats({ file })).settlement_failures_by_code.total.payment_unfunded, 0);
      assert.notEqual(new HealthStats({ file }).state.salt, state.salt);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("OpenAPI describes refusal enums, headers and examples without a socket", async () => {
  const app = createApp(config, { facilitatorClient: { getSupported: async () => ({ kinds: [], extensions: [], signers: {} }) }, catalogue: null, log() {} });
  const { body: doc } = await request(app, "/openapi.json");
  const schema = doc.components.schemas.PaymentRequired402.properties;
  assert.deepEqual(schema.code.enum, ["payment_required", ...PAYMENT_ERROR_CODES]);
  assert.deepEqual(schema.action.enum, Object.values(ACTIONS));
  const response = doc.paths["/v1/chat/completions"].post.responses[402];
  assert.ok(response.headers["X-SingIt-Error"]);
  assert.equal(response.content["application/json"].examples.unfunded.value.code, "payment_unfunded");
  assert.equal(response.content["application/json"].examples.unfunded.value.accepts, undefined);
  assert.equal(response.content["application/json"].examples.unfunded.value.next_action.type, "fund_wallet");
});

test("real stale permit and local duplicate envelopes keep their serialized bodies", async () => {
  const { createPermitGuard } = await import("../src/permit-guard.mjs");
  const guard = createPermitGuard();
  const payload = { payload: { permit2Authorization: {} }, extensions: { eip2612GasSponsoring: { info: {
    from: payer, asset: "0xUSDC", nonce: "7", spender: "0x000000000022d473030f116ddee9f6b43ac78ba3",
  } } } };
  guard.record(payload, { scheme: "upto", network: BASE, asset: "0xUSDC" }, { payer });
  let expected;
  guard.middleware({ get: () => encode(payload) }, { status() { return this; }, json(body) { expected = JSON.stringify(body); } }, () => assert.fail());
  const app = express(); app.use(errorCodesMiddleware, paymentCodesMiddleware(), guard.middleware);
  const result = await request(app, "/", { headers: { "payment-signature": encode(payload) } });
  assert.equal(result.status, 409);
  assert.equal(JSON.stringify(result.body), expected);
  assert.equal(result.headers["x-singit-error"], "stale_payment_permit");
  const local = express(); local.use(errorCodesMiddleware, paymentCodesMiddleware());
  local.get("/", (_req, res) => res.status(409).json({ error: { type: "invalid_request_error", message: "This payment was already used." } }));
  const duplicate = await request(local, "/");
  assert.equal(JSON.stringify(duplicate.body), JSON.stringify({ error: { type: "invalid_request_error", message: "This payment was already used.", code: "payment_duplicate" } }));
  assert.equal(duplicate.headers["x-singit-error"], "payment_duplicate");
});
// A settlement that may have reached the chain must not be reported as "nothing was charged".
for (const [label, settle] of [
  ["transaction hash present", { success: false, errorReason: "settlement_pending", errorMessage: "confirmation pending", transaction: "0x" + "9".repeat(64) }],
  ["timeout", { success: false, errorReason: "unexpected_settle_error", errorMessage: "request timed out" }],
  ["transport error without a facilitator reason", { success: false, errorMessage: "socket hang up" }],
]) test(`uncertain settlement keeps the legacy answer: ${label}`, async () => {
  const client = withFacilitatorHints({
    getSupported: async () => ({ kinds: [BASE, SOLANA].flatMap(network => ["upto", "exact"].map(scheme => ({
      x402Version: 2, network, scheme, extra: { feePayer: solPayer, receiverAuthorizer: solPayer, facilitatorAddress: payer },
    }))), extensions: [], signers: {} }),
    verify: async () => ({ isValid: true, payer }),
    settle: async () => ({ ...settle, network: BASE }),
  });
  const app = createApp(config, { facilitatorClient: client, log() {},
    catalogue: { resolve: async () => info, list: async () => [info], canAnswer: async () => true },
    upstream: async () => ({ content: "PRIVATE ANSWER", usage: { buyer_cost_micro: 100 } }),
    fetchImpl: async () => { throw new Error("unexpected fetch"); } });
  const body = JSON.stringify({ model: "test", messages: [{ role: "user", content: "hello" }], max_tokens: 100 });
  const send = headers => request(app, "/v1/chat/completions", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  const required = decode((await send({})).headers["payment-required"]);
  const accepted = required.accepts.find(a => a.network === BASE && a.scheme === "exact");
  const result = await send({ "payment-signature": encode({ x402Version: 2, resource: required.resource, accepted,
    payload: { signature: "fake", authorization: { from: payer, nonce: "0x" + "3".repeat(64) } } }) });
  assert.equal(result.status, 402);
  assert.equal(result.body.code, "payment_required");
  assert.equal(result.body.action, undefined);
  assert.equal(result.headers["x-singit-error"], undefined);
  assert.ok(!JSON.stringify(result.body).includes("Nothing was charged"));
  const numbers = numbersBody(app.locals.healthStats);
  for (const code of PAYMENT_ERROR_CODES) assert.equal(numbers.settlement_failures_by_code.total[code], 0);
});

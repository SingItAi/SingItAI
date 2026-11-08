// payment_unfunded says what the payer's network needs; an unknown refusal is never called unfunded or permit2.
// Stub facilitator only: no network, keys or payments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "./helpers/http-request.mjs";
import { withFacilitatorHints } from "../src/facilitator-hints.mjs";
import { createApp, BASE, SOLANA } from "../src/app.mjs";
import { classifyPaymentFailure, messageFor, ACTIONS } from "../src/payment-codes.mjs";

const payer = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const config = { model: "test", payToBase: "0x" + "1".repeat(40), payToSolana: payer, exaKey: "fake-test" };
const encode = v => Buffer.from(JSON.stringify(v)).toString("base64");
const decode = v => JSON.parse(Buffer.from(v, "base64"));
const info = { id: "test", promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000001 };

async function refused(network, reason, message) {
  let model = 0, settle = 0;
  const client = withFacilitatorHints({
    getSupported: async () => ({ kinds: [BASE, SOLANA].flatMap(n => ["upto", "exact"].map(s => ({ x402Version: 2, network: n, scheme: s,
      extra: { feePayer: payer, receiverAuthorizer: payer, facilitatorAddress: "0x" + "2".repeat(40) } }))), extensions: [], signers: {} }),
    verify: async () => ({ isValid: false, invalidReason: reason, invalidMessage: message }),
    settle: async () => { settle++; return { success: false }; },
  });
  const app = createApp(config, { facilitatorClient: client, log() {},
    catalogue: { resolve: async () => info, list: async () => [info], canAnswer: async () => true },
    upstream: async () => { model++; return { content: "x", usage: { buyer_cost_micro: 1 } }; },
    fetchImpl: async () => { throw new Error("unexpected fetch"); } });
  const body = JSON.stringify({ model: "test", messages: [{ role: "user", content: "hello" }], max_tokens: 100 });
  const post = h => request(app, "/v1/chat/completions", { method: "POST", body, headers: { "content-type": "application/json", ...h } });
  const required = decode((await post({})).headers["payment-required"]);
  const accepted = required.accepts.find(a => a.network === network && a.scheme === "exact");
  const res = await post({ "payment-signature": encode({ x402Version: 2, resource: required.resource, accepted,
    payload: network === SOLANA ? { transaction: "fake" } : { signature: "fake", authorization: { from: "0x" + "2".repeat(40), nonce: "0x" + "3".repeat(64) } } }) });
  return { res, model, settle };
}

test("D-UNFUNDED-BASE: Base asks for USDC only, with the machine fields unchanged", async () => {
  const { res, model, settle } = await refused(BASE, "insufficient_funds", "contract call failed: unable to call contract: execution reverted");
  assert.equal(res.status, 402);
  assert.equal(res.body.code, "payment_unfunded");
  assert.equal(res.body.action, "fund_wallet");
  assert.equal(res.headers["x-singit-error"], "payment_unfunded");
  assert.ok(res.body.accepts.length > 0);
  assert.doesNotMatch(res.body.message, /token account/i);
  assert.match(res.body.message, /USDC on Base/);
  assert.match(res.body.message, /Nothing was charged/);
  assert.equal(model, 0);
  assert.equal(settle, 0);
});

test("D-UNFUNDED-SOL: Solana keeps the token-account guidance", async () => {
  const { res, model } = await refused(SOLANA, "invalid_exact_svm_payload_transaction_simulation_failed",
    "simulation failed: transaction would fail on-chain: map[InstructionError:[2 InvalidAccountData]]");
  assert.equal(res.body.code, "payment_unfunded");
  assert.equal(res.body.action, "fund_wallet");
  assert.equal(res.headers["x-singit-error"], "payment_unfunded");
  assert.match(res.body.message, /token account/);
  assert.equal(model, 0);
});

test("D-UNKNOWN-FACILITATOR: an unknown reason is payment_invalid, never unfunded or permit2", async () => {
  for (const text of ["unknown refusal detail", "facilitator said no", ""]) {
    const code = classifyPaymentFailure({ reason: "x", message: text });
    assert.equal(code, "payment_invalid");
    assert.notEqual(code, "permit2_allowance_required");
  }
  const { res } = await refused(BASE, "unknown_refusal", "unknown refusal detail");
  assert.equal(res.body.code, "payment_invalid");
  assert.equal(res.body.action, ACTIONS.payment_invalid);
  assert.equal(messageFor("payment_unfunded", SOLANA), messageFor("payment_unfunded", undefined), "only Base gets the Base text");
});

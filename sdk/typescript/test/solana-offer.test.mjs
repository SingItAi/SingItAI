// Solana challenge parsing and guard checks only (selectOffer is network-family-agnostic).
// Signing a real Solana upto/exact payload needs a funded @solana/kit TransactionSigner and a
// cluster RPC; out of scope for an offline unit test (see README "not supported yet").
import test from "node:test";
import assert from "node:assert/strict";
import { selectOffer, SingItPaymentError } from "../src/guards.js";
import { NETWORKS } from "../src/pins.js";

const SOLANA = NETWORKS.solana.caip;
const ASSET = NETWORKS.solana.asset;
const PAY_TO = NETWORKS.solana.payTo;
const RESOURCE_URL = "http://127.0.0.1:1/v1/chat/completions";
const OTHER_SOLANA_ADDRESS = "11111111111111111111111111111111111111111";

function challengeWith(offer) {
  return { x402Version: 2, resource: { url: RESOURCE_URL }, accepts: [offer] };
}
function solanaUptoOffer(overrides = {}) {
  return { scheme: "upto", network: SOLANA, asset: ASSET, payTo: PAY_TO, amount: "3000",
    maxTimeoutSeconds: 300, extra: { withdrawDelay: 300, feePayer: OTHER_SOLANA_ADDRESS,
      billing: { maxChargeAtomic: "3000" } }, ...overrides };
}
const opts = (overrides = {}) => ({ scheme: "upto", networkId: SOLANA, family: "svm",
  asset: ASSET, payTo: PAY_TO, maxCapAtomic: "3000", resourceUrl: RESOURCE_URL, ...overrides });

test("selectOffer accepts a real-shaped Solana upto offer (pricing.mjs values)", () => {
  const selected = selectOffer(challengeWith(solanaUptoOffer()), opts());
  assert.equal(selected.asset, NETWORKS.solana.asset);
  assert.equal(selected.payTo, NETWORKS.solana.payTo);
});

test("selectOffer refuses a Solana offer with a different payTo (base58 is case-sensitive)", () => {
  assert.throws(() => selectOffer(challengeWith(solanaUptoOffer({ payTo: OTHER_SOLANA_ADDRESS })), opts()), SingItPaymentError);
});

test("selectOffer refuses a Solana offer whose asset differs only in case (no case-folding for base58)", () => {
  const offer = solanaUptoOffer({ asset: ASSET.toLowerCase() });
  assert.throws(() => selectOffer(challengeWith(offer), opts()), SingItPaymentError);
});

test("selectOffer refuses a Solana offer over the configured per-call ceiling", () => {
  assert.throws(() => selectOffer(challengeWith(solanaUptoOffer({ amount: "9000" })), opts({ maxCapAtomic: "3000" })),
    /per-call ceiling/);
});

test("selectOffer picks the Solana offer among a mixed Base+Solana accepts list", () => {
  const baseOffer = { scheme: "upto", network: "eip155:8453", asset: NETWORKS.base.asset, payTo: NETWORKS.base.payTo,
    amount: "3000", maxTimeoutSeconds: 120, extra: { facilitatorAddress: `0x${"0".repeat(39)}1` } };
  const challenge = { x402Version: 2, resource: { url: RESOURCE_URL }, accepts: [baseOffer, solanaUptoOffer()] };
  const selected = selectOffer(challenge, opts());
  assert.equal(selected.network, SOLANA);
});

import test from "node:test";
import assert from "node:assert/strict";
import { selectOffer, DailyLimiter, usdToAtomic, SingItPaymentError, BASE_PIN } from "../src/x402/guards.js";

const addr = suffix => `0x${"0".repeat(40 - suffix.length)}${suffix}`;
const FACILITATOR = addr("2");
const OTHER_ADDRESS = addr("dead");
const RESOURCE_URL = "http://127.0.0.1:1/v1/chat/completions";

function challengeWith(offer) {
  return { x402Version: 2, resource: { url: RESOURCE_URL }, accepts: [offer] };
}
function offer(overrides = {}) {
  return {
    scheme: "upto", network: BASE_PIN.caip, asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "2000",
    maxTimeoutSeconds: 120, extra: { facilitatorAddress: FACILITATOR }, ...overrides,
  };
}
const opts = (overrides = {}) => ({ scheme: "upto", payTo: BASE_PIN.payTo, maxCapAtomic: "3000", resourceUrl: RESOURCE_URL, ...overrides });

test("selectOffer accepts a matching Base upto offer within the per-call ceiling", () => {
  const selected = selectOffer(challengeWith(offer()), opts());
  assert.equal(selected.amount, "2000");
});

test("selectOffer refuses an offer on a different network than Base", () => {
  assert.throws(() => selectOffer(challengeWith(offer({ network: "eip155:84532" })), opts()), /Expected exactly one/);
});

test("selectOffer refuses a different asset (not the pinned SingIt Ask USDC contract)", () => {
  assert.throws(() => selectOffer(challengeWith(offer({ asset: OTHER_ADDRESS })), opts()), SingItPaymentError);
});

test("selectOffer refuses a different payTo (not the pinned SingIt Ask address)", () => {
  assert.throws(() => selectOffer(challengeWith(offer({ payTo: OTHER_ADDRESS })), opts()), SingItPaymentError);
});

test("selectOffer refuses an amount over the configured per-call ceiling", () => {
  assert.throws(() => selectOffer(challengeWith(offer({ amount: "5000" })), opts({ maxCapAtomic: "3000" })), /per-call ceiling/);
});

test("selectOffer refuses a resource URL for a different endpoint", () => {
  const challenge = challengeWith(offer());
  challenge.resource.url = "http://evil.example/v1/chat/completions";
  assert.throws(() => selectOffer(challenge, opts()), /different resource/);
});

test("DailyLimiter refuses once the daily cap is reached", () => {
  const limiter = new DailyLimiter("5000");
  const release1 = limiter.reserve("3000");
  limiter.settle(release1, "3000", "3000");
  assert.throws(() => limiter.reserve("3000"), /Daily spend cap/);
});

test("DailyLimiter frees unused headroom when the actual charge is lower than reserved", () => {
  const limiter = new DailyLimiter("5000");
  const release = limiter.reserve("3000");
  limiter.settle(release, "1000", "3000");
  assert.equal(limiter.remainingAtomic(), 4000n);
});

test("usdToAtomic converts whole-dollar USD ceilings to micro-USDC", () => {
  assert.equal(usdToAtomic(0.01), "10000");
  assert.equal(usdToAtomic(1), "1000000");
});

test("usdToAtomic refuses a negative ceiling", () => {
  assert.throws(() => usdToAtomic(-1), SingItPaymentError);
});

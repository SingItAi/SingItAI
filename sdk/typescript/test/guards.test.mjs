import test from "node:test";
import assert from "node:assert/strict";
import { selectOffer, DailyLimiter, usdToAtomic, SingItPaymentError } from "../src/guards.js";

const addr = suffix => `0x${"0".repeat(40 - suffix.length)}${suffix}`;

const BASE_SEPOLIA = "eip155:84532";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = addr("1");
const FACILITATOR = addr("2");
const OTHER_ADDRESS = addr("dead");
const RESOURCE_URL = "http://127.0.0.1:1/v1/chat/completions";

function challengeWith(offer) {
  return { x402Version: 2, resource: { url: RESOURCE_URL }, accepts: [offer] };
}
function offer(overrides = {}) {
  return { scheme: "upto", network: BASE_SEPOLIA, asset: ASSET, payTo: PAY_TO, amount: "2000",
    maxTimeoutSeconds: 120, extra: { facilitatorAddress: FACILITATOR }, ...overrides };
}
const opts = (overrides = {}) => ({ scheme: "upto", networkId: BASE_SEPOLIA, family: "evm",
  asset: ASSET, payTo: PAY_TO, maxCapAtomic: "3000", resourceUrl: RESOURCE_URL, ...overrides });

test("selectOffer accepts a matching upto offer within the per-call ceiling", () => {
  const selected = selectOffer(challengeWith(offer()), opts());
  assert.equal(selected.amount, "2000");
});

test("selectOffer refuses a different asset", () => {
  assert.throws(() => selectOffer(challengeWith(offer({ asset: OTHER_ADDRESS })), opts()),
    SingItPaymentError);
});

test("selectOffer refuses a different payTo", () => {
  assert.throws(() => selectOffer(challengeWith(offer({ payTo: OTHER_ADDRESS })), opts()),
    SingItPaymentError);
});

test("selectOffer refuses an amount over the configured per-call ceiling", () => {
  assert.throws(() => selectOffer(challengeWith(offer({ amount: "5000" })), opts({ maxCapAtomic: "3000" })),
    /per-call ceiling/);
});

test("selectOffer refuses a resource URL for a different endpoint", () => {
  const challenge = challengeWith(offer());
  challenge.resource.url = "http://evil.example/v1/chat/completions";
  assert.throws(() => selectOffer(challenge, opts()), /different resource/);
});

test("selectOffer refuses a payload missing the upto facilitator address", () => {
  assert.throws(() => selectOffer(challengeWith(offer({ extra: {} })), opts()), /facilitator address/);
});

test("selectOffer is case-insensitive for EVM addresses", () => {
  const selected = selectOffer(challengeWith(offer({ asset: ASSET.toUpperCase().replace("0X", "0x") })), opts());
  assert.equal(selected.amount, "2000");
});

test("DailyLimiter refuses once the daily cap is reached", () => {
  const limiter = new DailyLimiter("5000");
  const release1 = limiter.reserve("3000");
  limiter.settle(release1, "3000", "3000");
  assert.throws(() => limiter.reserve("3000"), /Daily spend cap/);
  const release2 = limiter.reserve("2000");
  limiter.settle(release2, "2000", "2000");
});

test("DailyLimiter frees unused headroom when the actual charge is lower than reserved", () => {
  const limiter = new DailyLimiter("5000");
  const release = limiter.reserve("3000");
  limiter.settle(release, "1000", "3000");
  assert.equal(limiter.remainingAtomic(), 4000n);
});

test("DailyLimiter releases the full reservation if signing/sending fails", () => {
  const limiter = new DailyLimiter("5000");
  const release = limiter.reserve("3000");
  release();
  assert.equal(limiter.remainingAtomic(), 5000n);
});

test("usdToAtomic converts whole-dollar USD ceilings to micro-USDC", () => {
  assert.equal(usdToAtomic(0.01), "10000");
  assert.equal(usdToAtomic(1), "1000000");
});

test("usdToAtomic refuses a negative ceiling", () => {
  assert.throws(() => usdToAtomic(-1), SingItPaymentError);
});

test("a reservation from yesterday never reduces today's counter (Codex review)", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-24T23:59:59Z") });
  const limiter = new DailyLimiter("1000");
  const release = limiter.reserve("600"); // just before UTC midnight
  t.mock.timers.setTime(Date.parse("2026-10-25T00:00:01Z"));
  limiter.reserve("1000"); // today's counter is full
  release(); // yesterday's release must not free today's room
  assert.equal(limiter.remainingAtomic(), 0n);
  limiter.settle(release, "100", "600");
  assert.equal(limiter.remainingAtomic(), 0n);
});

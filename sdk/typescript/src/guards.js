// Client-side allowance guards: pin the merchant's offer (network, asset, payTo) before signing,
// cap a single call, and cap a rolling day of calls. Modeled on singit-ask's own buyers
// (src/metered-buyer.mjs, src/solana-buyer.mjs): same idea, generalized to any x402 merchant.

export class SingItPaymentError extends Error {}

export const isAtomicAmount = value => typeof value === "string" && /^[1-9][0-9]{0,27}$/.test(value);

const sameEvmAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const sameSvmAddress = (a, b) => typeof a === "string" && typeof b === "string" && a === b;

export function decodeHeader(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    throw new SingItPaymentError("The payment header could not be decoded.");
  }
}

// Picks the single offer matching scheme+network, then refuses to sign unless its asset and payTo
// are exactly the ones this SingIt instance was configured to pay, and its amount is within the
// per-call ceiling. Nothing here ever raises the ceiling: a merchant asking for more than
// `maxCapAtomic` is refused, never renegotiated.
export function selectOffer(challenge, { scheme, networkId, family, asset, payTo, maxCapAtomic, resourceUrl }) {
  if (!challenge || challenge.x402Version !== 2) {
    throw new SingItPaymentError("Unexpected x402 version in the payment challenge.");
  }
  if (resourceUrl && challenge.resource?.url !== resourceUrl) {
    throw new SingItPaymentError("The challenge names a different resource than the one called.");
  }
  const offers = (challenge.accepts ?? []).filter(a => a?.scheme === scheme && a?.network === networkId);
  if (offers.length !== 1) {
    throw new SingItPaymentError(`Expected exactly one ${scheme} offer on ${networkId}; got ${offers.length}.`);
  }
  const offer = offers[0];
  const sameAddress = family === "evm" ? sameEvmAddress : sameSvmAddress;
  if (!sameAddress(offer.asset, asset)) {
    throw new SingItPaymentError(`Unexpected payment asset (${offer.asset}); refusing to sign.`);
  }
  if (!sameAddress(offer.payTo, payTo)) {
    throw new SingItPaymentError(`Unexpected payee (${offer.payTo}); refusing to sign.`);
  }
  if (!isAtomicAmount(offer.amount) || !isAtomicAmount(maxCapAtomic) || BigInt(offer.amount) > BigInt(maxCapAtomic)) {
    throw new SingItPaymentError(`Offer amount ${offer.amount} exceeds the configured per-call ceiling (${maxCapAtomic}).`);
  }
  if (!Number.isInteger(offer.maxTimeoutSeconds) || offer.maxTimeoutSeconds < 1 || offer.maxTimeoutSeconds > 600) {
    throw new SingItPaymentError("Unexpected payment timeout window in the offer.");
  }
  if (family === "evm" && offer.scheme === "upto") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(offer.extra?.facilitatorAddress ?? "") || /^0x0{40}$/i.test(offer.extra.facilitatorAddress)) {
      throw new SingItPaymentError("The offer has no usable facilitator address for the upto scheme.");
    }
  }
  return offer;
}

// A simple, in-memory, per-UTC-day spend counter. It is not durable (lost on restart) and not
// shared across processes: it is a client-side allowance guard, not a ledger. Documented in the
// README as such. Checked against the offer's worst-case amount before signing (the most a
// request could ever cost), then adjusted down to the amount actually billed afterwards, so an
// `upto` request that settles for less than its ceiling frees the unused headroom immediately.
export class DailyLimiter {
  constructor(capAtomic) {
    this.capAtomic = BigInt(capAtomic);
    this.day = null;
    this.spentAtomic = 0n;
  }
  #rollIfNeeded() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.spentAtomic = 0n;
    }
  }
  remainingAtomic() {
    this.#rollIfNeeded();
    const remaining = this.capAtomic - this.spentAtomic;
    return remaining > 0n ? remaining : 0n;
  }
  reserve(worstCaseAtomic) {
    this.#rollIfNeeded();
    const amount = BigInt(worstCaseAtomic);
    if (this.spentAtomic + amount > this.capAtomic) {
      throw new SingItPaymentError(
        `Daily spend cap reached: ${this.spentAtomic} already spent today, ${amount} more would exceed ${this.capAtomic} micro-USDC.`
      );
    }
    this.spentAtomic += amount;
    // A release only ever touches the day it was reserved on: a request that spans UTC midnight must not take
    // yesterday's reservation off today's counter (Codex review).
    const day = this.day;
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      this.#rollIfNeeded();
      if (this.day === day) this.spentAtomic -= amount;
    };
    release.day = day;
    return release;
  }
  settle(release, actualAtomic, worstCaseAtomic) {
    this.#rollIfNeeded();
    if (release.day !== this.day) return; // yesterday's spend; today's counter starts clean
    release();
    this.spentAtomic += BigInt(actualAtomic ?? worstCaseAtomic);
  }
}

export const usdToAtomic = usd => {
  if (!(typeof usd === "number" && Number.isFinite(usd) && usd >= 0)) {
    throw new SingItPaymentError("maxPerCallUsd/maxPerDayUsd must be a non-negative number.");
  }
  return BigInt(Math.round(usd * 1e6)).toString();
};

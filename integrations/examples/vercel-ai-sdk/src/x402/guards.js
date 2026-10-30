// Vendored and trimmed from sdk/typescript/src/{guards.js,pins.js} (Base only — this plugin pays
// through an agent's EVM wallet key, not a Solana signer). Keep in sync by hand; do not import the
// @singitai/sdk package by path, so this plugin installs standalone from npm.
//
// Pins the merchant's offer (network, asset, payTo) before signing, caps a single call, and caps a
// rolling day of calls — the same guards @singitai/sdk applies in front of SingIt Ask.

export class SingItPaymentError extends Error {}

// Live SingIt Ask Base addresses (singit-ask/src/pricing.mjs, sdk/typescript/src/pins.js).
export const BASE_PIN = {
  caip: "eip155:8453",
  chainId: 8453,
  viemChain: "base",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0xC23d1Dc0f5fCe1abfFB051e06cB93f0329968B4e",
  defaultRpcUrl: "https://mainnet.base.org",
};

export const DEFAULT_ASK_BASE_URL = "https://ask.singitai.app";

export const isAtomicAmount = value => typeof value === "string" && /^[1-9][0-9]{0,27}$/.test(value);

const sameEvmAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export function decodeHeader(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    throw new SingItPaymentError("The payment header could not be decoded.");
  }
}

// Picks the single offer matching scheme+network on Base, then refuses to sign unless its asset
// and payTo are exactly the pinned SingIt Ask ones, and its amount is within the per-call ceiling.
// Nothing here ever raises the ceiling: a merchant asking for more than maxCapAtomic is refused.
export function selectOffer(challenge, { scheme, payTo, maxCapAtomic, resourceUrl }) {
  if (!challenge || challenge.x402Version !== 2) {
    throw new SingItPaymentError("Unexpected x402 version in the payment challenge.");
  }
  if (resourceUrl && challenge.resource?.url !== resourceUrl) {
    throw new SingItPaymentError("The challenge names a different resource than the one called.");
  }
  const offers = (challenge.accepts ?? []).filter(a => a?.scheme === scheme && a?.network === BASE_PIN.caip);
  if (offers.length !== 1) {
    throw new SingItPaymentError(`Expected exactly one ${scheme} offer on ${BASE_PIN.caip}; got ${offers.length}.`);
  }
  const offer = offers[0];
  if (!sameEvmAddress(offer.asset, BASE_PIN.asset)) {
    throw new SingItPaymentError(`Unexpected payment asset (${offer.asset}); refusing to sign.`);
  }
  if (!sameEvmAddress(offer.payTo, payTo)) {
    throw new SingItPaymentError(`Unexpected payee (${offer.payTo}); refusing to sign.`);
  }
  if (!isAtomicAmount(offer.amount) || !isAtomicAmount(maxCapAtomic) || BigInt(offer.amount) > BigInt(maxCapAtomic)) {
    throw new SingItPaymentError(`Offer amount ${offer.amount} exceeds the configured per-call ceiling (${maxCapAtomic}).`);
  }
  if (!Number.isInteger(offer.maxTimeoutSeconds) || offer.maxTimeoutSeconds < 1 || offer.maxTimeoutSeconds > 600) {
    throw new SingItPaymentError("Unexpected payment timeout window in the offer.");
  }
  if (offer.scheme === "upto") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(offer.extra?.facilitatorAddress ?? "") || /^0x0{40}$/i.test(offer.extra.facilitatorAddress)) {
      throw new SingItPaymentError("The offer has no usable facilitator address for the upto scheme.");
    }
  }
  return offer;
}

// A simple, in-memory, per-UTC-day spend counter. Not durable (lost on restart), not shared across
// processes: a client-side allowance guard, not a ledger. Checked against the offer's worst-case
// amount before signing, then adjusted down to the amount actually billed afterwards.
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
    if (release.day !== this.day) return;
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

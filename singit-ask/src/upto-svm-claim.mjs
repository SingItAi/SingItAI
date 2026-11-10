// Solana upto claim vs deposit (SI-291).
//
// The 2026-11-09 22:08 Prague failures (payer redacted) paired
// "answer ready ... settling 2000" with settle failed amount=2004/2006/2004
// and invalid_upto_svm_channel_already_open. That error is returned only from
// facilitator settleDeposit when the channel PDA already exists, so CDP ran
// the after-handler settle as a deposit/open.
//
// @x402/svm 2.28 and 2.30 dispatch (upto/facilitator settle()) is:
//   type === "deposit" → settleDeposit
//   type === "claim"   → settleClaim
//   delegated && no type → invalid_upto_svm_payload_type
//   hasOwnProperty("voucherSignature") → settleClaim  (empty string counts)
//   requirements.amount === payload.maxAmount → settleDeposit
//   else → invalid_upto_svm_payload_missing_voucher
// 2.30 does not change this ladder or enrichSettlementPayload; it only also
// returns already_open from read-only /verify (escrow skips facilitator verify).
//
// We do not hold receiverAuthorizerSigner (delegated CDP setup), so the SDK
// stamps type:"claim" and no voucher. HTTPFacilitatorClient.toJsonSafe keeps
// that type. already_open plus a logged ceiling (not the 2000 override) means
// CDP did not take type:"claim" and compared amount == maxAmount.
// An empty voucherSignature is the documented delegated fallback when type is
// absent: it does not change the type:"claim" path (hasVoucher requires a
// non-empty signature; settleClaim then authenticates via CDP's signer).

import { UptoSvmScheme } from "@x402/svm/upto/server";
import { SETTLEMENT_OVERRIDES_HEADER } from "@x402/core/http";

export const ERR_CHANNEL_ALREADY_OPEN = "invalid_upto_svm_channel_already_open";
export const ERR_PAYLOAD_TYPE = "invalid_upto_svm_payload_type";
export const ERR_MISSING_VOUCHER = "invalid_upto_svm_payload_missing_voucher";

// Redacted 22:08 Prague incident (journal 2026-11-09T22:08:49+01:00 .. 22:09:02).
export const INCIDENT_2208 = Object.freeze({
  billedAtomic: "2000",
  ceilingsAtomic: Object.freeze(["2004", "2006", "2004"]),
});

export function selectUptoSvmSettlePath(payload, requirements, { delegated = false } = {}) {
  const p = payload?.payload ?? payload;
  let actual, maxAmount;
  try {
    actual = BigInt(requirements.amount);
    maxAmount = BigInt(p.maxAmount);
  } catch {
    return { path: "invalid", reason: "invalid_upto_svm_payload_amount" };
  }
  if (actual < 0n || actual > maxAmount) {
    return { path: "invalid", reason: "invalid_upto_svm_payload_amount" };
  }
  if (p.type === "deposit") return { path: "deposit" };
  if (p.type === "claim") return { path: "claim" };
  if (delegated) return { path: "invalid", reason: ERR_PAYLOAD_TYPE };
  if (Object.prototype.hasOwnProperty.call(p, "voucherSignature")) return { path: "claim" };
  if (actual === maxAmount) return { path: "deposit" };
  return { path: "invalid", reason: ERR_MISSING_VOUCHER };
}

export function simulateUptoSvmSettle(payload, requirements, {
  delegated = false, channelExists = false, stripType = false,
} = {}) {
  const raw = payload?.payload ?? payload;
  const viewed = stripType ? Object.fromEntries(
    Object.entries(raw).filter(([key]) => key !== "type"),
  ) : raw;
  const wrapped = payload?.payload ? { ...payload, payload: viewed } : viewed;
  const selected = selectUptoSvmSettlePath(wrapped, requirements, { delegated });
  if (selected.path === "deposit" && channelExists) {
    return { path: "deposit", success: false, errorReason: ERR_CHANNEL_ALREADY_OPEN };
  }
  if (selected.path === "deposit" || selected.path === "claim") {
    return { path: selected.path, success: true };
  }
  return { path: selected.path, success: false, errorReason: selected.reason };
}

export function createUptoSvmServerScheme(options) {
  const scheme = new UptoSvmScheme(options);
  const enrich = scheme.enrichSettlementPayload;
  scheme.enrichSettlementPayload = async (ctx) => {
    const extra = await enrich(ctx);
    if (!extra || extra.type !== "claim") return extra;
    if (Object.prototype.hasOwnProperty.call(extra, "voucherSignature")) return extra;
    const raw = ctx?.paymentPayload?.payload;
    if (raw && Object.prototype.hasOwnProperty.call(raw, "voucherSignature")) return extra;
    return { ...extra, voucherSignature: "" };
  };
  return scheme;
}

function overrideAmountFromHeaders(headers) {
  if (!headers || typeof headers !== "object") return;
  const raw = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === SETTLEMENT_OVERRIDES_HEADER.toLowerCase())?.[1];
  if (raw == null) return;
  let parsed = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { return; }
  }
  const amount = parsed?.amount == null ? undefined : String(parsed.amount);
  if (!amount || !/^(0|[1-9][0-9]*)$/.test(amount)) return;
  return amount;
}

// Re-apply Settlement-Overrides onto the object settlePayment will POST.
// When the header was already applied, this is a no-op. When it was not,
// mutating in place is what the facilitator call observes (the local
// effectiveRequirements binding is this same object).
export function applySettlementOverrideAmount(ctx) {
  if (ctx?.phase !== "after-handler" || ctx?.requirements?.scheme !== "upto") return;
  const amount = overrideAmountFromHeaders(ctx.transportContext?.responseHeaders);
  if (amount == null) return;
  try {
    if (BigInt(amount) > BigInt(ctx.requirements.amount)) return;
  } catch { return; }
  ctx.requirements.amount = amount;
}

const claimGuardServers = new WeakSet();
export function attachUptoSvmClaimGuards(server) {
  if (claimGuardServers.has(server)) return server;
  claimGuardServers.add(server);
  server.onBeforeSettle(applySettlementOverrideAmount);
  return server;
}

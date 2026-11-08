// One payment, one answer at a time: chat completions, Messages and Responses reserve the signed payment before the
// x402 middleware verifies it, so an identical copy that arrives while the first is still being answered is refused
// with 409 payment_duplicate before any verification, model call or settlement. Without this, two copies of one
// payment sent together both reached the model (the seller was paid twice; the facilitator settled once).
//
// The reservation is released when the first request's response is written, whatever its outcome: payment_duplicate
// means only "this payment is in flight". A later replay of a payment that already settled is refused by the
// facilitator, as before. The reservations live in this process's memory (shared with image edits and embeddings,
// media-payment-replay.mjs): not across processes and not across a restart. The service runs as one process
// (deploy/singit-ask.service).
import { createHash, randomUUID } from "node:crypto";
import { paymentDigest, reservePayment, releasePayment } from "./media-payment-replay.mjs";

// RFC 8785-style canonical JSON for values parsed from JSON: object keys sorted, arrays in order.
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}
export const bodyHash = body => createHash("sha256").update(canonicalJson(body ?? null), "utf8").digest("hex");

// (paymentDigest, route, network, bodyHash). The digest identifies a repeat of the payment; it proves nothing else.
export const chatPaymentKey = (payment, route, body) => "chat:" + createHash("sha256").update(JSON.stringify(
  [paymentDigest(payment), route, String(payment?.accepted?.network ?? ""), bodyHash(body)])).digest("hex");

// Reserves this request's payment. Returns "none" (no readable payment: the x402 middleware answers it), "reserved",
// "duplicate" or "full". A reservation is released when the response is written.
export function reserveChatPayment(req, res, route) {
  const header = req.get("payment-signature") ?? req.get("x-payment");
  if (!header) return "none";
  let payment;
  try { payment = JSON.parse(Buffer.from(header, "base64").toString()); } catch { return "none"; }
  if (!payment || typeof payment !== "object") return "none";
  const key = chatPaymentKey(payment, route, req.body);
  const result = reservePayment(key);
  if (result !== "reserved") return result;
  // Installed before the x402 middleware wraps res.end, so this runs when the final response is actually written:
  // after settlement on success, or with the refusal otherwise.
  const end = res.end.bind(res);
  let released = false;
  res.end = (...args) => {
    if (!released) { released = true; releasePayment(key); }
    return end(...args);
  };
  return "reserved";
}

// The refusal for an identical payment still in flight, or for a full reservation table.
export function reservationRefusal(res, result, envelope) {
  res.set("Cache-Control", "no-store");
  const request_id = `req_${randomUUID()}`;
  if (result === "duplicate") {
    res.set("Retry-After", "1");
    return { status: 409, body: { ...envelope(409, "This payment is already being processed. Wait, then retry the same payment; nothing more was charged.",
      "payment_duplicate"), action: "retry_same_payment", request_id } };
  }
  res.set("Retry-After", "30");
  return { status: 503, body: { ...envelope(503, "Payment capacity is busy. You were not charged.", "upstream_unavailable"), request_id } };
}

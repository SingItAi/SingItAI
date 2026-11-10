import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import express from "express";

// Signed webhook receiver for nohumans.directory alerts (POST /webhooks/nohumans). Free, never priced, and deliberately
// absent from OpenAPI, /.well-known/x402, llms.txt and discoverableRoutes.
export const NOHUMANS_PATH = "/webhooks/nohumans";
export const MAX_AGE_SECONDS = 300;      // older stamps are replays
export const MAX_FUTURE_SECONDS = 60;    // clock skew allowance
export const MAX_SEEN = 2000;
export const SEEN_TTL_MS = 25 * 60 * 60 * 1000;  // their retries last about a day
const LOG_MAX = 200;
const NOTIFY_TIMEOUT_MS = 3000;

export function signatureFor(secret, timestamp, rawBody) {
  return "v1=" + createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
}

// Compares the whole "v1=..." strings in constant time; a length mismatch is simply invalid.
export function verifySignature(secret, timestamp, rawBody, header) {
  if (typeof header !== "string" || typeof timestamp !== "string") return false;
  const expected = Buffer.from(signatureFor(secret, timestamp, rawBody));
  const given = Buffer.from(header);
  try { return timingSafeEqual(expected, given); } catch { return false; }
}

// Unix seconds as a decimal string: not older than 5 minutes, not more than 60 seconds ahead.
export function timestampFresh(timestamp, nowMs) {
  if (typeof timestamp !== "string" || !/^\d{1,13}$/.test(timestamp)) return false;
  const age = Math.floor(nowMs / 1000) - Number(timestamp);
  return age <= MAX_AGE_SECONDS && age >= -MAX_FUTURE_SECONDS;
}

// A test event sent while the hook is being created is signed with a secret we do not have yet.
export function isRegistrationTest(body) {
  return body?.type === "alerts.test" && body?.registration === true;
}

// Remembers accepted deliveries (by delivery header and body id), capped and expiring.
export class SeenDeliveries {
  constructor({ max = MAX_SEEN, ttlMs = SEEN_TTL_MS } = {}) { this.max = max; this.ttlMs = ttlMs; this.map = new Map(); }
  #prune(now) {
    for (const [key, at] of this.map) { if (now - at < this.ttlMs) break; this.map.delete(key); }
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  has(keys, now) { this.#prune(now); return keys.some(key => this.map.has(key)); }
  add(keys, now) { for (const key of keys) { this.map.delete(key); this.map.set(key, now); } this.#prune(now); }
}

const clip = value => typeof value === "string" ? (value.length > LOG_MAX ? value.slice(0, LOG_MAX) + "…" : value) : value;
const scalar = value => typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? clip(value) : undefined;

// Looks in the body and its likely containers; only short scalar values are ever taken, never the raw body.
function pick(body, names, containers = [body, body?.listing, body?.data, body?.purchase, body?.data?.listing, body?.data?.purchase]) {
  for (const name of names) for (const c of containers) {
    const v = c && typeof c === "object" ? scalar(c[name]) : undefined;
    if (v !== undefined) return v;
  }
  return undefined;
}

export function summarize(body, { event, delivery }) {
  const type = scalar(body?.type) ?? clip(event);
  const fields = { type, delivery: clip(delivery), id: scalar(body?.id), hook_id: pick(body, ["hook_id"]),
    listing_id: pick(body, ["listing_id"]) ?? scalar(body?.listing?.id) ?? scalar(body?.data?.listing?.id),
    listing_name: pick(body, ["listing_name", "name"]), endpoint_url: pick(body, ["endpoint_url"]) };
  if (type === "listing.purchase") for (const k of ["delivered", "failure_reason", "http_status", "amount_usdc", "tx_hash"]) fields[k] = pick(body, [k]);
  return fields;
}

const failure = (res, status, code, message) => res.status(status).json({ error: { type: "invalid_request_error", code, message } });

async function readSecret(config) {
  if (config.nohumansAlertSecretFile) {
    try { return (await readFile(config.nohumansAlertSecretFile, "utf8")).trim() || null; } catch { return null; }
  }
  return config.nohumansAlertSecret?.trim() || null;
}

// Returns Express handlers for POST /webhooks/nohumans; mount them before the global express.json.
export function nohumansAlertHandlers(config, { log = console.error, fetchImpl = fetch, clock = Date, seen = new SeenDeliveries() } = {}) {
  const notify = async (fields) => {
    const url = config.nohumansAlertWebhookUrl;
    if (!url) return;
    try {
      const text = `nohumans.directory purchase: ${fields.listing_name ?? fields.listing_id ?? "listing"}`
        + `${fields.amount_usdc !== undefined ? ` ${fields.amount_usdc} USDC` : ""}`
        + `${fields.delivered === false ? ` (not delivered: ${fields.failure_reason ?? "unknown"})` : ""}`;
      await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: clip(text) }), signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS) });
    } catch (error) { log(`singit-ask: nohumans.notify_failed ${clip(String(error?.name ?? "error"))}`); }
  };

  const noStore = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
  const raw = express.raw({ type: "application/json", limit: "64kb" });
  const handle = async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return failure(res, 400, "invalid_json", "Send a JSON body.");
    let body;
    try { body = JSON.parse(req.body.toString("utf8")); } catch { return failure(res, 400, "invalid_json", "Send valid JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return failure(res, 400, "invalid_json", "Send a JSON object.");
    const now = clock.now();
    const header = name => { const v = req.get(name); return typeof v === "string" ? v : undefined; };
    const delivery = header("x-nohumans-delivery");
    const event = header("x-nohumans-event");

    if (isRegistrationTest(body)) {
      log(`singit-ask: nohumans.alerts.test ${JSON.stringify({ registration: true, delivery: clip(delivery), hook_id: pick(body, ["hook_id"]) })}`);
      return res.status(200).json({ ok: true });
    }

    const secret = await readSecret(config);
    if (!secret) {
      log("singit-ask: nohumans.secret_missing");
      return res.set("Retry-After", "60").status(503).json({ error: { type: "api_error", code: "not_configured", message: "Webhook secret is not configured yet; retry later." } });
    }
    const timestamp = header("x-nohumans-timestamp");
    if (!timestampFresh(timestamp, now) || !verifySignature(secret, timestamp, req.body, header("x-nohumans-signature"))) {
      log(`singit-ask: nohumans.rejected ${JSON.stringify({ delivery: clip(delivery), reason: timestampFresh(timestamp, now) ? "signature" : "timestamp" })}`);
      return failure(res, 401, "invalid_signature", "Signature or timestamp is not valid.");
    }

    const keys = [];
    if (delivery) keys.push(`d:${delivery}`);
    if (typeof body.id === "string" || typeof body.id === "number") keys.push(`i:${body.id}`);
    if (keys.length && seen.has(keys, now)) {
      log(`singit-ask: nohumans.duplicate ${JSON.stringify({ delivery: clip(delivery) })}`);
      return res.status(200).json({ ok: true });
    }
    if (keys.length) seen.add(keys, now);

    const fields = summarize(body, { event, delivery });
    log(`singit-ask: nohumans.${fields.type ?? "event"} ${JSON.stringify(fields)}`);
    res.status(200).json({ ok: true });
    if (fields.type === "listing.purchase") void notify(fields);
  };
  return [noStore, raw, (req, res, next) => handle(req, res).catch(next)];
}

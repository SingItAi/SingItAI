import { validTraffic, recordTraffic, trafficNumbers } from './agent-traffic.mjs';

import { PAYMENT_ERROR_CODES } from "./payment-codes.mjs";
// Observed model and payment-rail health and settled usage counters: public status and numbers should
// describe what this installation has seen, rather than promise that an untested model or rail works.
// Recorded: model and rail successes/failures, last outcomes, hourly counts, settled amounts, own-payment
// exclusions and bounded unique-payer counts. Never recorded: payer addresses, error text or prompts.
// History starts at `since`; there is no history before these counters were created. Payers are counted
// using truncated HMAC hashes with a random per-install salt, kept in the private persisted state.
// Hourly buckets are retained for 30 days (720 hours); model ids are capped at 300, payer hashes at
// 20,000 overall and 500 per hourly bucket. Totals remain since `since`; capped unique counts are marked.
// Stats are observational only: recording or persistence failures can never affect an answer or a payment.
// Paid-call success and answer latency are recorded only for payers known not to be ours, so nothing is
// recorded while the own-payer list is empty. Latency keeps up to 200 integer ms samples per network and hour.

import { randomBytes, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { normalize } from "./own-payers.mjs";

export const HOUR = 3600000, RETENTION_HOURS = 720, MODEL_CAP = 300, PAYER_CAP = 20000, BUCKET_PAYER_CAP = 500;
export const DOWN_RATE = 0.5, DEGRADED_RATE = 0.1, DOWN_ATTEMPTS = 3;
export const networkName = n => n === "eip155:8453" ? "base"
  : n === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" ? "solana" : "other";
const REASONS = ["no_healthy_sellers", "minimum_discount_not_met", "other"];
const failureReason = code => REASONS.includes(code) ? code : "other";
const challengeCounts = () => ({ post: 0, probe: 0, refused: 0, routes: Object.create(null) });
export const ROUTE_CAP = 100, LATENCY_CAP = 200, MIN_SAMPLES = 20;
// Mirror the settle failure-code guard: chain outcomes must be known before calling them refusals.
export function isIndeterminateSettlement(error) {
  const seen = new Set();
  for (let e = error; e && typeof e === "object" && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (["FacilitatorTimeoutError", "FacilitatorResponseError"].includes(e.name) || e.transaction || e.transactionHash) return true;
    const text = [e.invalidReason, e.errorReason, e.invalidMessage, e.errorMessage, e.message]
      .filter(v => typeof v === "string").join(" ");
    if (/pending|time(?:d)? ?out|transport|network error|fetch failed|unavailable|unexpected|settlement failed|unknown reason/i.test(text)) return true;
  }
  return false;
}
const minute = t => Number.isFinite(t) ? new Date(Math.floor(t / 60000) * 60000).toISOString() : null;
const empty = () => ({ calls: 0, atomic: "0", noAmount: 0, own: 0, fail: 0 });
export function outcomeStatus(ok, fail, lastFailed) {
  const rate = fail / (ok + fail);
  return lastFailed && rate >= DOWN_RATE && ok + fail >= DOWN_ATTEMPTS ? "down"
    : rate > DEGRADED_RATE || lastFailed ? "degraded" : "up";
}
// Persisted state is private but still untrusted input: partial writes or an older shape must not turn
// counters into NaN, retain unexpected data, or make a read endpoint throw. Reject invalid files as a unit.
function validState(s) {
  const object = o => o && typeof o === "object" && !Array.isArray(o);
  const count = n => Number.isSafeInteger(n) && n >= 0;
  const hashes = (a, cap) => Array.isArray(a) && a.length <= cap
    && a.every(h => typeof h === "string" && /^[a-f0-9]{16}$/.test(h));
  const last = o => object(o) && typeof o.failed === "boolean"
    && [o.ok, o.fail].every(t => t === undefined || count(t));
  const counts = o => object(o) && count(o.ok) && count(o.fail);
  const reasons = o => object(o) && Object.entries(o).every(([key, n]) => REASONS.includes(key) && count(n));
  const modelLast = o => last(o) && (o.lastReason === undefined || REASONS.includes(o.lastReason));
  const modelCounts = o => counts(o) && [o.r422, o.rt].every(n => n === undefined || count(n)) && (o.reasons === undefined || reasons(o.reasons));
  const totals = o => object(o) && Object.entries(o).every(([n, t]) =>
    ["base", "solana", "other"].includes(n) && object(t)
    && [t.calls, t.noAmount, t.own, t.fail].every(count) && /^\d+$/.test(t.atomic));
  const models = (o, valid) => object(o) && Object.keys(o).length <= MODEL_CAP
    && Object.entries(o).every(([id, v]) => /^[A-Za-z0-9._:/-]{1,80}$/.test(id) && valid(v));
  const networks = (o, valid) => object(o) && Object.entries(o).every(([n, v]) =>
    ["base", "solana", "other"].includes(n) && valid(v));
  const c402 = o => object(o) && [o.post, o.probe, o.refused].every(count)
    && object(o.routes) && Object.keys(o.routes).length <= ROUTE_CAP
    && Object.entries(o.routes).every(([key, n]) => (key === "other" || /^\/[^\s]{0,200}$/.test(key)) && count(n));
  const refusals = o => object(o) && Object.entries(o).every(([k, n]) => PAYMENT_ERROR_CODES.includes(k) && count(n));
  const phases = o => o === undefined || (object(o) && Object.entries(o).every(([k, v]) => ["verify", "settle"].includes(k) && refusals(v)));
  const paid = o => o === undefined || networks(o, c => object(c) && count(c.attempts) && count(c.answered)
    && Array.isArray(c.ms) && c.ms.length <= LATENCY_CAP && c.ms.every(count));
  const cwa = o => o === undefined || networks(o, count);
  const windows = o => o === undefined || (object(o) && Object.entries(o).every(([k, n]) => ["unverified", "budget", "timeout", "late"].includes(k) && count(n)));
  return object(s) && cwa(s.su) && (s.suSince === undefined || Number.isFinite(Date.parse(s.suSince))) && cwa(s.cwa) && (s.cwaSince === undefined || Number.isFinite(Date.parse(s.cwaSince))) && phases(s.paymentFailurePhases) && windows(s.windowRefusals) && (s.agent_traffic === undefined || validTraffic(s.agent_traffic)) && (s.paymentFailures === undefined || refusals(s.paymentFailures)) && (s.c402 === undefined || c402(s.c402)) && /^[a-f0-9]{64}$/.test(s.salt) && Number.isFinite(Date.parse(s.since))
    && hashes(s.payers, PAYER_CAP) && typeof s.capped === "boolean" && totals(s.totals)
    && models(s.models, modelLast) && networks(s.networks, last) && object(s.buckets)
    && Object.keys(s.buckets).length <= RETENTION_HOURS
    && Object.entries(s.buckets).every(([key, b]) => Number.isFinite(Date.parse(key)) && object(b)
      && paid(b.paid) && cwa(b.su) && cwa(b.cwa) && (b.agent_traffic === undefined || validTraffic(b.agent_traffic)) && (b.paymentFailures === undefined || refusals(b.paymentFailures)) && phases(b.paymentFailurePhases) && windows(b.windowRefusals) && (b.c402 === undefined || c402(b.c402)) && models(b.models, modelCounts) && networks(b.networks, counts) && totals(b.totals)
      && hashes(b.payers, BUCKET_PAYER_CAP) && typeof b.capped === "boolean");
}
export class HealthStats {
  constructor({ file = null, now = Date.now, isPublicRoute = () => true, ownPayers = [], readOnly = false, isPaidRoute = () => false, log = () => {} } = {}) {
    Object.assign(this, { file, now, isPublicRoute, isPaidRoute, readOnly, log });
    this.own = new Set(ownPayers.filter(p => typeof p === "string").map(normalize));
    this.state = { since: new Date(now()).toISOString(), salt: randomBytes(32).toString("hex"),
      buckets: {}, totals: {}, models: Object.create(null), networks: {}, payers: [], capped: false };
    try {
      const s = JSON.parse(readFileSync(file, "utf8"));
      // Reject incomplete files as a unit: retaining totals without their salt would silently break deduplication.
      if (validState(s)) this.state = s;
    } catch {}
    // Files from before this counter existed start it now; it is never backdated to `since`.
    this.state.cwaSince ??= new Date(now()).toISOString();
    this.state.suSince ??= new Date(now()).toISOString();
    // A loaded JSON object has a prototype; dictionaries must not interpret valid model ids such as
    // "constructor" as inherited entries. Every dictionary is rebuilt before it can observe an event.
    this.state.models = Object.assign(Object.create(null), this.state.models);
    for (const b of Object.values(this.state.buckets)) b.models = Object.assign(Object.create(null), b.models);
    for (const target of [this.state, ...Object.values(this.state.buckets)]) {
      target.paymentFailures ??= {};
      target.c402 ??= challengeCounts();
      target.c402.routes = Object.assign(Object.create(null), target.c402.routes);
    }
    const ownHashes = new Set([...this.own].map(p => createHmac("sha256", this.state.salt).update(p).digest("hex").slice(0, 16)));
    let removed = false;
    for (const target of [this.state, ...Object.values(this.state.buckets)]) {
      const filtered = target.payers.filter(h => !ownHashes.has(h));
      if (filtered.length !== target.payers.length) { target.payers = filtered; removed = true; }
    }
    this.prune();
    if (removed) this.changed();
  }
  prune() {
    const cutoff = Math.floor(this.now() / HOUR) * HOUR - (RETENTION_HOURS - 1) * HOUR;
    for (const key of Object.keys(this.state.buckets)) if (!(Date.parse(key) >= cutoff)) delete this.state.buckets[key];
  }
  changed() {
    this.prune();
    if (!this.readOnly && this.file && !this.timer) { this.timer = setTimeout(() => this.flush(), 10000); this.timer.unref(); }
  }
  flush() {
    try {
      clearTimeout(this.timer); this.timer = null;
      if (this.readOnly || !this.file) return;
      this.prune(); mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600, flag: "wx" }); renameSync(tmp, this.file);
    } catch (e) {
      if (!this.writeFailed) { this.writeFailed = true; try { this.log(e.code || "STATS_WRITE"); } catch {} }
    }
  }
  bucket(t = this.now()) {
    const key = new Date(Math.floor(t / HOUR) * HOUR).toISOString();
    return this.state.buckets[key] ??= {
      models: Object.create(null), networks: {}, totals: {}, payers: [], capped: false, c402: challengeCounts(), paymentFailures: {} };

  }
  // Only a payer that is known and not on a non-empty own-payer list is external; unknown payers are not.
  isExternal(payer) {
    return this.own.size > 0 && typeof payer === "string" && payer.trim() !== "" && !this.own.has(normalize(payer));
  }
  // Attempt and answer go to the hour the paid handler started, so a window never has more answers than attempts.
  paidCounts(network, started) {
    const n = networkName(network);
    if (n === "other") return null;
    const b = this.bucket(Number.isFinite(started) ? started : this.now());
    return (b.paid ??= {})[n] ??= { attempts: 0, answered: 0, ms: [] };
  }
  recordPaidAttempt({ network, external, started } = {}) {
    try {
      if (external !== true || this.own.size === 0) return;
      const c = this.paidCounts(network, started);
      if (c) { c.attempts++; this.changed(); }
    } catch {}
  }
  recordPaidAnswer({ network, external, started, ms } = {}) {
    try {
      if (external !== true || this.own.size === 0 || !Number.isSafeInteger(ms) || ms < 0) return;
      const c = this.paidCounts(network, started);
      if (!c) return;
      c.answered++;
      if (c.ms.length < LATENCY_CAP) c.ms.push(ms);
      this.changed();
    } catch {}
  }
  // A successful settlement without a 2xx answer: an integrity break whoever paid, so it counts every payer.
  recordChargeWithoutAnswer(network) {
    try {
      const n = networkName(network);
      for (const target of [this.state, this.bucket()]) {
        target.cwa ??= {};
        target.cwa[n] = (target.cwa[n] || 0) + 1;
      }
      this.changed();
    } catch {}
  }
  recordSettlementUnknown(network) {
    try {
      const n = networkName(network);
      for (const target of [this.state, this.bucket()]) {
        target.su ??= {};
        target.su[n] = (target.su[n] || 0) + 1;
      }
      this.changed();
    } catch {}
  }
  recordAgent(req) { try { recordTraffic(this, req); } catch {} }

  recordPaymentFailure({ code, phase } = {}) {
    try {
      if (!PAYMENT_ERROR_CODES.includes(code)) return;
      for (const target of [this.state, this.bucket()]) {
        target.paymentFailures ??= {};
        target.paymentFailures[code] = (target.paymentFailures[code] || 0) + 1;
        // Private only (/internal/stats): before the model (verify) or after it (settle). The code is the only label.
        if (phase === "verify" || phase === "settle") {
          target.paymentFailurePhases ??= {};
          const p = target.paymentFailurePhases[phase] ??= {};
          p[code] = (p[code] || 0) + 1;
        }
      }
      this.changed();
    } catch {}
  }
  // Solana exact answers refused for running out of their window (solana-exact-window.mjs), by phase. Private only.
  recordWindowRefusal(phase) {
    try {
      if (!["unverified", "budget", "timeout", "late"].includes(phase)) return;
      for (const target of [this.state, this.bucket()]) {
        target.windowRefusals ??= {};
        target.windowRefusals[phase] = (target.windowRefusals[phase] || 0) + 1;
      }
      this.changed();
    } catch {}
  }
  recordChallenge({ route, method, challenge } = {}) {
    try {
      const kind = challenge ? method === "POST" ? "post" : ["GET", "HEAD"].includes(method) ? "probe" : null : "refused";
      if (!kind) return;
      let key = this.isPaidRoute(route) && typeof route === "string" && /^\/[^\s]{0,200}$/.test(route) ? route : "other";
      const routes = this.state.c402.routes;
      // Reserve one slot for overflow, keeping the complete dictionary bounded at 100.
      if (!Object.hasOwn(routes, key) && Object.keys(routes).filter(k => k !== "other").length >= ROUTE_CAP - 1) key = "other";
      for (const target of [this.state.c402, this.bucket().c402]) {
        target[kind]++;
        const boundedKey = !Object.hasOwn(target.routes, key)
          && Object.keys(target.routes).filter(k => k !== "other").length >= ROUTE_CAP - 1 ? "other" : key;
        target.routes[boundedKey] = (target.routes[boundedKey] || 0) + 1;
      }
      this.changed();
    } catch {}
  }
  recordModel(model, { ok, code, status, retried } = {}) {
    try {
      if (typeof model !== "string" || !/^[A-Za-z0-9._:/-]{1,80}$/.test(model)
        || (code !== "max_tokens_spent_reasoning" && !ok && [400, 413, 422].includes(status))) return;
      if (!Object.hasOwn(this.state.models, model) && Object.keys(this.state.models).length >= MODEL_CAP) return;
      const last = this.state.models[model] ??= { failed: false };
      const counts = this.bucket().models[model] ??= { ok: 0, fail: 0 };
      if (code === "max_tokens_spent_reasoning") {
        counts.r422 = (counts.r422 || 0) + 1; this.changed(); return;
      }
      if (ok && retried) counts.rt = (counts.rt || 0) + 1;
      last[ok ? "ok" : "fail"] = this.now(); last.failed = !ok;
      counts[ok ? "ok" : "fail"]++;
      if (!ok) {
        last.lastReason = failureReason(code);
        const reasons = counts.reasons ??= {};
        reasons[last.lastReason] = (reasons[last.lastReason] || 0) + 1;
      }
      this.changed();
    } catch {}
  }
  recordSettlement({ route, network, ok, amount, payer } = {}) {
    try {
      const n = networkName(network), b = this.bucket();
      const rail = b.networks[n] ??= { ok: 0, fail: 0 };
      rail[ok ? "ok" : "fail"]++;
      const last = this.state.networks[n] ??= {};
      last[ok ? "ok" : "fail"] = this.now(); last.failed = !ok;
      const targets = [this.state.totals[n] ??= empty(), b.totals[n] ??= empty()];
      if (!ok) for (const t of targets) t.fail++;
      else if (this.isPublicRoute(route)) {
        if (typeof payer === "string" && this.own.has(normalize(payer))) {
          for (const t of targets) t.own++;
        } else {
          for (const t of targets) {
            t.calls++;
            if ((typeof amount === "string" && /^\d+$/.test(amount))
              || (typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0)) {
              t.atomic = String(BigInt(t.atomic) + BigInt(amount));
            } else t.noAmount++;
          }
          if (typeof payer === "string" && payer.trim()) {
            const hash = createHmac("sha256", this.state.salt).update(normalize(payer)).digest("hex").slice(0, 16);
            for (const [s, cap] of [[this.state, PAYER_CAP], [b, BUCKET_PAYER_CAP]]) {
              if (!s.payers.includes(hash)) {
                if (s.payers.length >= cap) s.capped = true;
                else { s.payers.push(hash); if (s.payers.length >= cap) s.capped = true; }
              }
            }
          }
        }
      }
      this.changed();
    } catch {}
  }
  window(hours) {
    const cutoff = Math.floor(this.now() / HOUR) * HOUR - (hours - 1) * HOUR;
    return Object.entries(this.state.buckets).filter(([k]) => Date.parse(k) >= cutoff
      && Date.parse(k) <= this.now()).map(([, b]) => b);
  }
  models(hours = 24, unservable = new Map(), suspended = new Map()) {
    const counts = Object.create(null), now = this.now();
    const active = new Map([...unservable].filter(([, value]) => (value?.until ?? value) > now));
    for (const id of suspended.keys()) active.set(id, active.get(id) ?? 0);
    for (const b of this.window(hours)) for (const [id, c] of Object.entries(b.models ?? {})) {
      const t = counts[id] ??= { ok: 0, fail: 0, reasons: {} }; t.ok += c.ok; t.fail += c.fail;
      t.r422 = (t.r422 || 0) + (c.r422 || 0); t.rt = (t.rt || 0) + (c.rt || 0);
      // Old buckets have no reasons; their failures still count as other.
      for (const reason of REASONS) t.reasons[reason] = (t.reasons[reason] || 0) + (c.reasons?.[reason] || 0);
      t.reasons.other += c.fail - Object.values(c.reasons ?? {}).reduce((sum, n) => sum + n, 0);
    }
    for (const id of active.keys()) counts[id] ??= { ok: 0, fail: 0, reasons: {} };
    // Keep every unavailable model, even if their number exceeds the normal public cap.
    return Object.fromEntries(Object.entries(counts)
      .sort(([a, x], [b, y]) => Number(active.has(b)) - Number(active.has(a))
        || y.ok + y.fail - x.ok - x.fail || a.localeCompare(b))
      .filter(([id], i) => active.has(id) || i < 50)
      .map(([id, c]) => {
        const attempts = c.ok + c.fail, rate = attempts ? c.fail / attempts : 0;
        const last = this.state.models[id], gate = active.get(id), expiry = gate?.until ?? gate;
        return [id, { status: active.has(id) ? "unavailable" : attempts >= 5 && rate > 0.5 ? "down"
          : (c.r422 >= 3 && c.r422 / (attempts + c.r422) > 0.2) ? "degraded"
          : attempts < 5 ? "insufficient_data" : rate > 0.2 ? "degraded" : "up",
          ...(suspended.has(id) ? { suspended: true, consecutiveRejections: suspended.get(id).count } : {}),
          windowHours: hours, reasoning422: c.r422 || 0, reasoningRetries: c.rt || 0, attempts, successes: c.ok, failures: c.fail,
          errorRatePct: Math.round(rate * 1000) / 10,
          // As before, last* are the latest ever seen (not limited to the window); lastOutcome is the newest of the two.
          lastSuccessAt: minute(last?.ok), lastFailureAt: minute(last?.fail),
          lastOutcome: last && (Number.isFinite(last.ok) || Number.isFinite(last.fail)) ? (last.failed ? "failure" : "success") : null,
          sellerFailures: (c.reasons.no_healthy_sellers || 0) + (c.reasons.minimum_discount_not_met || 0),
          failureReasons: Object.fromEntries(Object.entries(c.reasons).filter(([, n]) => n > 0)),
          reason: gate?.reason ?? (Number.isFinite(last?.fail) ? last.lastReason ?? "other" : null),
          ...(expiry ? { unavailableUntil: new Date(expiry).toISOString(),
            retryAfterSeconds: Math.max(30, Math.ceil((expiry - now) / 1000)) } : {}) }];
      }));
  }
  rails(hours = 24) {
    const cutoff = Math.floor(this.now() / HOUR) * HOUR - (hours - 1) * HOUR;
    const recent = t => t >= cutoff && t <= this.now() ? minute(t) : null;
    return Object.fromEntries(["base", "solana"].map(n => {
      let settled = 0, failed = 0;
      for (const b of this.window(hours)) { settled += b.networks?.[n]?.ok || 0; failed += b.networks?.[n]?.fail || 0; }
      return [n, { settled, failed, lastSettledAt: recent(this.state.networks[n]?.ok),
        lastFailedAt: recent(this.state.networks[n]?.fail) }];
    }));
  }
  numbers() {
    const aggregate = totals => {
      const byNetwork = {}, sum = empty();
      for (const totalsByNetwork of totals) for (const [n, t] of Object.entries(totalsByNetwork ?? {})) {
        const dest = byNetwork[n] ??= empty();
        for (const d of [dest, sum]) for (const key of Object.keys(sum)) {
          d[key] = key === "atomic" ? String(BigInt(d[key]) + BigInt(t[key] || 0)) : d[key] + (t[key] || 0);
        }
      }
      return { ...sum, byNetwork };
    };
    const window = h => {
      const buckets = this.window(h);
      return { ...aggregate(buckets.map(b => b.totals)), unique: buckets.some(b => b.capped) ? null
        : new Set(buckets.flatMap(b => b.payers ?? [])).size };
    };
    return { since: this.state.since, total: { ...aggregate([this.state.totals]),
      unique: this.state.capped ? null : this.state.payers.length }, day: window(24), week: window(168) };
  }
}

export class FacilitatorCheck {
  constructor({ client, ttlMs = 300000, timeoutMs = 5000, now = Date.now } = {}) {
    Object.assign(this, { client, ttlMs, timeoutMs, now, result: null, inflight: false });
  }
  get() {
    if (typeof this.client?.getSupported !== "function") return null;
    if (!this.inflight && (!this.result || this.now() - Date.parse(this.result.checkedAt) >= this.ttlMs)) {
      this.inflight = true;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error()), this.timeoutMs); timer.unref();
      });
      Promise.race([Promise.resolve().then(() => this.client.getSupported()), timeout]).then(s => {
        const kinds = s?.kinds ?? [];
        this.result = { checkedAt: new Date(this.now()).toISOString(), reachable: true,
          networks: { base: kinds.some(k => networkName(k.network) === "base"),
            solana: kinds.some(k => networkName(k.network) === "solana") } };
      }, () => { this.result = { checkedAt: new Date(this.now()).toISOString(), reachable: false, networks: {} }; })
        .finally(() => { clearTimeout(timer); this.inflight = false; });
    }
    return this.result;
  }
}

export function healthBody(stats, check, model, unservable = new Map(), suspended = new Map()) {
  const models = stats.models(24, unservable, suspended);
  const models_summary = { up: 0, degraded: 0, down: 0, insufficient_data: 0, unavailable: 0 };
  for (const entry of Object.values(models)) models_summary[entry.status]++;
  const networks = Object.fromEntries(Object.entries(stats.rails()).map(([n, rail]) => {
    let status = "unknown", basis = "none";
    if (rail.settled + rail.failed) {
      status = outcomeStatus(rail.settled, rail.failed, stats.state.networks[n]?.failed); basis = "settlements";
    }
    if (check?.reachable && !check.networks[n]) { status = "down"; basis = "facilitator"; }
    else if (check?.reachable === false
      && (!Number.isFinite(stats.state.networks[n]?.ok)
        || Date.parse(check.checkedAt) > stats.state.networks[n].ok)) {
      if (!["down", "degraded"].includes(status)) { status = "degraded"; basis = "facilitator"; }
    } else if (status === "unknown" && check) {
      status = check.reachable ? "up" : "degraded"; basis = "facilitator";
    }
    return [n, { status, basis, ...rail }];
  }));
  const known = Object.values(networks).filter(n => n.status !== "unknown");
  const status = known.length && known.every(n => n.status === "down") ? "down"
    : known.some(n => ["down", "degraded"].includes(n.status))
      || ["down", "degraded", "unavailable"].includes(models[model]?.status) ? "degraded" : "ok";
  return { status, generatedAt: new Date(stats.now()).toISOString(), windowHours: 24, statsSince: stats.state.since,
    models, models_summary, payments: { facilitator: check, networks } };
}
export function numbersBody(stats) {
  const { since, total, day, week } = stats.numbers();
  const fields = key => ({ total: total[key], last_24h: day[key], last_7d: week[key] });
  const volume = a => Number(BigInt(a || 0)) / 1e6;
  const refusals = entries => Object.fromEntries(PAYMENT_ERROR_CODES.map(code =>
    [code, entries.reduce((sum, b) => sum + (b.paymentFailures?.[code] || 0), 0)]));
  const byNetwork = key => Object.fromEntries(["base", "solana"].map(n =>
    [n, key === "atomic" ? volume(total.byNetwork[n]?.atomic) : total.byNetwork[n]?.calls || 0]));
  // Published only with a non-empty own-payer list (only then is anything recorded); zero attempts is no rate.
  const configured = stats.own.size > 0, NETWORKS = ["base", "solana"];
  const paidWindow = (h, measure) => Object.fromEntries(NETWORKS.map(n => {
    const c = { attempts: 0, answered: 0, ms: [] };
    for (const b of stats.window(h)) {
      const p = b.paid?.[n];
      if (p) { c.attempts += p.attempts; c.answered += p.answered; c.ms.push(...p.ms); }
    }
    return [n, measure(c)];
  }));
  const paidWindows = (measure, unpublished) => Object.fromEntries([["last_24h", 24], ["last_7d", 168]].map(([k, h]) =>
    [k, configured ? paidWindow(h, measure) : Object.fromEntries(NETWORKS.map(n => [n, { ...unpublished, reason: "own_payers_not_configured" }]))]));
  // Nearest rank: the smallest sample with at least p% of samples at or below it.
  const rank = (sorted, p) => sorted[Math.ceil(p / 100 * sorted.length) - 1];
  const integrity = (entries, key) => entries.reduce((sum, b) => sum + Object.values(b[key] ?? {}).reduce((a, n) => a + n, 0), 0);
  const notMeasured = { p50: null, p95: null, reason: "not_measured" };
  return { schema: 1, agent_traffic: trafficNumbers(stats), generated_at: new Date(stats.now()).toISOString(), since,
    scope: "Settled payments on publicly listed x402 routes; own payers are excluded only once an own-payer list is configured (see counts_basis).",
    settlement_failures_by_code: { total: refusals([stats.state]), last_24h: refusals(stats.window(24)), last_7d: refusals(stats.window(168)) },
    paid_calls: { ...fields("calls"), by_network: byNetwork("calls") },
    usdc_volume: { unit: "USDC", total: volume(total.atomic), last_24h: volume(day.atomic),
      last_7d: volume(week.atomic), by_network: byNetwork("atomic"), calls_without_amount: total.noAmount },
    unique_payers: fields("unique"), own_payers_configured: stats.own.size > 0,
    counts_basis: stats.own.size === 0 ? "including_own_payments" : "excluding_configured_own_payers",
    counts_label: stats.own.size === 0
      ? "Includes our own payments: no own-payer list is configured yet, so these counts are not external-only."
      : "Excludes configured own payers from now on; calls and volume recorded before the list was configured still include our own payments.",
    own_payments_excluded: total.own,
    settlement_failures: { last_24h: day.fail, last_7d: week.fail },
    paid_call_success: paidWindows(c => c.attempts >= MIN_SAMPLES
      ? { attempts: c.attempts, answered: c.answered, success_pct: Math.round(c.answered / c.attempts * 1000) / 10, reason: null }
      : { attempts: c.attempts, answered: c.answered, success_pct: null, reason: "insufficient_data" },
    { attempts: null, answered: null, success_pct: null }),
    paid_answer_latency_ms: paidWindows(c => {
      const sorted = c.ms.sort((a, b) => a - b);
      return sorted.length >= MIN_SAMPLES ? { samples: sorted.length, p50: rank(sorted, 50), p95: rank(sorted, 95), reason: null }
        : { samples: sorted.length, p50: null, p95: null, reason: "insufficient_data" };
    }, { samples: null, p50: null, p95: null }),
    payment_overhead_ms: notMeasured, e2e_ms: notMeasured,
    charge_without_answer: { since: stats.state.cwaSince, total: integrity([stats.state], "cwa"), last_24h: integrity(stats.window(24), "cwa"),
      last_7d: integrity(stats.window(168), "cwa"), by_network: Object.fromEntries(NETWORKS.map(n => [n, stats.state.cwa?.[n] || 0])) },
    settlement_unknown: { since: stats.state.suSince, total: integrity([stats.state], "su"), last_24h: integrity(stats.window(24), "su"),
      last_7d: integrity(stats.window(168), "su"), by_network: Object.fromEntries(NETWORKS.map(n => [n, stats.state.su?.[n] || 0])) },
    definitions: {
      schema: "Version of this response format.", generated_at: "Time this response was generated.",
      scope: "Only settled payments on publicly listed x402 routes count; internal web-app routes are excluded; own payers are excluded only once an own-payer list is configured (see counts_basis).",
      since: "Measured only since the counters started; history before the counters existed is not included.",
      paid_calls: "Successful public settlements, counted once per settlement; own payers are excluded only once an own-payer list is configured (see counts_basis).",
      total: "Lifetime observations since the counters started, not historical service totals.",
      last_24h: "Observations in the current UTC hour and the preceding 23 UTC hourly buckets.",
      last_7d: "Observations in the current UTC hour and the preceding 167 UTC hourly buckets.",
      by_network: "Lifetime public observations split by Base and Solana; other networks remain in the total.",
      usdc_volume: "Known settled atomic USDC amounts divided by one million; own payers are excluded only once an own-payer list is configured (see counts_basis).",
      calls_without_amount: "Settlements with unavailable actual amounts count without estimated volume.",
      unique_payers: "Distinct payer wallets counted by salted hash without exposing them; "
        + "null means a cap prevents measurement; own payers are excluded only once an own-payer list is configured (see counts_basis).",
      counts_basis: "Whether counts include our own payments or exclude configured own payers from configuration onward.",
      counts_label: "Human-readable coverage, including the limits of historical own-payment exclusion.",
      own_payers_configured: "True when the own-payer list is non-empty. Adding it removes historical own unique hashes; earlier calls and volume cannot be corrected because payer-level payment history is not stored.",
      own_payments_excluded: "Configured own-payer settlements excluded from calls, volume and unique payers.",
      agent_traffic: "Served paid and free chat/Messages/Responses answers, including own clients; total and UTC hourly windows count tools, streams, images and fixed client product labels without raw headers or prompts.",

      settlement_failures_by_code: "Refused payments, verification or settlement, with a code, across all routes with the hooks; does not replace settlement_failures.",
      settlement_failures: "Failed facilitator settlements across all routes during each window.",
      paid_call_success: "Per network and window: attempts are paid chat requests whose payment passed verification and reached the answer handler; answered are those that returned HTTP 200 with an answer and then settled; success_pct = answered / attempts, to one decimal. "
        + `Recorded only for payers known not to be ours, and only while an own-payer list is configured: otherwise values are null with reason own_payers_not_configured. A window with fewer than ${MIN_SAMPLES} attempts is null with reason insufficient_data, with raw counts visible, never a guessed rate. Measured only since this counter started; not backfilled from settlements.`,
      paid_answer_latency_ms: "Milliseconds from the start of the paid answer handler (after payment verification) to the answer being ready, for answered calls in paid_call_success; nearest-rank p50 and p95 of up to 200 samples per network per UTC hour. "
        + `Not the client's 402-to-200 round trip and excludes verification and settlement. Same own-payer publication rule as paid_call_success; fewer than ${MIN_SAMPLES} samples in a window withholds p50/p95 with reason insufficient_data and keeps samples visible.`,
      payment_overhead_ms: "Time added by the 402 challenge and payment; not measured, so null with reason not_measured.",
      e2e_ms: "Verification, answer and settlement end to end; not measured, so null with reason not_measured.",
      charge_without_answer: "Successful settlements observed where the response was not 2xx, or where the paid chat handler had not marked an answer as sent; any payer, including ours. Should stay 0. "
        + "Counted only since `since` in this field, when this counter started; it says nothing about earlier payments. by_network is since then.",
      settlement_unknown: "Timeout or other indeterminate facilitator settle result (FacilitatorTimeoutError or equivalent); not counted as success, settlement failure, or charge_without_answer because it cannot be said whether anything moved on chain. Any payer; counted only since `since` in this field.",
      availability: "External availability is published separately at https://app.singitai.app/status.json."
    } };
}

export function privateStatsBody(stats) {
  const n = numbersBody(stats);
  const aggregate = entries => {
    const result = { post: 0, probe: 0, refused: 0, all: 0 }, routes = Object.create(null);
    for (const c of entries) {
      for (const k of ["post", "probe", "refused"]) result[k] += c?.[k] || 0;
      for (const [r, count] of Object.entries(c?.routes || {})) routes[r] = (routes[r] || 0) + count;
    }
    result.all = result.post + result.probe + result.refused;
    return { result, routes };
  };
  const total = aggregate([stats.state.c402]), day = aggregate(stats.window(24).map(b => b.c402)), week = aggregate(stats.window(168).map(b => b.c402));
  const fields = o => Object.fromEntries(["total", "last_24h", "last_7d"].map(k => [k, o[k]]));
  return { schema: 1, generated_at: n.generated_at, since: n.since,
    external_payers: { unique: n.unique_payers, paid_calls: fields(n.paid_calls), usdc: fields(n.usdc_volume) },
    own_payments_excluded: n.own_payments_excluded, own_payers_configured: n.own_payers_configured, counts_basis: n.counts_basis,
    payment_failures_by_phase: Object.fromEntries(["verify", "settle"].map(phase => {
      const sum = entries => Object.fromEntries(PAYMENT_ERROR_CODES.map(code =>
        [code, entries.reduce((n, b) => n + (b?.paymentFailurePhases?.[phase]?.[code] || 0), 0)]));
      return [phase, { total: sum([stats.state]), last_24h: sum(stats.window(24)), last_7d: sum(stats.window(168)) }];
    })),
    solana_exact_window_refusals: Object.fromEntries([["total", [stats.state]], ["last_24h", stats.window(24)], ["last_7d", stats.window(168)]]
      .map(([k, entries]) => [k, Object.fromEntries(["unverified", "budget", "timeout", "late"].map(p =>
        [p, entries.reduce((n, b) => n + (b?.windowRefusals?.[p] || 0), 0)]))])),
    issued_402: { total: total.result, last_24h: day.result, last_7d: week.result,
      by_route: { total: total.routes, last_24h: day.routes, last_7d: week.routes } },
    note: "402s count responses, not unique clients. post = POST challenge; probe = GET/HEAD discovery; refused = 402 without PAYMENT-REQUIRED. Windows use UTC hourly buckets. Own unique hashes are removed retroactively; calls and volume before configuration still include own payments." };
}

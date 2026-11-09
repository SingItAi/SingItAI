// Independent reads keep a failed counter endpoint from hiding measured rail or model health.
export const HEALTH_URL = "https://ask.singitai.app/health";
export const AVAILABILITY_URL = "https://app.singitai.app/status.json";
export const NUMBERS_URL = "https://ask.singitai.app/numbers.json";
export function statusLabel(value) {
  const labels = { ok: "OK", up: "Up", degraded: "Degraded", down: "Down",
    insufficient_data: "Not enough data", unavailable: "Unavailable", unknown: "Unknown" };
  return typeof value === "string" && Object.hasOwn(labels, value) ? labels[value] : "Unknown";
}
export function modelRows(health) {
  if (!health?.models || typeof health.models !== "object") throw new Error("Could not load model status.");
  return Object.entries(health.models).map(([id, entry]) => {
    const m = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    let label = statusLabel(m.status);
    const details = [];
    if (m.status === "unavailable") {
      if (Number.isFinite(m.retryAfterSeconds)) details.push(`retry in ${m.retryAfterSeconds} s`);
      if (typeof m.unavailableUntil === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(m.unavailableUntil) &&
          Number.isFinite(Date.parse(m.unavailableUntil))) details.push(`until ${m.unavailableUntil}`);
    } else if (m.status === "insufficient_data" && Number.isInteger(m.attempts)) {
      details.push(`${m.attempts} attempts, 5 needed`);
    } else if (m.status === "degraded" || m.status === "down") {
      if (m.reason === "no_healthy_sellers") details.push("no healthy sellers");
      if (m.reason === "minimum_discount_not_met") details.push("minimum discount not met");
    }
    if (details.length) label += ` (${details.join(", ")})`;
    return [id, label, Number.isFinite(m.successes) ? m.successes : "Not available",
      Number.isFinite(m.failures) ? m.failures : "Not available",
      Number.isFinite(m.errorRatePct) ? `${m.errorRatePct}%` : "Not available",
      typeof m.lastSuccessAt === "string" ? m.lastSuccessAt : "No success recorded"];
  });
}
export function summaryText(health) {
  const s = health?.models_summary;
  const keys = ["up", "degraded", "down", "insufficient_data", "unavailable"];
  if (!s || typeof s !== "object" || Array.isArray(s) ||
      !keys.every(k => Number.isInteger(s[k]) && s[k] >= 0)) return "";
  return `Models: ${keys.map(k => `${s[k]} ${statusLabel(k).toLowerCase()}`).join(", ")}.`;
}
export function railRows(health) {
  if (!health?.payments?.networks) throw new Error("Could not load payment status.");
  return ["base", "solana"].map(n => {
    const r = health.payments.networks[n];
    return [n === "base" ? "Base" : "Solana", statusLabel(r.status), r.basis, r.settled, r.failed,
      r.lastSettledAt ?? "No settlement recorded"];
  });
}
export function numberRows(numbers) {
  if (numbers?.schema !== 1 || !numbers.paid_calls || !numbers.usdc_volume || !numbers.unique_payers)
    throw new Error("Could not load measured numbers.");
  return [["Paid calls", numbers.paid_calls], ["USDC volume", numbers.usdc_volume],
    ["Unique payer wallets", numbers.unique_payers]].map(([label, values]) =>
    [label, ...["total", "last_24h", "last_7d"].map(k => values[k] ?? "Not measurable")]);
}
// Per-network paid-call measurements; a withheld value shows why, never a guessed number.
const NOT_PUBLISHED = {
  own_payers_not_configured: "Not published: own-payer list is not configured, so this would include our own payments.",
  insufficient_data: "Not enough data", not_measured: "Not measured" };
const published = (entry, value) => entry && typeof entry === "object" && entry.reason == null && Number.isFinite(value);
const withheld = (entry, key) => typeof entry?.reason === "string" && Object.hasOwn(NOT_PUBLISHED, entry.reason)
  ? NOT_PUBLISHED[entry.reason] + (entry.reason === "insufficient_data" && Number.isInteger(entry[key])
    ? ` (${entry[key]} ${key})` : "") : "Not available";
export function paidCallRows(numbers) {
  const success = numbers?.paid_call_success, latency = numbers?.paid_answer_latency_ms, cwa = numbers?.charge_without_answer;
  if (!success || !latency || !cwa || !numbers.settlement_unknown) throw new Error("Could not load paid-call measurements.");
  const rows = [];
  for (const n of ["base", "solana"]) {
    const name = n === "base" ? "Base" : "Solana";
    rows.push([`${name} paid-call success`, ...["last_24h", "last_7d"].map(w => {
      const e = success[w]?.[n];
      return published(e, e?.success_pct) ? `${e.success_pct}% (${e.answered} of ${e.attempts})` : withheld(e, "attempts");
    })]);
    rows.push([`${name} answer latency p50 / p95`, ...["last_24h", "last_7d"].map(w => {
      const e = latency[w]?.[n];
      return published(e, e?.p50) && Number.isFinite(e.p95) ? `${e.p50} ms / ${e.p95} ms (${e.samples} samples)` : withheld(e, "samples");
    })]);
  }
  rows.push(["Charge without answer", ...[cwa.last_24h, cwa.last_7d].map(v => Number.isInteger(v) ? v : "Not available")]);
  rows.push(["Settlement unknown", ...[numbers.settlement_unknown.last_24h, numbers.settlement_unknown.last_7d]
    .map(v => Number.isInteger(v) ? v : "Not available")]);
  return rows;
}
export function chargeWithoutAnswerText(numbers) {
  const cwa = numbers?.charge_without_answer;
  return Number.isInteger(cwa?.total) && typeof cwa.since === "string"
    ? `Charges without an answer since this counter started at ${cwa.since}: ${cwa.total}. Earlier payments are not covered.`
    : "Charges without an answer: not available.";
}
export function settlementUnknownText(numbers) {
  const su = numbers?.settlement_unknown;
  return Number.isInteger(su?.total) && typeof su.since === "string"
    ? `Unknown settlements since this counter started at ${su.since}: ${su.total}. Earlier payments are not covered.`
    : "Unknown settlements: not available.";
}
export function countsLabel(numbers) {
  return typeof numbers?.counts_label === "string" ? numbers.counts_label : "These counts may include our own payments.";
}
// A state is one spanning cell, rendered through the same safe table helper as data.
export function tableRows(rows, columns, message) {
  return rows.length ? rows.map(row => row.map(value => ({ text: String(value), colspan: 1 })))
    : [[{ text: message, colspan: columns }]];
}
export function availabilityRows(json) {
  if (!Array.isArray(json?.endpoints)) throw new Error("Could not load availability.");
  return json.endpoints.filter(e => typeof e.name === "string" &&
    (e.name.startsWith("ask-") || e.name === "app-health")).map(e =>
    [e.name, statusLabel(e.status), ...["24h", "7d", "30d"].map(key => {
      const window = e.windows?.[key];
      const value = window?.availability_pct;
      return (value == null ? "Not available" : `${value}%`) +
        (window?.covered === false ? " (history does not yet cover this window)" : "");
    })]);
}
export async function loadJson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Could not load this measurement.");
  return response.json();
}
if (typeof document !== "undefined") {
  const text = (id, value) => { document.getElementById(id).textContent = value; };
  const states = {
    models: [6, "No model answers recorded in the last 24 hours."],
    rails: [6, "No payment status recorded."], numbers: [4, "No measured numbers recorded."],
    definitions: [2, "No definitions available."], paid: [3, "No paid-call measurements."], availability: [5, "No availability recorded."]
  };
  const table = (id, rows, message = states[id][1]) => {
    const body = document.getElementById(id); body.replaceChildren();
    for (const row of tableRows(rows, states[id][0], message)) {
      const tr = document.createElement("tr");
      for (const value of row) {
        const td = document.createElement("td"); td.textContent = value.text; td.colSpan = value.colspan; tr.append(td);
      }
      body.append(tr);
    }
  };
  async function refresh() {
    await Promise.allSettled([
      loadJson(HEALTH_URL).then(h => {
        const models = modelRows(h), rails = railRows(h);
        table("models", models); table("rails", rails);
        const summary = summaryText(h);
        text("overall", `Overall: ${statusLabel(h.status)}. Generated ${h.generatedAt}.${summary ? ` ${summary}` : ""}`);
      }).catch(() => {
        text("overall", "Could not load service status.");
        table("models", [], "Could not load model status."); table("rails", [], "Could not load payment status.");
      }),
      loadJson(AVAILABILITY_URL).then(a => table("availability", availabilityRows(a)))
        .catch(() => table("availability", [], "Could not load availability.")),
      loadJson(NUMBERS_URL).then(n => {
        table("numbers", numberRows(n));
        try { table("paid", paidCallRows(n)); } catch { table("paid", [], "Could not load paid-call measurements."); }
        text("cwa-total", chargeWithoutAnswerText(n));
        text("su-total", settlementUnknownText(n));
        text("counts-label", countsLabel(n));
        text("since", `Measured since ${n.since}. History before the counters existed is not included.`);
        const rows = Object.entries(n.definitions).map(([k, v]) => [k, v]);
        rows.unshift(["Counts basis", n.counts_basis ?? "Not available"],
          ["Own payments excluded", n.own_payments_excluded],
          ["Calls without amount", n.usdc_volume.calls_without_amount],
          ["Settlement failures (24h / 7d)", `${n.settlement_failures.last_24h} / ${n.settlement_failures.last_7d}`]);
        for (const network of ["base", "solana"]) rows.push([`${network} calls / USDC`,
          `${n.paid_calls.by_network[network]} / ${n.usdc_volume.by_network[network]}`]);
        table("definitions", rows);
      }).catch(() => {
        text("counts-label", countsLabel(null));
        text("since", "Could not load measured numbers."); table("numbers", [], "Could not load measured numbers.");
        table("definitions", [], "Could not load definitions.");
        table("paid", [], "Could not load paid-call measurements."); text("cwa-total", chargeWithoutAnswerText(null));
        text("su-total", settlementUnknownText(null));
      })
    ]);
  }
  refresh(); setInterval(refresh, 60000);
}

// Independent reads keep a failed counter endpoint from hiding measured rail or model health.
export const HEALTH_URL = "https://ask.singitai.app/health";
export const AVAILABILITY_URL = "https://app.singitai.app/status.json";
export const NUMBERS_URL = "https://ask.singitai.app/numbers.json";
export function statusLabel(value) {
  return ({ ok: "OK", up: "Up", degraded: "Degraded", down: "Down", unknown: "Unknown" })[value] ?? "Unknown";
}
export function modelRows(health) {
  if (!health || typeof health.models !== "object") throw new Error("Could not load model status.");
  return Object.entries(health.models).map(([id, m]) => [id, statusLabel(m.status), m.successes,
    m.failures, `${m.errorRatePct}%`, m.lastSuccessAt ?? "No success recorded"]);
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
    definitions: [2, "No definitions available."], availability: [5, "No availability recorded."]
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
        text("overall", `Overall: ${statusLabel(h.status)}. Generated ${h.generatedAt}.`);
      }).catch(() => {
        text("overall", "Could not load service status.");
        table("models", [], "Could not load model status."); table("rails", [], "Could not load payment status.");
      }),
      loadJson(AVAILABILITY_URL).then(a => table("availability", availabilityRows(a)))
        .catch(() => table("availability", [], "Could not load availability.")),
      loadJson(NUMBERS_URL).then(n => {
        table("numbers", numberRows(n));
        text("since", `Measured since ${n.since}. History before the counters existed is not included.`);
        const rows = Object.entries(n.definitions).map(([k, v]) => [k, v]);
        rows.unshift(["Own payments excluded", n.own_payments_excluded],
          ["Calls without amount", n.usdc_volume.calls_without_amount],
          ["Settlement failures (24h / 7d)", `${n.settlement_failures.last_24h} / ${n.settlement_failures.last_7d}`]);
        for (const network of ["base", "solana"]) rows.push([`${network} calls / USDC`,
          `${n.paid_calls.by_network[network]} / ${n.usdc_volume.by_network[network]}`]);
        table("definitions", rows);
      }).catch(() => {
        text("since", "Could not load measured numbers."); table("numbers", [], "Could not load measured numbers.");
        table("definitions", [], "Could not load definitions.");
      })
    ]);
  }
  refresh(); setInterval(refresh, 60000);
}

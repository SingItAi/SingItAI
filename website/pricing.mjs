// SingIt reference prices: pure row and formatting helpers, with browser-only page wiring below.
// Every price comes from our live GET /pricing.json.
export const SINGIT_PRICING_URL = "https://ask.singitai.app/pricing.json";

export function validPricing(pricingJson) {
  return !!pricingJson && Array.isArray(pricingJson.models) && !!pricingJson.referenceRequest
    && Number.isFinite(pricingJson.referenceRequest.inputTokens) && Number.isFinite(pricingJson.referenceRequest.maxOutputTokens);
}

// The pricing endpoint has no provider field. Keep every model and sort by id.
export function pricingRows(pricingJson) {
  return pricingJson.models.map((m) => ({
    id: m.id, name: m.name || m.id,
    singitUptoUsd: m.upto?.base?.usd, singitExactUsd: m.exact?.base?.usd,
    recommendedScheme: m.recommendedScheme,
  })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// A per-request USD amount, honest at sub-cent sizes: trailing zeros trimmed, never rounded to "$0".
export function formatUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "−" : "";
  const fixed = Math.abs(n).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return `${sign}$${fixed || "0"}`;
}

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function rowHtml(row) {
  return `<tr>
    <th scope="row"><span class="model-name">${escape(row.name)}</span><span class="model-id">${escape(row.id)}</span></th>
    <td class="num">${formatUsd(row.singitUptoUsd)}</td>
    <td class="num hide-sm">${formatUsd(row.singitExactUsd)}${row.recommendedScheme === "upto" ? ' <span class="fine">sign upto</span>' : ""}</td>
  </tr>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Page wiring (browser only)

async function loadJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function renderTable(root, pricingJson) {
  const tbody = root.querySelector("[data-pricing-rows]");
  const rows = pricingRows(pricingJson);
  tbody.innerHTML = rows.length ? rows.map(rowHtml).join("")
    : '<tr><td colspan="3" class="table-state">No models are listed right now.</td></tr>';
  const reference = `${pricingJson.referenceRequest.messages} message, ${pricingJson.referenceRequest.inputTokens} `
    + `input tokens, up to ${pricingJson.referenceRequest.maxOutputTokens} output tokens`;
  root.querySelectorAll("[data-reference-request]").forEach((el) => { el.textContent = reference; });
  root.querySelectorAll("[data-generated-at]").forEach((el) => { el.textContent = pricingJson.generatedAt; });
}

export function init(doc = document) {
  const page = doc.querySelector("[data-pricing-page]");
  if (!page) return;
  loadJson(SINGIT_PRICING_URL)
    .then((pricingJson) => {
      if (!validPricing(pricingJson)) throw new Error("unusable pricing data");
      renderTable(page, pricingJson);
    })
    .catch(() => {
      doc.querySelectorAll("[data-pricing-table]").forEach((el) => { el.hidden = true; });
      doc.querySelectorAll("[data-live-fallback]").forEach((el) => { el.hidden = false; });
    });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => init());
  else init();
}

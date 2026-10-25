// SingIt vs BlockRun (website/pricing/): pure matching and price math, so website/tests/pricing.test.mjs can
// check them with fixtures; the page wiring at the bottom runs only in a browser. Every number on the page
// comes from SingIt's live GET /pricing.json (ask.singitai.app) and the committed BlockRun snapshot
// (website/data/blockrun-prices.json, scripts/blockrun-prices-snapshot.mjs) — never typed in here.

export const SINGIT_PRICING_URL = "https://ask.singitai.app/pricing.json";
export const BLOCKRUN_SNAPSHOT_URL = "/data/blockrun-prices.json";

// BlockRun lists models as "<provider>/<id>" (e.g. "anthropic/claude-opus-5.5"); SingIt's own catalogue uses
// the bare id. Rows are matched on that bare id.
export function providerOf(blockrunId) {
  const i = String(blockrunId).indexOf("/");
  return i === -1 ? String(blockrunId) : String(blockrunId).slice(0, i);
}
export function bareId(blockrunId) {
  const i = String(blockrunId).lastIndexOf("/");
  return i === -1 ? String(blockrunId) : String(blockrunId).slice(i + 1);
}

export function validSnapshot(snapshot) {
  return !!snapshot && typeof snapshot.source === "string" && typeof snapshot.fetchedAt === "string"
    && typeof snapshot.transactionFeeUsd === "number" && Array.isArray(snapshot.models)
    && snapshot.models.every((m) => m && typeof m.id === "string"
      && Number.isFinite(m.inputUsdPerMillion) && Number.isFinite(m.outputUsdPerMillion));
}

export function validPricing(pricingJson) {
  return !!pricingJson && Array.isArray(pricingJson.models) && !!pricingJson.referenceRequest
    && Number.isFinite(pricingJson.referenceRequest.inputTokens) && Number.isFinite(pricingJson.referenceRequest.maxOutputTokens);
}

// BlockRun bills a paid chat answer at provider cost for the reference request's own token counts, plus its
// flat per-request fee (snapshot.transactionFeeUsd): "chat is at provider cost + a flat fee" (their docs).
export function blockrunPrice(model, referenceRequest, transactionFeeUsd) {
  return model.inputUsdPerMillion * referenceRequest.inputTokens / 1e6
    + model.outputUsdPerMillion * referenceRequest.maxOutputTokens / 1e6 + transactionFeeUsd;
}

// Only models both sides list right now, matched by BlockRun's id suffix after "/" against SingIt's bare
// model id; sorted by BlockRun's provider prefix, then by id within it.
export function matchModels(pricingJson, snapshot) {
  const referenceRequest = pricingJson.referenceRequest;
  const byId = new Map((pricingJson.models ?? []).map((m) => [m.id, m]));
  const rows = [];
  for (const bm of snapshot.models) {
    const id = bareId(bm.id);
    const sm = byId.get(id);
    if (!sm) continue;
    const blockrunUsd = blockrunPrice(bm, referenceRequest, snapshot.transactionFeeUsd);
    rows.push({
      id, name: sm.name || bm.name || id, provider: providerOf(bm.id),
      singitUptoUsd: sm.upto.base.usd, singitExactUsd: sm.exact.base.usd,
      blockrunUsd, differenceUsd: blockrunUsd - sm.upto.base.usd,
    });
  }
  return rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
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
  const saving = row.differenceUsd > 0;
  return `<tr>
    <th scope="row"><span class="model-name">${escape(row.name)}</span><span class="model-id">${escape(row.id)}</span></th>
    <td class="hide-sm">${escape(row.provider)}</td>
    <td class="num">${formatUsd(row.singitUptoUsd)}</td>
    <td class="num hide-sm">${formatUsd(row.singitExactUsd)}</td>
    <td class="num">${formatUsd(row.blockrunUsd)}</td>
    <td class="num">${saving ? `<span class="saving">&minus;${formatUsd(row.differenceUsd).replace("$", "")} vs BlockRun</span>` : formatUsd(row.differenceUsd)}</td>
  </tr>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Page wiring (browser only)

async function loadJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function renderTable(root, pricingJson, snapshot) {
  const tbody = root.querySelector("[data-pricing-rows]");
  const rows = matchModels(pricingJson, snapshot);
  tbody.innerHTML = rows.length ? rows.map(rowHtml).join("")
    : '<tr><td colspan="5" class="table-state">No model is listed by both sides right now.</td></tr>';
  const reference = `${pricingJson.referenceRequest.messages} message, ${pricingJson.referenceRequest.inputTokens} `
    + `input tokens, up to ${pricingJson.referenceRequest.maxOutputTokens} output tokens`;
  root.querySelectorAll("[data-reference-request]").forEach((el) => { el.textContent = reference; });
  root.querySelectorAll("[data-generated-at]").forEach((el) => { el.textContent = pricingJson.generatedAt; });
  root.querySelectorAll("[data-snapshot-date]").forEach((el) => { el.textContent = snapshot.fetchedAt; });
  root.querySelectorAll("[data-snapshot-source]").forEach((el) => { el.textContent = snapshot.source; el.href = snapshot.source; });
}

export function init(doc = document) {
  const page = doc.querySelector("[data-pricing-page]");
  if (!page) return;
  Promise.all([loadJson(SINGIT_PRICING_URL), loadJson(BLOCKRUN_SNAPSHOT_URL)])
    .then(([pricingJson, snapshot]) => {
      if (!validPricing(pricingJson) || !validSnapshot(snapshot)) throw new Error("unusable pricing data");
      renderTable(page, pricingJson, snapshot);
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

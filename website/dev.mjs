// Developer pages: live prices from SingIt Ask, code tabs, copy buttons, the model table and the terminal demo.
// The helpers are exported for tests (website/tests/dev.test.mjs); the page wiring runs only in a browser.
// Without JavaScript every page is complete: all code panels show, the terminal shows its whole run, and the
// tables say where the live prices are.

const hasTokenPrice = (m) => ["input", "output"].every((key) => {
  const v = m.singitUsdPerMillionTokens?.[key];
  return Number.isFinite(v) && v >= 0 && (v > 0 || m.usdPerMillionTokens?.[key] === 0);
}) && ["input", "output"].some((key) => m.singitUsdPerMillionTokens?.[key] > 0);

export const MODELS_URL = "https://ask.singitai.app/v1/models";
export const POPULAR = ["claude-opus-5.5", "gpt-5.5", "claude-sonnet-5.5", "gemini-3.1-pro", "grok-4.1-fast", "deepseek-v4.1-flash"];

const PROVIDERS = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", "x-ai": "xAI", xai: "xAI",
  deepseek: "DeepSeek", qwen: "Qwen", alibaba: "Alibaba", meta: "Meta", "meta-llama": "Meta", mistral: "Mistral",
  mistralai: "Mistral", moonshot: "Moonshot", moonshotai: "Moonshot", minimax: "MiniMax", nvidia: "NVIDIA",
  cohere: "Cohere", zai: "Z.ai", "z-ai": "Z.ai", surplus: "Surplus" };

// A price per million tokens, short and honest: two decimals from a dollar up, more below a dollar.
export function formatUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.1) return `$${n.toFixed(3)}`;
  return `$${Number(n.toPrecision(2))}`;
}

export function providerLabel(owner) {
  const key = String(owner || "").toLowerCase();
  if (PROVIDERS[key]) return PROVIDERS[key];
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : "—";
}

// The models a buyer can choose, without the standing "singit-ask" entry.
export function choosable(list) {
  return (list?.data ?? []).filter((m) => m && m.id !== "singit-ask" && m.usdPerMillionTokens);
}

// The popular models that have a price to show, in the order given.
export function pickPopular(models, ids = POPULAR) {
  const byId = new Map(models.map((m) => [m.id, m]));
  return ids.map((id) => byId.get(id)).filter((m) => m && hasTokenPrice(m));
}

export function filterModels(models, { query = "", tag = "all", free = [] } = {}) {
  const q = query.trim().toLowerCase();
  return models.filter((m) => {
    if (tag === "free" && !free.includes(m.id)) return false;
    if (tag !== "all" && tag !== "free" && !(m.tags ?? []).includes(tag)) return false;
    if (!q) return true;
    return [m.id, m.name, m.owned_by, providerLabel(m.owned_by)].some((v) => String(v || "").toLowerCase().includes(q));
  });
}

// What a buyer pays per million output tokens: ours when known, else the list price.
export const outputPrice = (m) => hasTokenPrice(m) ? m.singitUsdPerMillionTokens.output : m.usdPerMillionTokens?.output ?? Infinity;

// "featured": the popular models first, then every model with a price of ours, then the rest; by name within each.
export function sortModels(models, key = "saving", dir = "descending") {
  if (key === "featured") {
    const rank = (m) => {
      if (!hasTokenPrice(m)) return POPULAR.length + 1;
      const i = POPULAR.indexOf(m.id);
      return i >= 0 ? i : POPULAR.length;
    };
    return [...models].sort((a, b) => rank(a) - rank(b)
      || String(a.name || a.id).toLowerCase().localeCompare(String(b.name || b.id).toLowerCase()));
  }
  const sign = dir === "ascending" ? 1 : -1;
  const value = {
    saving: (m) => hasTokenPrice(m) ? m.savingsVsListPct ?? -1 : -1,
    price: outputPrice,
    name: (m) => String(m.name || m.id).toLowerCase(),
  }[key] ?? ((m) => hasTokenPrice(m) ? m.savingsVsListPct ?? -1 : -1);
  return [...models].sort((a, b) => {
    const x = value(a), y = value(b);
    if (x === y) return String(a.id).localeCompare(String(b.id));
    return (x < y ? -1 : 1) * sign;
  });
}

// Tags that appear on at least one model, for the filter chips.
export function tagsOf(models) {
  const seen = new Set();
  for (const m of models) for (const t of m.tags ?? []) seen.add(t);
  return ["vision", "code", "reasoning", "private", "audio", "video"].filter((t) => seen.has(t));
}

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// A saving to show: never "100%", which would read as free; rounding 99.6% up says something untrue.
export const shownSaving = (pct) => (typeof pct === "number" && pct > 0 ? Math.min(pct, 99) : null);

// Whether the price comes from sellers' quotes rather than answers this service has paid for.
export const isEstimate = (m) => m.expectedUsdPerMillionTokens?.basis === "trusted";

export function rowHtml(m, { free = [] } = {}) {
  const ours = hasTokenPrice(m) ? m.singitUsdPerMillionTokens : null, list = m.usdPerMillionTokens;
  const saving = ours ? shownSaving(m.savingsVsListPct) : null;
  const est = isEstimate(m) ? ' <abbr class="est" title="From sellers\' quotes; not yet confirmed by answers we paid for">est.</abbr>' : "";
  const freeTag = free.includes(m.id) ? '<span class="tag-free">Free to try</span>' : "";
  return `<tr>
    <th scope="row"><span class="model-name">${escape(m.name || m.id)}${freeTag}</span><span class="model-id">${escape(m.id)}</span></th>
    <td class="hide-sm">${escape(providerLabel(m.owned_by))}</td>
    <td class="num hide-sm">${formatUsd(ours?.input)} <span class="list">${formatUsd(list?.input)}</span></td>
    <td class="num">${formatUsd(ours?.output)} <span class="list hide-sm">${formatUsd(list?.output)}</span></td>
    <td class="num">${saving ? `<span class="saving">&minus;${saving}%</span>${est}` : "—"}</td>
  </tr>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Page wiring (browser only)

const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

let modelsPromise = null;
function loadModels() {
  modelsPromise ??= fetch(MODELS_URL, { headers: { Accept: "application/json" } })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
  return modelsPromise;
}

function initCopy(root) {
  root.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = document.getElementById(btn.dataset.copy);
      const text = target ? target.innerText.trim() : "";
      const label = btn.querySelector("[data-copy-label]");
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(target);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return;
      }
      btn.classList.add("copied");
      if (label) label.textContent = "Copied";
      setTimeout(() => { btn.classList.remove("copied"); if (label) label.textContent = "Copy"; }, 1400);
    });
  });
}

function initTabs(root) {
  root.querySelectorAll("[data-tabs]").forEach((list) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const panels = tabs.map((t) => document.getElementById(t.getAttribute("aria-controls")));
    const pill = list.querySelector(".tab-pill");
    list.classList.add("js-tabs");
    const movePill = (tab) => {
      if (!pill) return;
      pill.style.left = `${tab.offsetLeft}px`;
      pill.style.width = `${tab.offsetWidth}px`;
    };
    const select = (i, focus = false) => {
      tabs.forEach((t, j) => {
        const on = i === j;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        panels[j].hidden = !on;
      });
      movePill(tabs[i]);
      if (focus) tabs[i].focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(i));
      t.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") { e.preventDefault(); select((i + 1) % tabs.length, true); }
        if (e.key === "ArrowLeft") { e.preventDefault(); select((i - 1 + tabs.length) % tabs.length, true); }
      });
    });
    select(0);
    addEventListener("resize", () => movePill(tabs.find((t) => t.getAttribute("aria-selected") === "true")));
  });
}

function initPriceCard(card, list) {
  const models = pickPopular(choosable(list)).slice(0, 4);
  if (!models.length) return;
  const chips = card.querySelector("[data-price-chips]");
  const show = (m) => {
    const listPrice = m.usdPerMillionTokens.output, ours = m.singitUsdPerMillionTokens.output;
    card.querySelector("[data-price-model]").textContent =
      `${m.name || m.id} · output, per 1M tokens${isEstimate(m) ? " · estimate from sellers' quotes" : ""}`;
    card.querySelector("[data-price-saving]").textContent = `−${shownSaving(m.savingsVsListPct) ?? 0}%`;
    card.querySelector("[data-price-list]").textContent = formatUsd(listPrice);
    card.querySelector("[data-price-ours]").textContent = formatUsd(ours);
    card.querySelector("[data-price-ours-bar]").style.width = `${Math.max(2, Math.min(100, (ours / listPrice) * 100))}%`;
    chips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.id === m.id)));
  };
  chips.innerHTML = "";
  models.forEach((m) => {
    const chip = document.createElement("button");
    chip.type = "button"; chip.className = "chip"; chip.dataset.id = m.id;
    chip.textContent = m.name || m.id;
    chip.addEventListener("click", () => show(m));
    chips.appendChild(chip);
  });
  show(models[0]);
  card.classList.remove("is-loading");
}

function initPopularTable(tbody, list) {
  const free = list.free?.models?.map((id) => id.replace(/^free\//, "")) ?? [];
  const rows = pickPopular(choosable(list));
  if (rows.length) tbody.innerHTML = rows.map((m) => rowHtml(m, { free })).join("");
}

function initModelsPage(root, list) {
  const tbody = root.querySelector("[data-models-rows]");
  const search = root.querySelector("[data-models-search]");
  const chipBox = root.querySelector("[data-models-tags]");
  const count = root.querySelector("[data-models-count]");
  const free = list.free?.models?.map((id) => id.replace(/^free\//, "")) ?? [];
  const all = choosable(list);
  const state = { query: "", tag: "all", key: "featured", dir: "ascending" };
  root.querySelectorAll("[data-fee-base]").forEach((el) => { el.textContent = `$${list.fees?.perAnswerUsd?.["eip155:8453"] ?? 0.001}`; });
  root.querySelectorAll("[data-fee-solana]").forEach((el) => { el.textContent = `$${list.fees?.perAnswerUsd?.["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] ?? 0.002}`; });
  root.querySelectorAll("[data-markup]").forEach((el) => { el.textContent = `${list.fees?.markupPct ?? 30}%`; });

  const tags = ["all", ...(free.length ? ["free"] : []), ...tagsOf(all)];
  const label = { all: "All", free: "Free to try", vision: "Vision", code: "Code", reasoning: "Reasoning",
    private: "Private", audio: "Audio", video: "Video" };
  chipBox.innerHTML = "";
  tags.forEach((t) => {
    const chip = document.createElement("button");
    chip.type = "button"; chip.className = "chip"; chip.textContent = label[t] ?? t;
    chip.setAttribute("aria-pressed", String(t === state.tag));
    chip.addEventListener("click", () => {
      state.tag = t;
      chipBox.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
      render();
    });
    chipBox.appendChild(chip);
  });

  root.querySelectorAll("[data-sort]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.sort;
      state.dir = state.key === key ? (state.dir === "ascending" ? "descending" : "ascending")
        : (key === "saving" ? "descending" : "ascending");
      state.key = key;
      render();
    });
  });
  search.addEventListener("input", () => { state.query = search.value; render(); });

  function render() {
    const rows = sortModels(filterModels(all, { query: state.query, tag: state.tag, free }), state.key, state.dir);
    tbody.innerHTML = rows.length ? rows.map((m) => rowHtml(m, { free })).join("")
      : '<tr><td colspan="5" class="table-state">No model matches. Try another name or filter.</td></tr>';
    count.textContent = `${rows.length} of ${all.length} models`;
    root.querySelectorAll("th[data-sort-col]").forEach((th) => {
      th.setAttribute("aria-sort", th.dataset.sortCol === state.key ? state.dir : "none");
    });
  }
  render();
}

// The terminal replays its run when it scrolls into view: commands type at ~55ms a character with a caret,
// output lines rise in one after another (90ms stagger). Reduced motion keeps the finished run.
function initTerminal(term) {
  if (reduceMotion() || typeof IntersectionObserver === "undefined") return;
  const lines = [...term.querySelectorAll(".term-line")];
  const texts = lines.map((l) => l.textContent);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let played = false;
  const play = async () => {
    term.classList.add("is-playing");
    lines.forEach((l) => { if (l.classList.contains("cmd")) l.textContent = ""; l.classList.remove("in"); });
    for (const [i, line] of lines.entries()) {
      if (line.classList.contains("cmd")) {
        const caret = document.createElement("span");
        caret.className = "caret";
        line.appendChild(caret);
        for (const ch of texts[i]) { caret.before(ch); await wait(55); }
        await wait(350);
        caret.remove();
      } else {
        line.classList.add("in");
        await wait(line.classList.contains("gap") ? 300 : 90 + 260);
      }
    }
  };
  new IntersectionObserver((entries, obs) => {
    if (!played && entries.some((e) => e.isIntersecting)) { played = true; obs.disconnect(); play(); }
  }, { threshold: 0.4 }).observe(term);
}

export function init(doc = document) {
  initCopy(doc);
  initTabs(doc);
  doc.querySelectorAll("[data-term]").forEach(initTerminal);
  const card = doc.querySelector("[data-price-card]");
  const popular = doc.querySelector("[data-popular-rows]");
  const page = doc.querySelector("[data-models-page]");
  if (!card && !popular && !page) return;
  loadModels().then((list) => {
    doc.querySelectorAll("[data-model-count]").forEach((el) => { el.textContent = String(choosable(list).length); });
    if (card) initPriceCard(card, list);
    if (popular) initPopularTable(popular, list);
    if (page) initModelsPage(page, list);
  }).catch(() => {
    doc.querySelectorAll("[data-live-fallback]").forEach((el) => { el.hidden = false; });
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => init());
  else init();
}

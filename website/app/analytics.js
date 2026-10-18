// Cookieless client analytics: a thin wrapper over window.umami (self-hosted, loaded by a
// script tag that does not exist on this page yet — see docs/analytics.md). Everything here is
// a no-op when umami is absent or blocked; the app must work exactly the same either way.
//
// Also captures first-touch utm_* (or the referring host, when there is none) so it can be sent
// once with /auth/verify and tied to the account at sign-in — Umami's own report cannot see
// past the cross-subdomain hop from the landing page.

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
const STORAGE_KEY = "singit.utm";

function fromUrlOrReferrer() {
  const params = new URLSearchParams(location.search);
  const utm = {};
  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (value) utm[key] = value.slice(0, 100);
  }
  if (Object.keys(utm).length === 0) {
    try {
      const ref = document.referrer ? new URL(document.referrer).hostname : "";
      if (ref && ref !== location.hostname) utm.ref_host = ref.slice(0, 100);
    } catch { /* an unparsable referrer is just skipped */ }
  }
  return utm;
}

// Merely reading the `localStorage`/`sessionStorage` global can throw (Safari with all cookies
// blocked, a sandboxed iframe without storage access) — not just calling a method on it — so
// even resolving the global must be inside its own try. A blocked storage falls back to
// in-memory only for the life of this page load.
function safeStorage(getStorage) {
  try {
    return getStorage();
  } catch { return null; }
}

function readStorage(storage) {
  if (!storage) return null;
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
    return saved && typeof saved === "object" ? saved : null;
  } catch { return null; }
}

function writeStorage(storage, value) {
  if (!storage) return;
  try { storage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* private mode: in-memory only */ }
}

const sessionUtmStorage = safeStorage(() => sessionStorage);
const localUtmStorage = safeStorage(() => localStorage);

// Session touch: this visit's own utm, replacing the previous session's as soon as a new one
// arrives. First touch: the very first one ever seen on this browser, in localStorage, never
// overwritten once set.
const seenThisLoad = fromUrlOrReferrer();
if (Object.keys(seenThisLoad).length) writeStorage(sessionUtmStorage, seenThisLoad);
let memoryUtm = readStorage(sessionUtmStorage) || seenThisLoad;
if (!readStorage(localUtmStorage)) writeStorage(localUtmStorage, memoryUtm);

export function getUtm() {
  return readStorage(localUtmStorage) || memoryUtm || {};
}

export function track(name, props = {}) {
  try {
    window.umami?.track(name, props);
  } catch { /* a blocked or missing tracker must never break the page */ }
}

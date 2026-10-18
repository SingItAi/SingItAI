// website/app/analytics.js: first-touch UTM capture/persistence, and a track() that never
// throws. The module runs its capture at import time, so each scenario needs a fresh module
// instance (a cache-busting query string) with fresh global stubs in place before importing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const MODULE_URL = new URL("../app/analytics.js", import.meta.url).href;
let counter = 0;

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

// A plain assignment can't redefine a getter-only property from a previous test, so every
// (re)definition goes through defineProperty with configurable: true.
function setGlobalStorage(name, value) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function blockGlobalStorage(name) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    // Safari with all cookies/storage blocked, or a sandboxed iframe: merely resolving the
    // global throws, before any method on it is even called.
    get() { throw new Error("SecurityError: storage is blocked in this context"); },
  });
}

async function freshModule({ href = "https://app.singitai.app/app/", referrer = "", session, local, umami,
                             storageBlocked = false } = {}) {
  global.location = new URL(href);
  global.document = { referrer };
  let sessionStorage = null, localStorage = null;
  if (storageBlocked) {
    blockGlobalStorage("sessionStorage");
    blockGlobalStorage("localStorage");
  } else {
    sessionStorage = makeStorage(session);
    localStorage = makeStorage(local);
    setGlobalStorage("sessionStorage", sessionStorage);
    setGlobalStorage("localStorage", localStorage);
  }
  global.window = umami === undefined ? {} : { umami };
  counter += 1;
  const mod = await import(`${MODULE_URL}?case=${counter}`);
  return { mod, sessionStorage, localStorage };
}

test("captures utm_* from the URL and persists it to both storages", async () => {
  const { mod, sessionStorage, localStorage } = await freshModule({
    href: "https://app.singitai.app/app/?utm_source=x&utm_medium=social",
  });
  assert.deepEqual(mod.getUtm(), { utm_source: "x", utm_medium: "social" });
  assert.deepEqual(JSON.parse(sessionStorage.getItem("singit.utm")), { utm_source: "x", utm_medium: "social" });
  assert.deepEqual(JSON.parse(localStorage.getItem("singit.utm")), { utm_source: "x", utm_medium: "social" });
});

test("falls back to the referring host when there is no utm param", async () => {
  const { mod } = await freshModule({
    href: "https://app.singitai.app/app/",
    referrer: "https://x.com/some/post",
  });
  assert.deepEqual(mod.getUtm(), { ref_host: "x.com" });
});

test("a same-host referrer is not treated as attribution", async () => {
  const { mod } = await freshModule({
    href: "https://app.singitai.app/app/",
    referrer: "https://app.singitai.app/app/settings",
  });
  assert.deepEqual(mod.getUtm(), {});
});

test("first touch in localStorage is never overwritten by a later visit", async () => {
  const { mod } = await freshModule({
    href: "https://app.singitai.app/app/?utm_source=second",
    local: { "singit.utm": JSON.stringify({ utm_source: "first" }) },
  });
  assert.deepEqual(mod.getUtm(), { utm_source: "first" });
});

test("utm values are truncated to 100 characters", async () => {
  const long = "a".repeat(500);
  const { mod } = await freshModule({ href: `https://app.singitai.app/app/?utm_campaign=${long}` });
  assert.equal(mod.getUtm().utm_campaign.length, 100);
});

test("track() calls window.umami.track when present", async () => {
  const calls = [];
  const { mod } = await freshModule({ umami: { track: (...args) => calls.push(args) } });
  mod.track("app_open", { standalone: false });
  assert.deepEqual(calls, [["app_open", { standalone: false }]]);
});

test("track() never throws when umami is absent", async () => {
  const { mod } = await freshModule({});
  assert.doesNotThrow(() => mod.track("app_open", {}));
});

test("track() never throws when umami.track itself throws", async () => {
  const { mod } = await freshModule({ umami: { track: () => { throw new Error("blocked"); } } });
  assert.doesNotThrow(() => mod.track("app_open", {}));
});

test("the module still imports when merely accessing the storage globals throws", async () => {
  const { mod } = await freshModule({
    href: "https://app.singitai.app/app/?utm_source=x",
    storageBlocked: true,
  });
  assert.deepEqual(mod.getUtm(), { utm_source: "x" });
  assert.equal(mod.track("app_open", {}), undefined);
});

// website/app.js (the landing script) rewrites "open the app" CTAs with the visitor's
// first-touch attribution. Nothing exports it, so it runs once per scenario in a vm with
// a minimal document/location fake; reduced-motion makes it exit before any GSAP code.
const LANDING_SOURCE = readFileSync(new URL("../app.js", import.meta.url), "utf8");

function runLandingApp({ search = "", hostname = "singitai.app", referrer = "", anchors = [] } = {}) {
  const context = vm.createContext({
    URL,
    URLSearchParams,
    location: { search, hostname },
    document: {
      referrer,
      querySelector: () => null,
      querySelectorAll: (selector) => (selector.includes("app.singitai.app") ? anchors : []),
    },
    window: { matchMedia: () => ({ matches: true }) },
  });
  vm.runInContext(LANDING_SOURCE, context);
  return context;
}

function ctaAnchor(href) {
  return { href, addEventListener() {}, closest: () => null };
}

const INTERNAL_CTA =
  "https://app.singitai.app/app/?utm_source=singitai&utm_medium=landing&utm_campaign=x402-llm-api&utm_content=hero";

test("landing CTAs: partial external utm_* replaces every internal CTA utm key", () => {
  const anchor = ctaAnchor(INTERNAL_CTA);
  runLandingApp({ search: "?utm_source=twitter", anchors: [anchor] });
  const url = new URL(anchor.href);
  assert.equal(url.searchParams.get("utm_source"), "twitter");
  assert.equal(url.searchParams.get("utm_medium"), null);
  assert.equal(url.searchParams.get("utm_campaign"), null);
  assert.equal(url.searchParams.get("utm_content"), null);
  assert.equal(url.searchParams.get("ref_host"), null);
});

test("landing CTAs: no external utm_* keeps the CTA's own tags and only adds ref_host", () => {
  const anchor = ctaAnchor(INTERNAL_CTA);
  runLandingApp({ referrer: "https://x.com/some/post", anchors: [anchor] });
  const url = new URL(anchor.href);
  assert.equal(url.searchParams.get("utm_source"), "singitai");
  assert.equal(url.searchParams.get("utm_medium"), "landing");
  assert.equal(url.searchParams.get("utm_campaign"), "x402-llm-api");
  assert.equal(url.searchParams.get("utm_content"), "hero");
  assert.equal(url.searchParams.get("ref_host"), "x.com");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../app/api.js", import.meta.url), "utf8").replaceAll("export ", "");

function tabs() {
  const storage = new Map();
  const make = () => {
    const listeners = new Map(), events = [], requests = [];
    const context = vm.createContext({ Event,
      window: { SINGIT_APP_CONFIG: { apiBase: "/web/v1" },
        addEventListener: (name, fn) => listeners.set(name, fn), dispatchEvent: event => events.push(event.type) },
      localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
      fetch: async (url, options) => { requests.push({ url, ...options }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    });
    vm.runInContext(source + "\nglobalThis.api = api;", context);
    return { context, events, requests, storageEvent: () => listeners.get("storage")({ key: "singit.session" }) };
  };
  return { make, storage };
}

test("another tab cannot silently replace the payer, even before the storage event arrives", async () => {
  const { make } = tabs();
  const a = make(); a.context.setCsrf("csrf-A", "wallet:A");
  const b = make(); b.context.setCsrf("csrf-B", "solana:B");
  await a.context.api.say("", "weather", "en");
  assert.equal(a.requests[0].headers["X-SingIt-CSRF"], "csrf-A");
  assert.equal(a.requests[0].headers["X-SingIt-Account"], "wallet:A");
  await a.context.api.allowance();
  assert.equal(a.requests[1].headers["X-SingIt-Account"], "wallet:A", "GET is bound too");
  a.storageEvent();
  assert.deepEqual(a.events, ["singit:session-changed"]);
  await assert.rejects(a.context.api.say("", "weather", "en"), /Sign in first/);
  assert.equal(a.requests.length, 2);
});

test("a stale logout does not erase the newer tab's stored session", () => {
  const { make, storage } = tabs();
  const a = make(); a.context.setCsrf("csrf-A", "wallet:A");
  const b = make(); b.context.setCsrf("csrf-B", "solana:B");
  a.context.setCsrf(null);
  assert.equal(JSON.parse(storage.get("singit.session")).account, "solana:B");
  assert.equal(b.context.csrf(), "csrf-B");
});

test("server mismatch invalidates the tab without retrying the payment", async () => {
  const { make } = tabs();
  const a = make(); a.context.setCsrf("csrf-A", "wallet:A");
  let calls = 0;
  a.context.fetch = async () => { calls++; return { ok: false, status: 409, json: async () => ({ error: "session_changed" }) }; };
  await assert.rejects(a.context.api.toolBuy("quote-A"), /changed in another tab/);
  assert.equal(calls, 1);
  assert.deepEqual(a.events, ["singit:session-changed"]);
});

test("late responses are discarded after the tab has changed session", async () => {
  const { make } = tabs();
  const a = make(); a.context.setCsrf("csrf-A", "wallet:A");
  let finish;
  a.context.fetch = () => new Promise(resolve => { finish = resolve; });
  const response = a.context.api.purchases();
  a.context.setCsrf("csrf-B", "solana:B");
  finish({ ok: true, status: 200, json: async () => ({ purchases: ["A's private history"] }) });
  await assert.rejects(response, /previous session/);
});

test("an expired session is removed before reloading, so restoration cannot loop", async () => {
  const { make, storage } = tabs();
  const a = make(); a.context.setCsrf("expired-A", "wallet:A");
  a.context.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: "auth" }) });
  await assert.rejects(a.context.api.session());
  assert.equal(storage.has("singit.session"), false);
  assert.equal(make().context.csrf(), "");
});

test("legacy restore proves its own session and a new tab captures the saved account", async () => {
  const { make, storage } = tabs();
  storage.set("singit.csrf", "legacy-A");
  const a = make();
  await a.context.api.session();
  assert.equal(a.requests[0].headers["X-SingIt-CSRF"], "legacy-A");
  a.context.setCsrf(a.context.csrf(), "wallet:A");
  const b = make();
  await b.context.api.session();
  assert.equal(b.requests[0].headers["X-SingIt-Account"], "wallet:A");
  assert.equal(storage.has("singit.csrf"), false);
});

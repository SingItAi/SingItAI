import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { serve, CONFIG } from "./helpers/agent-app.mjs";
import { signatureFor, SeenDeliveries } from "../src/nohumans-alerts.mjs";

const SECRET = "test-nohumans-alert-secret";
const PATH = "/webhooks/nohumans";
const NOW = Date.parse("2026-11-10T12:00:00Z");
const sec = ms => String(Math.floor(ms / 1000));

const purchase = (extra = {}) => ({ id: "evt-1", type: "listing.purchase", hook_id: "hook-1",
  listing: { id: "listing-test-1", name: "Test listing", endpoint_url: "https://example.test/x" },
  data: { delivered: true, http_status: 200, amount_usdc: 0.05, tx_hash: "0x" + "ab".repeat(32) }, ...extra });

async function post(app, rawBody, headers = {}, { method = "POST", path = PATH } = {}) {
  const chunks = [];
  const socket = new Duplex({ read() {}, write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  const req = new IncomingMessage(socket);
  req.method = method; req.url = path;
  req.httpVersionMajor = 1; req.httpVersionMinor = 1; req.httpVersion = "1.1";
  const buf = Buffer.from(rawBody ?? "");
  req.headers = { host: "ask.test", "content-type": "application/json", "content-length": String(buf.length), ...headers };
  req.complete = true; req.push(buf); req.push(null);
  const res = new ServerResponse(req); res.assignSocket(socket);
  await new Promise((resolve, reject) => {
    res.on("finish", resolve); res.on("error", reject);
    app.handle(req, res, e => reject(e ?? new Error("Unhandled request")));
  });
  const raw = Buffer.concat(chunks).toString("utf8");
  return { status: res.statusCode, headers: res.getHeaders(), body: raw.slice(raw.indexOf("\r\n\r\n") + 4) };
}

function signed(body, { secret = SECRET, ts = sec(NOW), delivery = "del-1", event } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return { raw, headers: { "x-nohumans-event": event ?? body.type ?? "x", "x-nohumans-delivery": delivery,
    "x-nohumans-timestamp": ts, "x-nohumans-signature": signatureFor(secret, ts, raw) } };
}

async function setup(t, config = {}, opts = {}) {
  const logs = [];
  const fetches = [];
  const fetchImpl = async (url, init) => { fetches.push({ url, init }); return new Response("ok"); };
  const { app } = await serve(t, { config: { ...CONFIG, nohumansAlertSecret: SECRET, nohumansAlertWebhookUrl: "https://notify.test/hook", ...config },
    log: line => logs.push(line), clock: { now: () => NOW }, fetchImpl, ...opts });
  const settle = () => new Promise(r => setImmediate(r));
  return { app, logs, fetches, settle, purchases: () => logs.filter(l => l.startsWith("singit-ask: nohumans.listing.purchase")) };
}

test("valid signed purchase is accepted, logged and notified once", async (t) => {
  const { app, logs, fetches, settle, purchases } = await setup(t);
  const { raw, headers } = signed(purchase());
  const got = await post(app, raw, headers);
  await settle();
  assert.equal(got.status, 200);
  assert.deepEqual(JSON.parse(got.body), { ok: true });
  assert.equal(got.headers["cache-control"], "no-store");
  assert.equal(purchases().length, 1);
  assert.match(purchases()[0], /"listing_id":"listing-test-1"/);
  assert.match(purchases()[0], /"tx_hash":"0xabab/);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, "https://notify.test/hook");
  assert.ok(JSON.parse(fetches[0].init.body).text.includes("Test listing"));
  assert.ok(!logs.join("\n").includes(SECRET));
  assert.ok(!logs.join("\n").includes(headers["x-nohumans-signature"]));
});

test("a failing notify webhook does not change the 2xx", async (t) => {
  const { app } = await setup(t, {}, { fetchImpl: async () => { throw new Error("down"); } });
  const { raw, headers } = signed(purchase());
  assert.equal((await post(app, raw, headers)).status, 200);
});

test("invalid signature, missing signature, wrong length and altered body are 401 without notify", async (t) => {
  const { app, fetches, settle, purchases } = await setup(t);
  const good = signed(purchase());
  const cases = [
    { raw: good.raw, headers: { ...good.headers, "x-nohumans-signature": signatureFor("other-secret", sec(NOW), good.raw) } },
    { raw: good.raw, headers: { ...good.headers, "x-nohumans-signature": undefined } },
    { raw: good.raw, headers: { ...good.headers, "x-nohumans-signature": "v1=abcd" } },
    { raw: good.raw.replace("0.05", "9.99"), headers: good.headers },
  ];
  for (const c of cases) {
    const headers = Object.fromEntries(Object.entries(c.headers).filter(([, v]) => v !== undefined));
    const got = await post(app, c.raw, headers);
    assert.equal(got.status, 401);
    assert.ok(!got.body.includes("v1="));
    assert.ok(!got.body.includes(SECRET));
  }
  await settle();
  assert.equal(fetches.length, 0);
  assert.equal(purchases().length, 0);
});

test("stale, future and malformed timestamps are 401 even with a valid signature", async (t) => {
  const { app } = await setup(t);
  for (const ts of [sec(NOW - 6 * 60_000), sec(NOW + 2 * 60_000), "abc", "", "1e9"]) {
    const { raw, headers } = signed(purchase(), { ts });
    assert.equal((await post(app, raw, headers)).status, 401, ts);
  }
  const edge = signed(purchase(), { ts: sec(NOW - 4 * 60_000) });
  assert.equal((await post(app, edge.raw, edge.headers)).status, 200);
});

test("registration test is answered 2xx unsigned and without a secret", async (t) => {
  const { app, fetches, settle } = await setup(t, { nohumansAlertSecret: null });
  const body = JSON.stringify({ id: "t1", type: "alerts.test", registration: true });
  assert.equal((await post(app, body, {})).status, 200);
  assert.equal((await post(app, body, { "x-nohumans-timestamp": sec(NOW), "x-nohumans-signature": "v1=" + "0".repeat(64) })).status, 200);
  await settle();
  assert.equal(fetches.length, 0);
});

test("registration: true on any other type does not skip verification", async (t) => {
  const { app } = await setup(t);
  const got = await post(app, JSON.stringify(purchase({ registration: true })), {});
  assert.equal(got.status, 401);
});

test("alerts.test with registration false or omitted needs a valid signature", async (t) => {
  const { app } = await setup(t);
  for (const body of [{ id: "t2", type: "alerts.test", registration: false }, { id: "t3", type: "alerts.test" }]) {
    const raw = JSON.stringify(body);
    assert.equal((await post(app, raw, { "x-nohumans-timestamp": sec(NOW), "x-nohumans-signature": "v1=" + "0".repeat(64) })).status, 401);
    const ok = signed(raw, { delivery: "del-" + body.id });
    assert.equal((await post(app, raw, ok.headers)).status, 200);
  }
});

test("a replayed delivery is 200 but processed and notified once", async (t) => {
  const { app, fetches, settle, purchases } = await setup(t);
  const { raw, headers } = signed(purchase());
  assert.equal((await post(app, raw, headers)).status, 200);
  assert.equal((await post(app, raw, headers)).status, 200);
  // same event id under a new delivery id is also a duplicate
  const again = signed(purchase(), { delivery: "del-2" });
  assert.equal((await post(app, again.raw, again.headers)).status, 200);
  await settle();
  assert.equal(purchases().length, 1);
  assert.equal(fetches.length, 1);
});

test("seen store is capped and expires", () => {
  const seen = new SeenDeliveries({ max: 3, ttlMs: 1000 });
  for (const k of ["a", "b", "c", "d"]) seen.add([k], 0);
  assert.equal(seen.has(["a"], 0), false);
  assert.equal(seen.has(["d"], 0), true);
  assert.equal(seen.has(["d"], 5000), false);
});

test("secret file is read per request and wins over the inline secret", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "singit-nohumans-alert-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "secret");
  await writeFile(file, "  dummy-file-secret-1 \n");
  const { app } = await setup(t, { nohumansAlertSecretFile: file });
  const one = signed(purchase(), { secret: "dummy-file-secret-1", delivery: "d1" });
  assert.equal((await post(app, one.raw, one.headers)).status, 200);
  const inline = signed(purchase({ id: "evt-2" }), { delivery: "d2" });
  assert.equal((await post(app, inline.raw, inline.headers)).status, 401);
  await writeFile(file, "dummy-file-secret-2\n");
  const two = signed(purchase({ id: "evt-3" }), { secret: "dummy-file-secret-2", delivery: "d3" });
  assert.equal((await post(app, two.raw, two.headers)).status, 200);
  const old = signed(purchase({ id: "evt-4" }), { secret: "dummy-file-secret-1", delivery: "d4" });
  assert.equal((await post(app, old.raw, old.headers)).status, 401);
});

test("unset secret (or missing file) gives 503 for a signed event", async (t) => {
  const { app } = await setup(t, { nohumansAlertSecret: null });
  const { raw, headers } = signed(purchase());
  assert.equal((await post(app, raw, headers)).status, 503);
  const missing = await setup(t, { nohumansAlertSecretFile: join(tmpdir(), "no-such-nohumans-secret") });
  assert.equal((await post(missing.app, raw, headers)).status, 503);
});

test("non-JSON content is 400 and an oversized body is 413", async (t) => {
  const { app } = await setup(t);
  assert.equal((await post(app, "hello", { "content-type": "text/plain" })).status, 400);
  assert.equal((await post(app, "{nope")).status, 400);
  const big = JSON.stringify({ type: "listing.purchase", pad: "x".repeat(70 * 1024) });
  const got = await post(app, big, signed(big).headers);
  assert.equal(got.status, 413);
});

test("GET and HEAD are 404, and the path is in no public catalog", async (t) => {
  const { app } = await setup(t);
  for (const method of ["GET", "HEAD"]) assert.equal((await post(app, "", {}, { method })).status, 404);
  for (const path of ["/openapi.json", "/llms.txt", "/.well-known/x402", "/v1/catalog"]) {
    const got = await post(app, "", {}, { method: "GET", path });
    assert.ok(!got.body.includes("webhooks/nohumans"), path);
  }
});

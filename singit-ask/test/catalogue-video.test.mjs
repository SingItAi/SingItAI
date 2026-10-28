import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelCatalogue } from "../src/catalogue.mjs";

const offer = { healthy: true, available: true, trusted: true, provider_id: "seller" };
const json = (body) => new Response(JSON.stringify(body));

test("videoHealth counts qualifying offers, shares reads and caches through the TTL, keeping failed refreshes", async () => {
  let now = 0, calls = 0, fail = false;
  const catalogue = new ModelCatalogue({ url: "https://surplus.test", now: () => now, blocked: ["BLOCKED"],
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, "https://surplus.test/api/markets/video%2Fmodel");
      assert.ok(init.signal instanceof AbortSignal);
      if (fail) throw new Error("offline");
      return json({ data: { offers: [offer, offer, { ...offer, provider_id: "blocked" },
        { ...offer, healthy: false }, { ...offer, available: false }, { ...offer, trusted: false }] } });
    } });
  assert.deepEqual(await Promise.all([catalogue.videoHealth("video/model"), catalogue.videoHealth("video/model")]), [2, 2]);
  assert.equal(await catalogue.videoHealth("video/model"), 2);
  assert.equal(calls, 1);
  now = 60_000;
  assert.equal(await catalogue.videoHealth("video/model"), 2);
  assert.equal(calls, 2);
  now += 60_000; fail = true;
  assert.equal(await catalogue.videoHealth("video/model"), 2);
  assert.equal(calls, 3);
});

test("videoHealth distinguishes unreadable books from an empty book", async () => {
  for (const [response, expected] of [
    [() => { throw new Error("offline"); }, null], [() => new Response("bad json"), null],
    [() => json({}), null], [() => new Response("", { status: 503 }), null], [() => json({ offers: [] }), 0],
  ]) {
    const catalogue = new ModelCatalogue({ url: "https://surplus.test", fetchImpl: async () => response() });
    assert.equal(await catalogue.videoHealth("m"), expected);
  }
});

test("videoServed publishes counts, omits unknown books, caches and refreshes stale maps in the background", async () => {
  let now = 0, calls = 0, fail = false;
  const catalogue = new ModelCatalogue({ url: "https://surplus.test", now: () => now,
    fetchImpl: async (url) => {
      calls++;
      if (url.endsWith("unknown") || fail) throw new Error("offline");
      return json({ offers: url.endsWith("healthy") ? [offer, offer] : [] });
    } });
  catalogue.videoModels = async () => new Map(["healthy", "empty", "unknown"].map((id) => [id, { id }]));
  const first = await catalogue.videoServed(0);
  assert.deepEqual([...first], [["healthy", 2], ["empty", 0]]);
  assert.equal(await catalogue.videoServed(0), first);
  assert.equal(calls, 3);
  now = 60_000; fail = true;
  assert.equal(await catalogue.videoServed(0), first);
  await catalogue.loadingVideoServed;
  assert.deepEqual([...await catalogue.videoServed(0)], [...first]);
  assert.equal(calls, 6);
});

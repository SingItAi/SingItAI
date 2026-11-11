import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import entry, { createProvider, resolveAlias } from "../index.js";
const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url)));

test("manifest and registration own only singit", () => {
  assert.equal(manifest.id, "singit");
  assert.deepEqual(manifest.providers, ["singit"]);
  assert.equal(manifest.enabledByDefault, undefined);
  let provider;
  entry.register({ registerProvider(p) { provider = p; } });
  assert.equal(provider.id, "singit");
});
test("provider defaults and catalog use the local proxy without auth", async () => {
  const p = createProvider({ env: {}, fetchImpl: async () => new Response('{}') });
  const model = p.resolveDynamicModel({ modelId: "live/new-id" });
  assert.equal(model.id, "live/new-id");
  assert.equal(model.baseUrl, "http://127.0.0.1:8787/v1");
  assert.equal(model.api, "openai-completions");
  const catalog = await p.catalog.run();
  assert.equal(catalog.provider.auth, "none");
  assert.deepEqual(p.auth, []);
  assert.equal(createProvider({ env: { SINGIT_PROXY_PORT: "9000" } }).baseUrl, "http://127.0.0.1:9000/v1");
});
test("dynamic preparation resolves aliases via a cached catalog and passes unknown IDs", async () => {
  let calls = 0;
  const catalog = { default: "chat", data: [{ id: "free/other" }, { id: "free/deepseek-v4.1-flash" }] };
  const p = createProvider({ env: {}, fetchImpl: async () => { calls++; return Response.json(catalog); } });
  for (const id of ["auto", "singit/auto", "free", "singit/free", "new/id"]) {
    assert.equal((await p.prepareDynamicModel({ modelId: id })).id, resolveAlias(id, catalog));
    assert.equal(p.resolveDynamicModel({ modelId: id }).id, resolveAlias(id, catalog));
  }
  assert.equal(calls, 1);
  assert.equal(resolveAlias("auto", { data: [{ id: "image" }, { id: "chat" }] }), "chat");
  assert.equal(resolveAlias("free", { data: [{ id: "free/other" }] }), "free/other");
  assert.equal(resolveAlias("free", {}), "free");
  const offline = createProvider({ env: {}, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal((await offline.prepareDynamicModel({ modelId: "auto" })).id, "auto");
});
test("runtime has no payment/signing dependencies or alternate ports", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /paidFetch|privateKey|session-wallet|@singitai\/sdk|signTypedData|8402|8403|8517|ask\.singitai/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(pkg.dependencies, undefined);
});

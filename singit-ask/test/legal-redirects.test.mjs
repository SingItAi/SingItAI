import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";

async function serve(t) {
  const app = createApp({ model: "fixture" }, {
    catalogue: null, log: () => {},
    facilitatorClient: {
      async getSupported() { return { kinds: [], extensions: [], signers: {} }; },
      async verify() { assert.fail("must not verify payments"); },
      async settle() { assert.fail("must not settle payments"); },
    },
    fetchImpl: () => { assert.fail("must not fetch upstream"); },
  });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", error => error ? reject(error) : resolve(listener));
    listener.on("error", reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("legal GET and HEAD routes redirect to fixed canonical URLs", async t => {
  const url = await serve(t);
  for (const page of ["terms", "privacy"]) {
    for (const suffix of ["", "/", "?x=1", "/?x=1"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(`${url}/${page}${suffix}`, { method, redirect: "manual",
          headers: { Host: "untrusted.invalid" } });
        assert.equal(response.status, 308);
        assert.equal(response.headers.get("location"), `https://singitai.app/${page}/`);
        assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
        assert.equal(response.headers.get("access-control-allow-origin"), "*");
        if (method === "HEAD") assert.equal(await response.text(), "");
      }
    }
  }
  const response = await fetch(`${url}/terms`, { method: "POST", redirect: "manual" });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("location"), null);
  assert.deepEqual(await response.json(), { error: {
    type: "invalid_request_error", message: "Cannot POST /terms", code: "not_found",
  } });
});

test("public Ask metadata links to canonical legal pages", async t => {
  const url = await serve(t);
  const spec = await (await fetch(`${url}/openapi.json`)).json();
  assert.equal(spec.info.termsOfService, "https://singitai.app/terms/");
  const text = await (await fetch(`${url}/llms.txt`)).text();
  assert.ok(text.includes("Terms: https://singitai.app/terms/"));
  assert.ok(text.includes("Privacy policy: https://singitai.app/privacy/"));
  const index = await (await fetch(url)).json();
  assert.equal(index.links.terms, "https://singitai.app/terms/");
  assert.equal(index.links.privacy, "https://singitai.app/privacy/");
});

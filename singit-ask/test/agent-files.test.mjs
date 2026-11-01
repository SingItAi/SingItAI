import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createApp, BASE, SOLANA, ROUTE } from "../src/app.mjs";

const documents = new Map([
  ["/SKILL.md", "text/markdown; charset=utf-8"],
  ["/.well-known/agent-card.json", "application/json; charset=utf-8"],
  ["/llms-models.txt", "text/plain; charset=utf-8"],
  ["/llms-full.txt", "text/plain; charset=utf-8"],
]);
const website = new URL("../../website/", import.meta.url);
async function serve(t, options = {}) {
  const app = createApp({ model: "fixture", payToBase: "0x" + "1".repeat(40) }, {
    catalogue: null, log: () => {},
    facilitatorClient: {
      async getSupported() { return { kinds: [BASE, SOLANA].flatMap(network => ["exact", "upto"].map(scheme => ({ x402Version: 2, scheme, network, extra: { receiverAuthorizer: "11111111111111111111111111111111", feePayer: "11111111111111111111111111111111", facilitatorAddress: "0x" + "3".repeat(40) } }))), extensions: [], signers: {} }; },
      async verify() { assert.fail("must not verify payments"); },
      async settle() { assert.fail("must not settle payments"); },
    },
    fetchImpl: () => { assert.fail("must not fetch upstream"); },
    spendLimits: { read() { assert.fail("documents must bypass limiter reads"); } },
    ...options,
  });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", error => error ? reject(error) : resolve(listener));
    listener.on("error", reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
function raw(url, path, method = "GET", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { path, method, headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}
function notFound(response, path, method = "GET") {
  assert.equal(response.status, 404, path);
  assert.deepEqual(JSON.parse(response.body), { error: {
    type: "invalid_request_error", message: `Cannot ${method} ${path}`, code: "not_found",
  } });
}

test("allowlisted documents preserve bytes, headers, HEAD and strong conditional ETags", async t => {
  let limiterReads = 0;
  const url = await serve(t, { spendLimits: { read() { limiterReads++; return null; } } });
  for (const [path, type] of documents) {
    const expected = await readFile(new URL(path.slice(1), website));
    const res = await fetch(url + path, { headers: { "X-SingIt-Limiter": "fixture" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), type);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("cache-control"), "public, max-age=300");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), expected);
    if (path.endsWith(".json")) JSON.parse(expected.toString());
    const etag = res.headers.get("etag");
    assert.match(etag, /^"[^" ]+"$/);
    const head = await fetch(url + path, { method: "HEAD" });
    assert.equal(head.status, 200);
    for (const header of ["content-type", "access-control-allow-origin", "cache-control", "x-content-type-options", "etag", "content-length"])
      assert.equal(head.headers.get(header), res.headers.get(header), header);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const conditional = await raw(url, path, "GET", { "If-None-Match": etag });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.body.length, 0);
  }
  assert.equal(limiterReads, 0);
  const query = await fetch(url + "/llms-models.txt?x=1");
  assert.equal(query.status, 200);
  assert.deepEqual(Buffer.from(await query.arrayBuffer()), await readFile(new URL("llms-models.txt", website)));
});

test("other paths and methods keep the JSON 404; raw traversal cannot select a file", async t => {
  const url = await serve(t);
  for (const path of ["/website/SKILL.md", "/skill.md", "/SKILL.md/", "/llms-full.txt.bak",
    "/.well-known/mcp-registry-auth", "/.well-known/agent-card.json/",
    "/../website/SKILL.md", "/%2e%2e/website/SKILL.md", "/..%2fwebsite%2fSKILL.md",
    "/.well-known/../SKILL.md", "/SKILL.md%00", "/..\\website\\SKILL.md", "/\\SKILL.md", "/%5cSKILL.md"]) {
    notFound(await raw(url, path), path);
  }
  for (const path of documents.keys()) notFound(await raw(url, path, "POST"), path, "POST");
});

test("missing or unreadable files fall through; file updates are visible immediately", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ask-agent-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const warnings = [];
  const url = await serve(t, { agentFilesDir: dir, log: message => warnings.push(message) });
  for (const path of documents.keys()) notFound(await raw(url, path), path);
  assert.equal(warnings.filter(message => message.includes("warning: agent file unavailable")).length, 4);
  await mkdir(join(dir, "SKILL.md"));
  notFound(await raw(url, "/SKILL.md"), "/SKILL.md");
  await rm(join(dir, "SKILL.md"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "first");
  const first = await fetch(url + "/SKILL.md");
  assert.equal(await first.text(), "first");
  await writeFile(join(dir, "SKILL.md"), "second");
  const second = await fetch(url + "/SKILL.md", { headers: { "If-None-Match": first.headers.get("etag") } });
  assert.equal(second.status, 200);
  assert.equal(await second.text(), "second");
  assert.notEqual(second.headers.get("etag"), first.headers.get("etag"));
});

test("existing free routes and unpaid paid route still work", async t => {
  const url = await serve(t);
  for (const path of ["/llms.txt", "/health"]) assert.equal((await fetch(url + path)).status, 200);
  const response = await fetch(url + ROUTE, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }) });
  assert.equal(response.status, 402);
  assert.ok(response.headers.get("payment-required"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { serve, CONFIG } from "./helpers/agent-app.mjs";

const PATH = "/.well-known/nohumans-claim";

// Exercise Express without a network socket; these responses have a Content-Length.
async function request(app, path = PATH, method = "GET") {
  const chunks = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) {
    chunks.push(Buffer.from(chunk)); callback();
  } });
  const req = new IncomingMessage(socket);
  req.method = method; req.url = path;
  req.httpVersionMajor = 1; req.httpVersionMinor = 1; req.httpVersion = "1.1";
  req.headers = { host: "ask.test" }; req.complete = true; req.push(null);
  const res = new ServerResponse(req);
  res.assignSocket(socket);
  await new Promise((resolve, reject) => {
    res.on("finish", resolve); res.on("error", reject);
    app.handle(req, res, error => reject(error ?? new Error("Unhandled request")));
  });
  const raw = Buffer.concat(chunks).toString("utf8");
  return { status: res.statusCode, headers: res.getHeaders(), body: raw.slice(raw.indexOf("\r\n\r\n") + 4) };
}

async function claimFile(t) {
  const dir = await mkdtemp(join(tmpdir(), "singit-nohumans-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "claim.txt");
}

function assertPublicUncached(got) {
  assert.equal(got.headers["access-control-allow-origin"], "*");
  assert.equal(got.headers["cache-control"], "no-store");
}

test("claim token is trimmed, public, uncached, and rotates without restart", async (t) => {
  const file = await claimFile(t);
  await writeFile(file, "  \n test-claim-token-abc \n\n");
  const { app } = await serve(t, { config: { ...CONFIG, nohumansClaimFile: file } });
  const got = await request(app);
  assert.equal(got.status, 200);
  assert.equal(got.headers["content-type"], "text/plain; charset=utf-8");
  assertPublicUncached(got);
  assert.equal(got.body, "test-claim-token-abc");

  await writeFile(file, "\ntest-claim-token-rotated\n");
  const rotated = await request(app);
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body, "test-claim-token-rotated");

  const head = await request(app, PATH, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(head.headers["content-type"], got.headers["content-type"]);
  assertPublicUncached(head);
  assert.equal(Number(head.headers["content-length"]), Buffer.byteLength("test-claim-token-rotated"));
});

test("unset, missing, unreadable, empty and whitespace-only claim files return a public uncached 404", async (t) => {
  const missing = await claimFile(t);
  const empty = await claimFile(t);
  await writeFile(empty, "");
  const blank = await claimFile(t);
  await writeFile(blank, " \n\t\r\n ");
  // A directory cannot be read as a UTF-8 file, even when tests run as root.
  for (const file of [undefined, missing, tmpdir(), empty, blank]) {
    const { app } = await serve(t, { config: { ...CONFIG, nohumansClaimFile: file } });
    for (const method of ["GET", "HEAD"]) {
      const got = await request(app, PATH, method);
      assert.equal(got.status, 404);
      assertPublicUncached(got);
      assert.equal(got.body, method === "HEAD" ? "" : "Not Found");
    }
  }
});

test("OpenAPI always declares the free claim path, even without a configured file", async (t) => {
  const { app } = await serve(t);
  const got = await request(app, "/openapi.json");
  assert.equal(got.status, 200);
  const operation = JSON.parse(got.body).paths[PATH].get;
  assert.equal(operation.operationId, "getNohumansClaim");
  assert.deepEqual(operation.security, []);
  assert.equal(operation.responses[200].content["text/plain"].schema.type, "string");
  assert.ok(operation.responses[404]);
});

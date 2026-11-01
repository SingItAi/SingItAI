// The CDP validator script is the only thing here that talks to the network, so its parsing and exit codes are
// pinned against fake fetch implementations. Nothing in this file makes a request.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_ENDPOINT, evaluate, main, readConfig, validateAll, validateResource } from "../cdp-validate.mjs";

const URL = "https://ask.singitai.app/v1/exa/answer";
const entry = { url: URL, method: "POST" };
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const stub = (response) => { const calls = []; const impl = async (url, init) => { calls.push({ url, init }); return typeof response === "function" ? response(url, init) : response; }; impl.calls = calls; return impl; };
const accepted = { valid: true, simulation: { outcome: "accepted" }, preflight: { failures: [], recommendations: [] } };

test("an accepted simulation with no required failures is ok", () => {
  assert.deepEqual(evaluate(accepted), { ok: true, valid: true, outcome: "accepted", failures: [], recommendations: [], reasons: [] });
  assert.equal(evaluate({ valid: true, simulation: { outcome: "accepted" } }).ok, true);
});

test("invalid, rejected, or a required preflight failure is not ok", () => {
  const invalid = evaluate({ ...accepted, valid: false });
  assert.equal(invalid.ok, false);
  assert.match(invalid.reasons[0], /valid is false/);
  const rejected = evaluate({ valid: true, simulation: { outcome: "rejected" } });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reasons[0], /outcome is "rejected"/);
  const noSimulation = evaluate({ valid: true });
  assert.match(noSimulation.reasons[0], /outcome is null/);
  const required = evaluate({ ...accepted, preflight: { failures: [{ code: "resource_unreachable", message: "resource did not answer" }] } });
  assert.equal(required.ok, false);
  assert.deepEqual(required.failures, ["resource_unreachable: resource did not answer"]);
});

test("failure and recommendation entries are read from the shapes the reply may use", () => {
  const findings = evaluate({ ...accepted,
    preflight: { requiredFailures: ["no output example"], recommendations: { warnings: ["add an icon"] } } });
  assert.deepEqual(findings.failures, ["no output example"]);
  assert.deepEqual(findings.recommendations, ["add an icon"]);
  // Recommendations alone never fail the check.
  assert.equal(evaluate({ ...accepted, preflight: { recommendations: ["add an icon"] } }).ok, true);
});

test("the request carries the resource and method, and no payment or credential", async () => {
  const fetchImpl = stub(reply(accepted));
  const result = await validateResource(entry, { fetchImpl });
  assert.equal(result.ok, true);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, DEFAULT_ENDPOINT);
  assert.equal(call.init.method, "POST");
  assert.deepEqual(JSON.parse(call.init.body), { resource: URL, method: "POST" });
  assert.deepEqual(Object.keys(call.init.headers).sort(), ["accept", "content-type"]);
  assert.ok(!/payment|authorization|x-api-key|cookie/i.test(JSON.stringify(call.init.headers)));
});

test("a failed call is reported as an error, not as a passed or failed resource", async () => {
  const rateLimited = await validateResource(entry, { fetchImpl: stub(reply({ message: "slow down" }, 429)) });
  assert.deepEqual(rateLimited, { url: URL, method: "POST", error: "HTTP 429: slow down" });
  const html = await validateResource(entry, { fetchImpl: stub({ ok: true, status: 200, text: async () => "<html>" }) });
  assert.match(html.error, /not JSON/);
  const down = await validateResource(entry, { fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); } });
  assert.match(down.error, /request failed: connect ECONNREFUSED/);
  const slow = await validateResource(entry, { fetchImpl: async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }, timeoutMs: 1500 });
  assert.equal(slow.error, "timed out after 1500 ms");
});

test("a 4xx that still carries a verdict is judged on that verdict", async () => {
  const result = await validateResource(entry, { fetchImpl: stub(reply({ valid: false, simulation: { outcome: "rejected" } }, 400)) });
  assert.equal(result.ok, false);
  assert.equal(result.error, undefined);
  assert.equal(result.outcome, "rejected");
});

test("exit codes: 0 when every resource passes, 1 on a failed resource, 2 when the check could not run", async () => {
  const resources = [entry, { url: "https://ask.singitai.app/v1/responses", method: "POST" }];
  assert.equal((await validateAll({ resources, fetchImpl: stub(reply(accepted)) })).code, 0);
  const rejected = await validateAll({ resources, fetchImpl: stub(reply({ valid: true, simulation: { outcome: "rejected" } })) });
  assert.equal(rejected.code, 1);
  const broken = await validateAll({ resources, fetchImpl: async () => { throw new Error("ENOTFOUND"); } });
  assert.equal(broken.code, 2);
  // A transport error outranks a failed verdict: the run is incomplete, not a clean failure.
  let n = 0;
  const half = async () => { if (n++ === 0) return reply({ valid: true, simulation: { outcome: "rejected" } }); throw new Error("ENOTFOUND"); };
  assert.equal((await validateAll({ resources, fetchImpl: half })).code, 2);
  assert.equal((await validateAll({ resources: [{ url: URL, method: "GET" }], fetchImpl: stub(reply(accepted)) })).code, 0);
});

const configFile = (content) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "cdp-validate-")), "resources.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
};

test("readConfig rejects an empty list, a non-https url and an unsupported method", () => {
  assert.throws(() => readConfig(configFile({ resources: [] })), /non-empty/);
  assert.throws(() => readConfig(configFile({})), /non-empty/);
  assert.throws(() => readConfig(configFile({ resources: [{ url: "http://ask.singitai.app/v1/x", method: "POST" }] })), /https url/);
  assert.throws(() => readConfig(configFile({ resources: [{ url: URL, method: "PUT" }] })), /GET or POST/);
  assert.throws(() => readConfig(configFile("not json")));
  assert.equal(readConfig(configFile({ resources: [entry] })).endpoint, DEFAULT_ENDPOINT);
  assert.equal(readConfig(configFile({ validateEndpoint: "https://validator.test/x", resources: [entry] })).endpoint, "https://validator.test/x");
});

test("main returns the exit code, prints a report, and never calls out on a bad config", async () => {
  const lines = [];
  const out = (line) => lines.push(line);
  const config = configFile({ resources: [entry] });
  assert.equal(await main(["--config", config], { fetchImpl: stub(reply(accepted)), out }), 0);
  assert.match(lines.join("\n"), /ok\s+POST https:\/\/ask\.singitai\.app\/v1\/exa\/answer/);
  assert.match(lines.join("\n"), /1 resource\(s\), 1 passed, 0 did not/);

  lines.length = 0;
  const failing = reply({ valid: true, simulation: { outcome: "accepted" }, preflight: { failures: [{ code: "no_output", message: "no output example" }], recommendations: ["add an icon"] } });
  assert.equal(await main(["--config", config], { fetchImpl: stub(failing), out }), 1);
  const text = lines.join("\n");
  assert.match(text, /FAIL no_output: no output example/);
  assert.match(text, /advice: add an icon/);

  lines.length = 0;
  assert.equal(await main(["--config", config, "--json"], { fetchImpl: stub(reply(accepted)), out }), 0);
  assert.equal(JSON.parse(lines[0]).code, 0);

  const errors = [];
  const fetchImpl = stub(reply(accepted));
  assert.equal(await main(["--config", configFile({ resources: [] })], { fetchImpl, out, err: (m) => errors.push(m) }), 2);
  assert.equal(fetchImpl.calls.length, 0);
  assert.match(errors[0], /cdp-validate:/);
});

test("the committed config lists live https resources with a supported method", () => {
  const config = readConfig();
  assert.equal(config.endpoint, DEFAULT_ENDPOINT);
  assert.equal(config.resources.length, 22);
  for (const resource of config.resources) {
    assert.match(resource.url, /^https:\/\/[^/]+\/v1\//);
    assert.ok(["GET", "POST"].includes(resource.method));
  }
  assert.equal(new Set(config.resources.map((r) => r.url)).size, config.resources.length);
});

test("the live array shape: failed required checks are failures, failed advisory checks are recommendations", () => {
  // Trimmed from a real validator reply for /v1/responses (2026-10-24); addresses left out on purpose.
  const live = {
    valid: false, statusCode: 402, simulation: { outcome: "accepted" },
    preflight: [
      { check: "returns_402", passed: true, severity: "required", detail: "Endpoint correctly returns HTTP 402 Payment Required" },
      { check: "bazaar.info.input.method.matches_request", passed: false, severity: "required", detail: "Endpoint declares method POST but was probed with GET" },
      { check: "bazaar.info.output", passed: false, severity: "advisory", detail: "Missing info.output" },
    ],
  };
  const result = evaluate(live);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ["bazaar.info.input.method.matches_request: Endpoint declares method POST but was probed with GET"]);
  assert.deepEqual(result.recommendations, ["bazaar.info.output: Missing info.output"]);
  const passing = evaluate({ ...live, valid: true, preflight: live.preflight.filter((c) => c.severity !== "required" || c.passed) });
  assert.equal(passing.ok, true);
  assert.equal(passing.recommendations.length, 1);
});

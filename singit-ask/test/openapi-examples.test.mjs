import { test } from "node:test";
import assert from "node:assert/strict";
import { generateOpenapi } from "../scripts/generate-openapi.mjs";
import { readFileSync } from "node:fs";
import { HealthStats, healthBody } from "../src/health-stats.mjs";
import { baseOffer, exactBaseOffer } from "../src/metered.mjs";
import { ERROR_CODES } from "../src/errors.mjs";

// Only the structural JSON Schema vocabulary used by this document; no external validator needed.
function validate(value, schema, doc, path = "$") {
  if (schema.$ref) return validate(value, doc.components.schemas[schema.$ref.split("/").at(-1)], doc, path);
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, path);
  if (schema.enum) assert.ok(schema.enum.includes(value), path);
  if (schema.type) {
    const types = [].concat(schema.type);
    assert.ok(types.some(type => type === "null" ? value === null
      : type === "array" ? Array.isArray(value)
      : type === "integer" ? Number.isInteger(value)
      : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : typeof value === type), path);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, path);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, path);
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => validate(item, schema.items, doc, `${path}[${i}]`));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key} required`);
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties?.[key] ?? schema.additionalProperties;
      if (child === false) assert.fail(`${path}.${key} unexpected`);
      if (child && child !== true) validate(item, child, doc, `${path}.${key}`);
    }
  }
}

function examples(node) {
  return [
    ...(Object.hasOwn(node, "example") ? [node.example] : []),
    ...(Array.isArray(node.examples) ? node.examples : Object.values(node.examples ?? {}).map(example => example.value)),
  ];
}

test("response and header examples satisfy their schemas and paid errors have examples", async () => {
  const doc = await generateOpenapi();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const operation of Object.values(item)) {
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        for (const media of Object.values(response.content ?? {})) {
          for (const example of examples(media)) {
            assert.ok(media.schema, `${path} ${status} example needs a schema`);
            validate(example, media.schema, doc, `${path} ${status}`);
          }
        }
        for (const [name, header] of Object.entries(response.headers ?? {})) {
          for (const example of examples(header)) validate(example, header.schema, doc, `${path} ${status} ${name}`);
        }
      }
    }
    if (!item.post?.["x-payment-info"]) continue;
    for (const status of [400, 402, 413, 422, 503]) {
      const response = item.post.responses[status];
      if (!response) continue;
      assert.ok(response.content["application/json"].example, `${path} ${status}`);
    }
    const payment = item.post.responses[402].content["application/json"].example;
    assert.ok(ERROR_CODES.includes(payment.code));
    const exactOnly = /\/(exa|images|audio|video)\//.test(path);
    if (!exactOnly) {
      const offers = await Promise.all([baseOffer, exactBaseOffer].map(async build => {
        const { price, ...offer } = build({ payToBase: "<pay-to address>" }, new WeakMap(), () => "1500");
        return { ...offer, ...await price({ adapter: { getBody: () => ({}) } }), asset: "<USDC contract on Base>" };
      }));
      assert.deepEqual(payment.accepts, offers, path);
    } else {
      const module = path.includes("/exa/") ? "search" : path.includes("/images/") ? "images"
        : path.includes("/audio/") ? "speech" : "video";
      const source = readFileSync(new URL(`../src/${module}.mjs`, import.meta.url), "utf8");
      const timeout = Number(source.match(/maxTimeoutSeconds: (\d+)/)[1]);
      assert.deepEqual(payment.accepts.map(o => [o.scheme, o.network, o.maxTimeoutSeconds]),
        [["exact", "eip155:8453", timeout], ["exact", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", timeout]], path);
      assert.deepEqual(payment.accepts[0].extra, { name: "USD Coin", version: "2" });
      assert.ok(!Object.hasOwn(payment.accepts[1], "extra"));
      const error = item.post.responses[503].content["application/json"].example.error;
      if (module !== "video") assert.ok(source.includes(`code: "${error.code}", message: "${error.message}"`), path);
    }
    const parser = readFileSync(new URL("../src/app.mjs", import.meta.url), "utf8");
    const message = parser.match(/const message = tooLarge \? "([^"]+)"/)[1];
    assert.equal(item.post.responses[413].content["application/json"].example.error.message, message);

  }
  const limited = doc.paths["/v1/chat/completions"].post.responses[429];
  const cases = limited.content["application/json"].examples;
  assert.equal(cases.daily.value.error.code, "free_tier_exhausted");
  assert.equal(cases.busy.value.error.code, "free_tier_busy");
  assert.match(cases.busy.description, /Retry-After: 5 only/);
  for (const name of ["Limit", "Remaining", "Reset"]) assert.ok(
    Number.isInteger(limited.headers[`X-RateLimit-${name}`].example));
  assert.deepEqual(limited.headers["Retry-After"].examples, { daily: { value: "3600" }, busy: { value: "5" } });
  const health = doc.paths["/health"].get.responses[200].content["application/json"].example;
  const stats = new HealthStats({ now: () => Date.parse("2026-10-31T12:00:00Z") });
  for (let i = 0; i < 20; i++) stats.recordModel("deepseek-v4.1-flash", { ok: true });
  stats.recordModel("claude-opus-5.5", { ok: true });
  assert.deepEqual(health, { ok: true, ...healthBody(stats, null, "deepseek-v4.1-flash") });
  assert.equal(Object.keys(health.models).length, 2);
  for (const [status, count] of Object.entries(health.models_summary)) {
    assert.equal(Object.values(health.models).filter(model => model.status === status).length, count, status);
  }
  assert.equal(health.models_summary.up, 1);
  assert.equal(health.models_summary.insufficient_data, 1);
});

test("all generated spec examples use placeholders instead of wallet addresses", async () => {
  const doc = await generateOpenapi();
  let count = 0;
  function walk(node) {
    if (!node || typeof node !== "object") return;
    for (const example of examples(node)) {
      count++;
      const text = JSON.stringify(example).replaceAll("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "<Solana network identifier>");
      assert.doesNotMatch(text, /0x[0-9a-fA-F]{40}\b/);
      assert.doesNotMatch(text, /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    }
    for (const child of Object.values(node)) walk(child);
  }
  walk(doc);
  assert.ok(count > 20);
});

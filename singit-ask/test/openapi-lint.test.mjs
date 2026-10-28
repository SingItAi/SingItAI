// The catalogue linter behind solana-foundation/pay-skills (`pay catalog check`) rejects a spec whose operation
// summaries are not verb-first and 24 to 63 characters, or whose request bodies are empty objects. Its probe needs the
// network, so this test holds the offline half of it: the openapi.json singit-ask generates must stay linter-clean.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateOpenapi } from "../scripts/generate-openapi.mjs";

const VERBS = /^(Generate|Search|Fetch|Create|List|Get)\b/;

test("every operation summary is verb-first and 24 to 63 characters", async () => {
  const doc = await generateOpenapi();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== "object" || Array.isArray(op)) continue;   // `servers` on a path item
      assert.match(op.summary, VERBS, `${method} ${path}: ${op.summary}`);
      assert.ok(op.summary.length >= 24 && op.summary.length <= 63, `${method} ${path}: ${op.summary.length} chars`);
    }
  }
});

test("every paid route documents its request body: properties, an example and a description for each required field", async () => {
  const doc = await generateOpenapi();
  const paid = Object.entries(doc.paths).filter(([, item]) => item.post?.["x-payment-info"]);
  assert.ok(paid.length >= 22, `22 paid routes (3 Exa, 14 models, chat, messages, responses, images, speech), got ${paid.length}`);
  for (const [path, item] of paid) {
    const body = item.post.requestBody.content["application/json"];
    assert.ok(Object.keys(body.schema.properties ?? {}).length > 0, `${path}: schema has properties`);
    // Exa's contents takes urls or ids, so it has no one required field.
    assert.ok(body.example && typeof body.example === "object", `${path}: has an example`);
    for (const name of body.schema.required ?? []) {
      const field = body.schema.properties[name];
      assert.ok(field && (field.description || field.enum || field.const || field.examples || field.example || field.title),
        `${path}: required field ${name} is described`);
    }
  }
});

test("the spec names the production server, leaves video out and keeps Exa's three routes", async () => {
  const doc = await generateOpenapi();
  assert.deepEqual(doc.servers, [{ url: "https://ask.singitai.app" }]);
  assert.ok(!Object.keys(doc.paths).some((p) => p.startsWith("/v1/video")), "video stays absent while it is not sold");
  for (const route of ["/v1/exa/search", "/v1/exa/contents", "/v1/exa/answer"]) {
    assert.ok(doc.paths[route]?.post, route);
    assert.deepEqual(doc.paths[route].post.requestBody.content["application/json"].schema.type, "object");
  }
});

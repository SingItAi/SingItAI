// Every page served from website/ (landing, SEO pages, 404 and the PWA) loads the self-hosted
// Umami tracker exactly once, deferred, with the production website id and domain allow-list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["tests", "dist", "node_modules"]);
const TAG = '<script defer src="https://stats.singitai.app/s.js" data-website-id="6eab5805-b9b8-4f04-aa73-df64a8ce096e" data-domains="singitai.app,app.singitai.app"></script>';

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return htmlFiles(full);
    return name.endsWith(".html") ? [full] : [];
  });
}

const pages = htmlFiles(root);

test("the site has the pages the tracker must cover", () => {
  const rel = pages.map((p) => path.relative(root, p)).sort();
  for (const page of ["index.html", "404.html", "app/index.html", "developers/index.html", "models/index.html",
    "x402-llm-api/index.html", "x402-gift-cards-esims/index.html", "agent-spending-limits/index.html"]) {
    assert.ok(rel.includes(page), `${page} is missing`);
  }
});

for (const page of pages) {
  test(`${path.relative(root, page)} loads the Umami tracker once, in <head>`, () => {
    const html = readFileSync(page, "utf8");
    assert.equal(html.split("stats.singitai.app/s.js").length - 1, 1);
    const head = html.slice(0, html.indexOf("</head>"));
    assert.ok(head.includes(TAG), "the exact tracker tag is in <head>");
  });
}

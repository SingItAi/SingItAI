// /developers carries the SI-44 path (Try free → Get a key → Plug in MCP) and a "First paid call" tab that links the
// walkthrough in docs/, wired into the page's tabs and copy buttons like every other example.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const website = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(path.join(website, "developers", "index.html"), "utf8");
const DOC = "https://github.com/bubon-ik/SingItAI/blob/main/docs/first-paid-call.md";

test("the first paid call tab is wired to its panel, copies its code and links the guide", () => {
  assert.match(html, /role="tab" id="tab-paid" aria-controls="panel-paid" aria-selected="false" tabindex="-1"/);
  const panel = html.match(/<section class="tab-panel" role="tabpanel" id="panel-paid" aria-labelledby="tab-paid"[^>]* hidden>[\s\S]*?<\/section>/)?.[0];
  assert.ok(panel, "panel-paid");
  assert.ok(panel.includes('data-copy="code-paid"') && panel.includes('id="code-paid"'));
  assert.ok(panel.includes("curl -i https://ask.singitai.app/v1/chat/completions"));
  assert.ok(panel.includes('"model":"deepseek-v4.1-flash","max_tokens":200'));
  assert.ok(panel.includes(DOC));
  assert.ok(panel.indexOf("upto") < panel.indexOf("exact"));
  assert.match(panel, /ran the paid step end to end on 28\.10\.2026/);
  assert.ok(!/not yet run the paid step/.test(panel));
});

test("the guide the page links exists, and says what was and was not run", async () => {
  const doc = await readFile(path.join(website, "..", "docs", "first-paid-call.md"), "utf8");
  assert.match(doc, /^# Your first paid x402 call in 60 seconds/);
  assert.ok(doc.includes("**Status: paid end to end once, on 28.10.2026.**"));
  assert.ok(doc.includes("0x419874eea3fbb4621519fe4c252bb83b7b66c1c9cb6fbba07274172bef54e2f6"));
  assert.ok(!doc.includes("not yet done"));
  assert.match(doc, /Variants B and C rely on Coinbase\s+tooling and\s+were checked against Coinbase's docs/);
  for (const heading of ["## What you need", "## Step 1: see the 402", "## Step 2: pay", "## Step 3: the 200"]) {
    assert.ok(doc.includes(heading), heading);
  }
  assert.ok(doc.includes("curatedOnly: false"));
  assert.ok(!/video/i.test(doc));
});

test("every copy button has a target and every tab a panel", () => {
  for (const [, id] of html.matchAll(/data-copy="([^"]+)"/g)) assert.ok(html.includes(`id="${id}"`), id);
  for (const [, id] of html.matchAll(/role="tab" id="[^"]+" aria-controls="([^"]+)"/g)) {
    assert.match(html, new RegExp(`role="tabpanel" id="${id}"`), id);
  }
});

test("the steps and the closing CTA go Try free → Get a key → Plug in MCP", () => {
  const steps = [...html.match(/<ol class="quick-steps"[\s\S]*?<\/ol>/)[0].matchAll(/<li><b>([^<]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(steps, ["Try free", "Get a key", "Plug in MCP"]);
  const cta = html.match(/<section class="cta">[\s\S]*?<\/section>/)[0];
  assert.match(cta, /Try free\. Get a key\. <em>Plug in MCP\.<\/em>/);
  assert.ok(cta.includes('href="https://app.singitai.app/app/"'));
  assert.ok(cta.includes('href="cursor://anysphere.cursor-deeplink/mcp/install?name=singit&amp;config='));
});

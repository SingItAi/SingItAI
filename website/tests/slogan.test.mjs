// One honest slogan everywhere: the agent pays per call, only inside the limits the owner signs.
// The old line ("Your agent spends. Your wallet keeps the money.") must not come back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const OLD = /agent spends[.,]\s*(?:<[^>]+>)?\s*your wallet|wallet keeps the money/i;
const SHORT = "pays per call, only within the limits you sign";
const FULL = "pays per call, only within the daily and per-purchase limits you sign";

test("the old slogan is gone from the home page, the app hero, llms files, README and the preview source", () => {
  for (const file of ["website/index.html", "website/app/main.js", "website/llms.txt", "website/llms-full.txt",
    "README.md", "assets/brand/singit-social-preview-v3.html"]) {
    assert.doesNotMatch(read(file), OLD, file);
  }
});

test("the home page title, og:title, image alts and hero use the new slogan", () => {
  const html = read("website/index.html");
  assert.match(html, new RegExp(`<title>SingIt - Your agent ${SHORT}</title>`));
  assert.match(html, new RegExp(`og:title" content="SingIt: your agent ${SHORT}"`));
  assert.match(html, new RegExp(`<h1>Your agent pays per call, <em>only within the limits you sign\\.</em></h1>`));
  assert.equal([...html.matchAll(new RegExp(`image:alt" content="SingIt: Your agent ${SHORT}\\.`, "g"))].length, 2);
});

test("README and llms files carry the full sentence, and say who enforces the limits", () => {
  const readme = read("README.md");
  assert.match(readme, new RegExp(`\\*\\*Your agent ${FULL}\\.\\*\\*`));
  assert.match(readme, /On Base the limits are enforced onchain; on Solana the SingIt server checks them\./);
  assert.match(readme, new RegExp(`alt="SingIt: your agent ${SHORT}"`));
  for (const file of ["website/llms.txt", "website/llms-full.txt"]) {
    const text = read(file);
    assert.ok(text.includes(`Your agent ${FULL}:`), file);
    // key caps are checked by the server, not the contract
    assert.match(text, /on a SingIt API key the server checks them/, file);
  }
});

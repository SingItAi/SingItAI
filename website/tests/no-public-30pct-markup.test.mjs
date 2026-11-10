import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Public copy that names SingIt's percentage markup. Does not match Uniswap
// 0.30%, or "about 30% of max_tokens" (exact's typical-length assumption).
// Markup field names on public website files are checked separately below.
const FORBIDDEN = /(?:\+|plus)\s*30\s*%|30\s*%\s*markup|markup(?:\s+of)?\s*30\s*%|(?:cost|usage|used|price)\s*\+\s*30\s*%|Usage \+ 30%|(?:adds|plus)\s+30\s*%/i;
const EXACT_LENGTH = /~?\s*30\s*%\s*of\s*max_tokens/gi;

const TARGETS = [
  "website",
  "scripts/generate-model-pages.mjs",
  "scripts/generate-llms.mjs",
  "scripts/templates",
  "docs/first-paid-call.md",
  "docs/architecture.md",
  "docs/m2-speech-draft.json",
  "singit-ask/README.md",
  "singit-ask/src/app.mjs",
  "singit-ask/src/audio-generation.mjs",
  "singit-ask/src/pricing.mjs",
  "sign402-gateway/sign402_gateway/web_ask.py",
];

const SKIP_DIR = new Set(["node_modules", ".git"]);

async function walk(target, acc = []) {
  const abs = path.join(root, target);
  const info = await stat(abs);
  if (info.isFile()) {
    acc.push(abs);
    return acc;
  }
  for (const name of await readdir(abs)) {
    if (SKIP_DIR.has(name)) continue;
    const child = path.join(abs, name);
    const st = await stat(child);
    if (st.isDirectory()) await walk(path.relative(root, child), acc);
    else if (st.isFile()) acc.push(child);
  }
  return acc;
}

test("public website, docs and API copy omit the historical percentage surcharge", async () => {
  const files = (await Promise.all(TARGETS.map((t) => walk(t)))).flat()
    .filter((file) => !file.endsWith("no-public-30pct-markup.test.mjs"));
  const hits = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    text.split(/\n/).forEach((line, i) => {
      const stripped = line.replace(EXACT_LENGTH, "");
      if (FORBIDDEN.test(stripped)) hits.push(`${path.relative(root, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], hits.join("\n"));
});

const MARKUP_FIELD = /\bmarkup(?:Bps|Atomic|Pct|Percent)\b/;

test("public website files do not publish markup field names", async () => {
  const files = (await walk("website"))
    .filter((file) => !file.includes(`${path.sep}tests${path.sep}`));
  const hits = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    content.split(/\n/).forEach((line, i) => {
      if (MARKUP_FIELD.test(line)) hits.push(`${path.relative(root, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], hits.join("\n"));
});


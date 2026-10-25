// /privacy/ and /terms/ are real pages on the landing (MCP and x402 catalogues ask for both), every
// footer links them instead of the old GitHub Pages policy, and the sitemap lists them. The drafts carry
// ⟦…⟧ placeholders for facts only the operator can fill in (name, country, governing law, date); this
// test fails while any is left, so a draft cannot be published by accident.
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = new Set(["tests", "node_modules", "dist", "app"]);
const LEGAL = [
  { dir: "privacy", title: "Privacy Policy | SingIt" },
  { dir: "terms", title: "Terms of Service | SingIt" },
];

async function htmlFiles(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    if (skip.has(name)) continue;
    const full = path.join(dir, name);
    if ((await stat(full)).isDirectory()) out.push(...await htmlFiles(full));
    else if (name.endsWith(".html")) out.push(full);
  }
  return out;
}

for (const { dir, title } of LEGAL) {
  test(`/${dir}/ has its title, canonical URL and no bold weight`, async () => {
    const html = await readFile(path.join(site, dir, "index.html"), "utf8");
    assert.ok(html.includes(`<title>${title}</title>`));
    assert.ok(html.includes(`<link rel="canonical" href="https://singitai.app/${dir}/">`));
    assert.doesNotMatch(html, /<strong\b|font-weight:\s*[5-9]00/);
  });

  test(`/${dir}/ has no unfilled ⟦…⟧ placeholders`, async () => {
    const html = await readFile(path.join(site, dir, "index.html"), "utf8");
    const left = html.match(/⟦[^⟧]*⟧/g) ?? [];
    assert.deepEqual(left, [], `fill in before publishing: ${left.join(", ")}`);
  });
}

test("every footer links /privacy/ and /terms/, not the old GitHub Pages policy", async () => {
  for (const file of await htmlFiles(site)) {
    const footer = (await readFile(file, "utf8")).match(/<nav class="footer-links"[\s\S]*?<\/nav>/)?.[0];
    if (footer === undefined) continue;
    const page = path.relative(site, file);
    assert.match(footer, /href="\/privacy\/"/, page);
    assert.match(footer, /href="\/terms\/"/, page);
    assert.doesNotMatch(footer, /bubon-ik\.github\.io\/SingItAI\/"/, page);
  }
});

test("the sitemap lists /privacy/ and /terms/", async () => {
  const sitemap = await readFile(path.join(site, "sitemap.xml"), "utf8");
  for (const { dir } of LEGAL) assert.ok(sitemap.includes(`<loc>https://singitai.app/${dir}/</loc>`), dir);
});

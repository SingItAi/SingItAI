// Every page with the primary nav links the SingIt vs BlockRun pricing page (/pricing/) exactly once;
// on /pricing/ itself that link is the current page.
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = new Set(["tests", "node_modules", "dist", "app"]);

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

const primaryNav = (html) => html.match(/<nav class="nav-links" aria-label="Primary">([\s\S]*?)<\/nav>/)?.[1];

test("every primary nav links /pricing/ once", async () => {
  const pages = [];
  for (const file of await htmlFiles(site)) {
    const nav = primaryNav(await readFile(file, "utf8"));
    if (nav === undefined) continue;
    pages.push(path.relative(site, file));
    const links = nav.match(/<a href="\/pricing\/"[^>]*>Pricing<\/a>/g) || [];
    assert.equal(links.length, 1, `${path.relative(site, file)} should link /pricing/ once in its primary nav`);
  }
  assert.ok(pages.includes("index.html") && pages.includes(path.join("pricing", "index.html")), pages.join(", "));
});

test("the pricing link is the current page only on /pricing/", async () => {
  for (const file of await htmlFiles(site)) {
    const nav = primaryNav(await readFile(file, "utf8"));
    if (nav === undefined) continue;
    const current = /<a href="\/pricing\/" aria-current="page">/.test(nav);
    assert.equal(current, path.relative(site, file) === path.join("pricing", "index.html"), path.relative(site, file));
  }
});

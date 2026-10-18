// Assemble the Cloudflare Pages output for singitai.app.
//
// The live project publishes this directory (website/) with no compile step:
// index.html, _redirects, and _headers are Cloudflare Pages files, and
// docs/operations.md deploys the site by pushing to GitHub. Pages then
// rebuilds on its own. There is no wrangler config in the repo.
//
// Missing paths currently fall through to the landing HTML (dashboard SPA
// fallback). Pages serves a file that exists before that fallback, so
// robots.txt and sitemap.xml have to be in this publish root. This script
// copies that root into an output directory so a local check can see the
// same files the deploy publishes.

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || path.join(root, "dist"));
const skip = new Set(["dist", "tests", "build.mjs", "node_modules"]);

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    if (skip.has(name)) continue;
    const source = path.join(from, name);
    const target = path.join(to, name);
    if ((await stat(source)).isDirectory()) await copyTree(source, target);
    else await cp(source, target);
  }
}

await rm(out, { recursive: true, force: true });
await copyTree(root, out);
process.stdout.write(`${out}\n`);

// Unknown paths must get a real 404, not the landing HTML via the SPA fallback.
// Cloudflare Pages serves a top-level 404.html with status 404 when present,
// and walks up the path to the nearest 404.html otherwise - so the redirects
// that send /app and /app/* elsewhere have to stay ahead of anything else in
// _redirects (redirects run before static asset / 404 lookup on Pages).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const website = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("404.html exists at the publish root and is noindex", async () => {
  const html = await readFile(path.join(website, "404.html"), "utf8");
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<html lang="en">/);
});

test("build.mjs copies 404.html into the output", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "singit-pages-404-"));
  try {
    const built = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(website, "build.mjs"), out], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout)));
    });
    assert.equal(built, out);

    const copied = await stat(path.join(out, "404.html"));
    assert.ok(copied.isFile());
    const html = await readFile(path.join(out, "404.html"), "utf8");
    assert.match(html, /<meta name="robots" content="noindex">/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("/app and /app/* redirects still come before any other _redirects rule", async () => {
  const redirects = await readFile(path.join(website, "_redirects"), "utf8");
  const rules = redirects.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(rules.slice(0, 2), [
    "/app https://app.singitai.app/app/ 302",
    "/app/* https://app.singitai.app/app/:splat 302",
  ]);
});

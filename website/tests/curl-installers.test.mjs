// The curl installers are real extensionless files in the Pages publish root.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const website = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.dirname(website);
const NAMES = ["singit-cc-install", "singit-codex-install", "singit-openclaw-install"];

test("installer files exist, start with a bash shebang and are strict", async () => {
  for (const name of NAMES) {
    const text = await readFile(path.join(website, name), "utf8");
    assert.ok(text.startsWith("#!/usr/bin/env bash\n"), name);
    assert.match(text, /^set -euo pipefail$/m, name);
  }
});

test("installers install from npm by default, support a tarball, and set the 0.05 / 2 caps", async () => {
  for (const name of NAMES) {
    const text = await readFile(path.join(website, name), "utf8");
    assert.match(text, /npm i -g @singitai\/proxy/, name);
    assert.match(text, /SINGIT_PROXY_TARBALL/, name);
    assert.match(text, /SINGIT_MAX_PER_CALL_USD-0\.05/, name);
    assert.match(text, /SINGIT_MAX_PER_DAY_USD-2\b/, name);
    assert.doesNotMatch(text, /NOT LIVE|SINGIT_WALLET_KEY/, name);
    assert.doesNotMatch(text, /8402|8403|8517|wallet\.json/, name);
  }
});

test("install/*.sh are thin wrappers around the website scripts", async () => {
  for (const name of NAMES) {
    const text = await readFile(path.join(repo, "install", `${name}.sh`), "utf8");
    assert.match(text, new RegExp(`exec bash .*\\.\\./website/${name}"`), name);
    assert.ok(text.split("\n").length < 8, `${name}.sh should not carry its own logic`);
  }
});

test("build.mjs copies the installers into the publish output", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "singit-site-"));
  try {
    await promisify(execFile)(process.execPath, [path.join(website, "build.mjs"), out]);
    for (const name of NAMES) {
      const [built, source] = await Promise.all([readFile(path.join(out, name), "utf8"), readFile(path.join(website, name), "utf8")]);
      assert.equal(built, source);
      assert.ok((await stat(path.join(out, name))).isFile());
    }
  } finally { await rm(out, { recursive: true, force: true }); }
});

test("_headers pins the installer Content-Type and adds no catch-all", async () => {
  const headers = await readFile(path.join(website, "_headers"), "utf8");
  for (const name of NAMES) {
    assert.match(headers, new RegExp(`^/${name}\\n\\s+Content-Type: text/x-shellscript; charset=utf-8$`, "m"), name);
  }
  assert.doesNotMatch(headers, /^\/\*\s*$/m);
  const redirects = await readFile(path.join(website, "_redirects"), "utf8").catch(() => "");
  for (const name of NAMES) assert.ok(!redirects.includes(name), `${name} must not be redirected`);
  const sitemap = await readFile(path.join(website, "sitemap.xml"), "utf8");
  for (const name of NAMES) assert.ok(!sitemap.includes(name), `${name} must not be in the sitemap`);
});

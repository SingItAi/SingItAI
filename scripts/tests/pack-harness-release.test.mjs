// The packed proxy tarball must not carry monorepo file: paths, so `npm i -g` works on a clean machine.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "pack-harness-release.sh");

test("pack script writes an installable proxy tarball and an openclaw tarball", t => {
  const out = mkdtempSync(path.join(tmpdir(), "singit-pack-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  execFileSync("bash", [script, out], { stdio: "pipe" });
  const files = readdirSync(out).sort();
  assert.deepEqual(files, ["singitai-openclaw-0.1.0.tgz", "singitai-proxy-0.1.0.tgz"]);
  const tarball = path.join(out, "singitai-proxy-0.1.0.tgz");
  const manifest = JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }));
  assert.doesNotMatch(JSON.stringify(manifest), /file:\.\./);
  assert.deepEqual(manifest.bundleDependencies.sort(), ["@singitai/sdk", "@singitai/session-wallet"]);
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.match(entries, /package\/node_modules\/@singitai\/sdk\/package\.json/);
  assert.match(entries, /package\/node_modules\/@singitai\/session-wallet\/index\.js/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("manifest permits public publication with an explicit file allowlist", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.deepEqual(pkg.bin, { singit: "bin/singit.js" });
  assert.equal(pkg.name, "@singitai/sdk");
  assert.equal(Object.hasOwn(pkg, "private"), false);
  assert.equal(pkg.publishConfig.access, "public");
  assert.deepEqual(pkg.files, ["src", "index.d.ts", "README.md", "LICENSE", "bin"]);
});

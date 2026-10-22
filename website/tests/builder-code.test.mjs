import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// wallet.js imports browser-only modules, so load just the encoder.
function loadEncoder() {
  const s = fs.readFileSync(new URL("../app/wallet.js", import.meta.url), "utf8");
  const src = s.slice(s.indexOf("const ERC8021_MARKER"), s.indexOf("const BASE = {"));
  return new Function("window", `${src.replace("export function", "function")}; return baseBuilderCodeDataSuffix;`)({});
}

test("builder code suffix matches ox Attribution.toDataSuffix", () => {
  const encode = loadEncoder();
  // ox: Attribution.toDataSuffix({ codes: ["baseapp"] })
  assert.equal(encode("baseapp"), "0x62617365617070070080218021802180218021802180218021");
  assert.equal(encode("bc_test1234"), "0x62635f74657374313233340b0080218021802180218021802180218021");
});

test("empty or invalid builder code disables the suffix", () => {
  const encode = loadEncoder();
  assert.equal(encode(""), null);
  assert.equal(encode(undefined), null);
  assert.equal(encode("Not Valid!"), null);
});

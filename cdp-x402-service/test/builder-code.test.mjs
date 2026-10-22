import test from "node:test";
import assert from "node:assert/strict";

import {
  _resetForTests,
  loadBuilderCodeDataSuffix,
  walletClientOptions,
} from "../src/builder-code.mjs";

const ENV_KEY = "SIGN402_BASE_BUILDER_CODE";

test("a configured builder code produces a suffix ending in the attribution tail", async () => {
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = "bc_test1234";
  _resetForTests();
  try {
    const suffix = await loadBuilderCodeDataSuffix();
    assert.equal(typeof suffix, "string");
    assert.ok(suffix.toLowerCase().endsWith("80218021802180218021802180218021"));

    const options = await walletClientOptions({ account: "a", chain: "base" });
    assert.equal(options.dataSuffix, suffix);
    assert.equal(options.account, "a");
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
    _resetForTests();
  }
});

test("an unset builder code leaves the wallet client options unchanged", async () => {
  const previous = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  _resetForTests();
  try {
    const suffix = await loadBuilderCodeDataSuffix();
    assert.equal(suffix, null);

    const base = { account: "a", chain: "base" };
    const options = await walletClientOptions(base);
    assert.equal(options, base);
    assert.equal(options.dataSuffix, undefined);
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
    _resetForTests();
  }
});

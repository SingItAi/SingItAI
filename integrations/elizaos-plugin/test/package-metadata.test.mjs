import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("0.1.3 publish metadata: version, images and agentConfig", () => {
  assert.equal(pkg.version, "0.1.3");
  assert.ok(pkg.files.includes("images"));
  assert.equal(pkg.agentConfig.pluginType, "elizaos:plugin:1.0.0");
  const params = pkg.agentConfig.pluginParameters;
  assert.equal(params.SINGIT_API_KEY.sensitive, true);
  assert.equal(params.SINGIT_EVM_PRIVATE_KEY.sensitive, true);
  assert.equal(params.SINGIT_MAX_PER_CALL_USD.sensitive, false);
  assert.equal(params.SINGIT_MAX_PER_DAY_USD.sensitive, false);
  assert.ok(pkg.agentConfig.actions.includes("SINGIT_GET_PRICE"));
  assert.ok(pkg.agentConfig.providers.includes("SINGIT_TOOLS"));
  const logo = join(root, "images/logo.jpg");
  const banner = join(root, "images/banner.jpg");
  assert.ok(statSync(logo).size > 0 && statSync(logo).size <= 500 * 1024);
  assert.ok(statSync(banner).size > 0 && statSync(banner).size <= 1024 * 1024);
});

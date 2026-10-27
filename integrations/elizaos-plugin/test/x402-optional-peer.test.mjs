// @x402/evm is an optional peer dependency (its zod 3 dependency carries an npm advisory). These
// tests prove that without it, paid chat is not offered and, if invoked anyway, fails closed:
// no HTTP request, no signing, no payment.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatePrivateKey } from "viem/accounts";
import { payAskRequest } from "../src/x402/pay.js";
import { loadX402Scheme, isX402Available, X402_INSTALL_HINT } from "../src/x402/loader.js";
import { DailyLimiter, usdToAtomic, SingItPaymentError, BASE_PIN } from "../src/x402/guards.js";
import { singitPaidChatAction } from "../src/actions/paid-chat.js";
import { singitToolsProvider } from "../src/providers/singit-tools-provider.js";
import { startMockMerchant, uptoOffer } from "./helpers/mock-merchant.mjs";

const privateKey = generatePrivateKey();
const notFound = Object.assign(new Error("Cannot find package '@x402/evm'"), { code: "ERR_MODULE_NOT_FOUND" });
const missing = async () => { throw notFound; };
const makeRuntime = settings => ({ getSetting: key => (key in settings ? settings[key] : null) });

test("loadX402Scheme maps a missing package to the install hint, and rethrows other errors", async () => {
  await assert.rejects(loadX402Scheme("upto", missing), error => error instanceof SingItPaymentError && error.message === X402_INSTALL_HINT);
  const boom = new Error("syntax error in module");
  await assert.rejects(loadX402Scheme("exact", async () => { throw boom; }), error => error === boom);
  assert.equal(typeof (await loadX402Scheme("upto")), "function");
  assert.equal(typeof (await loadX402Scheme("exact")), "function");
  assert.equal(await isX402Available(), true);
  assert.equal(await isX402Available(missing), false);
});

test("payAskRequest without @x402/evm fails closed before any HTTP request", async () => {
  const merchant = await startMockMerchant({
    accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "9000", facilitatorAddress: "0x0000000000000000000000000000000000000002" })],
  });
  try {
    let fetches = 0;
    const limiter = new DailyLimiter(usdToAtomic(1));
    await assert.rejects(payAskRequest({
      body: { messages: [{ role: "user", content: "Hello" }] }, baseUrl: merchant.url,
      evmPrivateKey: privateKey, limiter, maxPerCallAtomic: usdToAtomic(0.01),
      importModule: missing, fetchImpl: (...args) => { fetches += 1; return fetch(...args); },
    }), /@x402\/evm/);
    assert.equal(fetches, 0);
    assert.equal(limiter.remainingAtomic(), BigInt(usdToAtomic(1)));
  } finally {
    await merchant.close();
  }
});

// A real missing-package run: the plugin source is copied next to a node_modules that has viem but
// no @x402/evm, then driven in a child process against a mock merchant that counts requests.
test("SINGIT_PAID_CHAT in a tree without @x402/evm: not offered, provider says so, handler fails closed", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(here, "..");
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "singit-no-x402-")));
  const merchant = await startMockMerchant({
    accepts: () => [uptoOffer({ asset: BASE_PIN.asset, payTo: BASE_PIN.payTo, amount: "9000", facilitatorAddress: "0x0000000000000000000000000000000000000002" })],
  });
  try {
    cpSync(path.join(pluginRoot, "src"), path.join(dir, "plugin", "src"), { recursive: true });
    writeFileSync(path.join(dir, "plugin", "package.json"), '{"type":"module"}');
    mkdirSync(path.join(dir, "plugin", "node_modules"), { recursive: true });
    symlinkSync(realpathSync(path.join(pluginRoot, "node_modules", "viem")), path.join(dir, "plugin", "node_modules", "viem"), "dir");
    const script = path.join(dir, "run.mjs");
    writeFileSync(script, `
      import { singitPaidChatAction as a } from ${JSON.stringify(pathToFileURL(path.join(dir, "plugin/src/actions/paid-chat.js")).href)};
      import { singitToolsProvider as p } from ${JSON.stringify(pathToFileURL(path.join(dir, "plugin/src/providers/singit-tools-provider.js")).href)};
      const s = { SINGIT_ASK_BASE_URL: ${JSON.stringify(merchant.url)}, SINGIT_EVM_PRIVATE_KEY: ${JSON.stringify(privateKey)},
        SINGIT_MAX_PER_CALL_USD: "0.01", SINGIT_MAX_PER_DAY_USD: "1" };
      const runtime = { getSetting: k => s[k] ?? null };
      const message = { content: { text: "ask singit ask: hi" } };
      const valid = await a.validate(runtime, message);
      const result = await a.handler(runtime, message, undefined, undefined, () => {});
      const prov = await p.get(runtime, message, undefined);
      console.log(JSON.stringify({ valid, result, prov }));
    `);
    const stdout = await new Promise((resolve, reject) => execFile(process.execPath, [script], { cwd: dir }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out))));
    const { valid, result, prov } = JSON.parse(stdout);
    assert.equal(valid, false);
    assert.equal(result.success, false);
    assert.equal(result.error, "missing_x402_evm");
    assert.match(result.text, /npm install @x402\/evm/);
    assert.deepEqual(prov.data.available, ["SINGIT_GET_PRICE", "SINGIT_LIST_PRICE_SYMBOLS", "SINGIT_LIST_MODELS"]);
    assert.equal(prov.data.hasX402Evm, false);
    assert.match(prov.text, /@x402\/evm is not installed/);
    assert.equal(merchant.requests.length, 0, "the merchant must not have been contacted");
    assert.doesNotMatch(stdout, new RegExp(privateKey.slice(2)));
  } finally {
    await merchant.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with @x402/evm installed (dev tree) the action is offered and the provider lists it", async () => {
  const runtime = makeRuntime({ SINGIT_EVM_PRIVATE_KEY: privateKey, SINGIT_MAX_PER_CALL_USD: "0.01", SINGIT_MAX_PER_DAY_USD: "1" });
  assert.equal(await singitPaidChatAction.validate(runtime, { content: { text: "ask singit ask: hi" } }), true);
  const { data } = await singitToolsProvider.get(runtime, {}, undefined);
  assert.equal(data.hasX402Evm, true);
  assert.ok(data.available.includes("SINGIT_PAID_CHAT"));
});

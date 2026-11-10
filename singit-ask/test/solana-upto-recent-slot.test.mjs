import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UptoSvmScheme } from "@x402/svm/upto/server";

// Reproduction of the 17:52 Prague upto failure: SingIt registered
// `new UptoSvmScheme({ withdrawDelay: 300 })` with no rpcUrl, so 402 extras omitted
// recentSlot. The official client then used getSlot() for openSlot; CDP verify used its
// own getSlot as challenged recentSlot and rejected
// "openSlot N+1 is ahead of challenged recentSlot N".

const FEE = "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu";
const AUTH = "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

test("UptoSvmScheme without rpcUrl does not stamp recentSlot (the production bug)", async () => {
  const scheme = new UptoSvmScheme({ withdrawDelay: 300 });
  assert.equal(scheme.rpcUrl, undefined);
  const out = await scheme.enhancePaymentRequirements(
    { scheme: "upto", network: SOLANA, asset: MINT, amount: "2006", maxTimeoutSeconds: 300, extra: {} },
    { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: FEE, receiverAuthorizer: AUTH } },
    [],
  );
  assert.equal(out.extra.recentSlot, undefined);
  assert.equal(out.extra.recentBlockhash, undefined);
  assert.equal(out.extra.receiverAuthorizer, AUTH);
  assert.equal(out.extra.withdrawDelay, 300);
});

test("server config and resource servers pass solanaRpcUrl into UptoSvmScheme", () => {
  const server = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(server, /solanaRpcUrl:\s*\(process\.env\.SINGIT_ASK_SOLANA_RPC_URL/);
  for (const file of ["metered.mjs", "formats.mjs"]) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.match(src, /createUptoSvmServerScheme\(\{\s*withdrawDelay:\s*300,\s*rpcUrl:\s*config\.solanaRpcUrl\s*\}\)/);
  }
});

test("UptoSvmScheme with rpcUrl stores it for enhancePaymentRequirements", () => {
  const scheme = new UptoSvmScheme({ withdrawDelay: 300, rpcUrl: "https://api.mainnet-beta.solana.com" });
  assert.equal(scheme.rpcUrl, "https://api.mainnet-beta.solana.com");
});

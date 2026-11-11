import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadWallet, loadOrCreateWallet, sessionPath, WalletError } from "../src/wallet.js";
import { connect, tempHome } from "./helpers/client.mjs";

const noFetch = () => { throw new Error("unit tests must not touch the network"); };
const storedKey = home => JSON.parse(readFileSync(path.join(home, "session"), "utf8")).privateKey;

test("creates the wallet file 0600 in a 0700 directory and loads the same address afterwards", t => {
  const env = { SINGIT_HOME: tempHome(t) };
  assert.equal(loadWallet(env), null);
  const first = loadOrCreateWallet(env);
  assert.equal(first.created, true);
  assert.match(first.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(statSync(sessionPath(env)).mode & 0o777, 0o600);
  assert.equal(statSync(env.SINGIT_HOME).mode & 0o777, 0o700);
  const second = loadOrCreateWallet(env);
  assert.equal(second.created, false);
  assert.equal(second.address, first.address);
  assert.equal(loadWallet(env).address, first.address);
});

test("a wallet object does not serialize its private key", t => {
  const env = { SINGIT_HOME: tempHome(t) };
  const created = loadOrCreateWallet(env);
  const key = storedKey(env.SINGIT_HOME);
  assert.equal(created.wallet.privateKey, key);
  assert.equal(JSON.stringify(created).includes(key.slice(2)), false);
  assert.equal(JSON.stringify(loadWallet(env)).includes(key.slice(2)), false);
});

test("SINGIT_WALLET_KEY wins over the file and writes nothing", t => {
  const home = tempHome(t);
  const fileWallet = loadOrCreateWallet({ SINGIT_HOME: home });
  const key = generatePrivateKey();
  const fromEnv = loadOrCreateWallet({ SINGIT_HOME: home, SINGIT_WALLET_KEY: key });
  assert.equal(fromEnv.address, privateKeyToAccount(key).address);
  assert.equal(fromEnv.source, "env");
  assert.notEqual(fromEnv.address, fileWallet.address);
  assert.equal(loadWallet({ SINGIT_HOME: home }).address, fileWallet.address); // file untouched

  const fresh = tempHome(t);
  loadOrCreateWallet({ SINGIT_HOME: fresh, SINGIT_WALLET_KEY: key });
  assert.equal(existsSync(fresh), false);
});

test("a malformed SINGIT_WALLET_KEY is refused without echoing it", t => {
  const bad = "0xnot-a-key-do-not-echo";
  assert.throws(() => loadWallet({ SINGIT_HOME: tempHome(t), SINGIT_WALLET_KEY: bad }),
    error => error instanceof WalletError && !error.message.includes(bad));
});

test("a damaged wallet file is an error and is never overwritten", t => {
  const env = { SINGIT_HOME: tempHome(t) };
  loadOrCreateWallet(env);
  writeFileSync(sessionPath(env), "{ not json");
  assert.throws(() => loadOrCreateWallet(env), WalletError);
  assert.equal(readFileSync(sessionPath(env), "utf8"), "{ not json");
});

test("singit_wallet: status does not create, setup creates, and neither echoes the key", async t => {
  const env = { SINGIT_HOME: tempHome(t) };
  const { call } = await connect(t, { env, fetchImpl: noFetch });

  const before = await call("singit_wallet"); // action defaults to "status"
  assert.equal(before.data.walletExists, false);
  assert.equal(existsSync(sessionPath(env)), false);

  const setup = await call("singit_wallet", { action: "setup" });
  assert.equal(setup.isError, false);
  assert.equal(setup.data.created, true);
  assert.equal(setup.data.network, "eip155:8453");
  assert.match(setup.data.funding, /USDC on Base/);
  assert.ok(setup.data.funding.includes(setup.data.address));
  assert.deepEqual(setup.data.limits, { maxPerCallUsd: 0.5, maxPerDayUsd: 5 });

  const status = await call("singit_wallet", { action: "status" });
  assert.equal(status.data.walletExists, true);
  assert.equal(status.data.address, setup.data.address);

  const again = await call("singit_wallet", { action: "setup" });
  assert.equal(again.data.created, false);
  assert.equal(again.data.address, setup.data.address);

  const key = storedKey(env.SINGIT_HOME).slice(2).toLowerCase();
  for (const result of [before, setup, status, again]) assert.equal(result.raw.toLowerCase().includes(key), false);
});

test("singit_wallet with SINGIT_WALLET_KEY reports that address and never the key", async t => {
  const key = generatePrivateKey();
  const env = { SINGIT_HOME: tempHome(t), SINGIT_WALLET_KEY: key };
  const { call } = await connect(t, { env, fetchImpl: noFetch });
  const status = await call("singit_wallet", { action: "setup" });
  assert.equal(status.data.address, privateKeyToAccount(key).address);
  assert.equal(status.data.keySource, "SINGIT_WALLET_KEY");
  assert.equal(status.raw.toLowerCase().includes(key.slice(2).toLowerCase()), false);
  assert.equal(existsSync(env.SINGIT_HOME), false);
});

test("limits come from SINGIT_MAX_PER_CALL_USD / SINGIT_MAX_PER_DAY_USD and bad values fail at startup", async t => {
  const env = { SINGIT_HOME: tempHome(t), SINGIT_MAX_PER_CALL_USD: "0.02", SINGIT_MAX_PER_DAY_USD: "1" };
  const { call } = await connect(t, { env, fetchImpl: noFetch });
  assert.deepEqual((await call("singit_wallet", { action: "setup" })).data.limits, { maxPerCallUsd: 0.02, maxPerDayUsd: 1 });
  const { createServer } = await import("../src/server.js");
  assert.throws(() => createServer({ env: { SINGIT_MAX_PER_DAY_USD: "lots" } }), /SINGIT_MAX_PER_DAY_USD/);
});

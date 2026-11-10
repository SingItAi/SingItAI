// The local wallet: one EVM private key for Base, generated on first use and kept in
// ~/.singit/session (0600, directory 0700). The key is read here and handed to @singitai/sdk to sign
// x402 payments; nothing in this package prints, logs or returns it.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const NETWORK = "eip155:8453";
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export class WalletError extends Error {}

export const sessionDir = (env = process.env) => env.SINGIT_HOME || path.join(os.homedir(), ".singit");
export const sessionPath = (env = process.env) => path.join(sessionDir(env), "session");

// privateKey is non-enumerable so a stray JSON.stringify or console.log of a wallet cannot leak it.
function wallet(privateKey, source, file) {
  const account = privateKeyToAccount(privateKey);
  return Object.defineProperty({ address: account.address, network: NETWORK, source, ...(file ? { path: file } : {}) },
    "privateKey", { value: privateKey, enumerable: false });
}

/** The wallet from SINGIT_WALLET_KEY, else from the session file, else null. Never creates one. */
export function loadWallet(env = process.env) {
  if (env.SINGIT_WALLET_KEY) {
    if (!PRIVATE_KEY.test(env.SINGIT_WALLET_KEY)) {
      throw new WalletError("SINGIT_WALLET_KEY must be a 0x-prefixed 32-byte hex private key.");
    }
    return wallet(env.SINGIT_WALLET_KEY, "env");
  }
  const file = sessionPath(env);
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new WalletError(`Could not read the wallet file ${file} (${error.code}).`);
  }
  let privateKey;
  try { privateKey = JSON.parse(raw)?.privateKey; } catch { /* reported below */ }
  if (typeof privateKey !== "string" || !PRIVATE_KEY.test(privateKey)) {
    // Never regenerate over a file that may still hold a funded key.
    throw new WalletError(`The wallet file ${file} is not a valid SingIt session; move it away to create a new wallet.`);
  }
  return wallet(privateKey, "file", file);
}

/** loadWallet(), creating and persisting a fresh key when there is none. */
export function loadOrCreateWallet(env = process.env) {
  const existing = loadWallet(env);
  if (existing) return { ...describe(existing), wallet: existing, created: false };
  const dir = sessionDir(env);
  const file = sessionPath(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const privateKey = generatePrivateKey();
  const created = wallet(privateKey, "file", file);
  const session = { version: 1, network: NETWORK, address: created.address, privateKey, createdAt: new Date().toISOString() };
  try {
    // "wx": never overwrite. If another process created the wallet first, use theirs.
    writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw new WalletError(`Could not write the wallet file ${file} (${error.code}).`);
    const theirs = loadWallet(env);
    return { ...describe(theirs), wallet: theirs, created: false };
  }
  chmodSync(file, 0o600); // the mode above is subject to umask; make it exact
  return { ...describe(created), wallet: created, created: true };
}

function describe(w) {
  return { address: w.address, network: w.network, source: w.source };
}

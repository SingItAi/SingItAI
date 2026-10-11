import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// Run the real watchAppKit against a fake AppKit; no Reown, no wallet.
const source = readFileSync(new URL("../app/wallet.js", import.meta.url), "utf8");
const from = source.indexOf("export async function watchAppKit(");
const to = source.indexOf("\n}\n", from) + 3;
assert.ok(from >= 0 && to > from);
const code = source.slice(from, to).replace("export async function", "async function")
  + "\nglobalThis.watchAppKit = watchAppKit;";

async function setup() {
  const kit = { open: true, closes: 0, isOpen() { return this.open; }, close() { this.closes++; },
    subscribeAccount(cb) { this.emit = cb; } };
  const seen = [];
  const context = vm.createContext({
    appKit: async () => kit,
    kitWallet: (_k, account) => ({ address: account.address }),
  });
  vm.runInContext(code, context);
  await context.watchAppKit((wallet) => seen.push(wallet && wallet.address));
  return { kit, seen };
}

test("more events for the same account leave the modal open for its signature", async () => {
  const { kit, seen } = await setup();
  // A Google sign-in: connected, then the network and the balance arrive for the same address.
  for (let i = 0; i < 3; i++) kit.emit({ isConnected: true, address: "0x3937" });
  assert.equal(kit.closes, 1);
  assert.deepEqual(seen, ["0x3937", "0x3937", "0x3937"]);
});

test("a new account closes the modal again, and so does reconnecting after a disconnect", async () => {
  const { kit, seen } = await setup();
  kit.emit({ isConnected: true, address: "0xaaaa" });
  kit.emit({ isConnected: true, address: "0xbbbb" });
  kit.emit({ isConnected: false, status: "disconnected" });
  kit.emit({ isConnected: true, address: "0xbbbb" });
  assert.equal(kit.closes, 3);
  assert.deepEqual(seen, ["0xaaaa", "0xbbbb", null, "0xbbbb"]);
});

test("a restored session with the modal closed never calls close()", async () => {
  // close() makes AppKit load its views; before its Reown settings arrive that skips the email/Google
  // wallet's signature view for good. A reconnect on page load must leave the closed modal alone.
  const { kit, seen } = await setup();
  kit.open = false;
  kit.emit({ isConnected: true, address: "0x3d00" });
  assert.equal(kit.closes, 0);
  assert.deepEqual(seen, ["0x3d00"]);
});

const readyCode = source.slice(source.indexOf("export function kitReady("), source.indexOf("export async function openAppKit"))
  .replace("export function", "function") + "\nglobalThis.kitReady = kitReady;";

test("opening waits until AppKit has its settings, and does not wait once it has them", async () => {
  const context = vm.createContext({});
  vm.runInContext(readyCode, context);
  let listener = null, stopped = false;
  const kit = { state: { initialized: false }, getState() { return this.state; },
    subscribeState(cb) { listener = cb; return () => { stopped = true; }; } };
  let opened = false;
  const waiting = context.kitReady(kit).then(() => { opened = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(opened, false);
  listener({ initialized: false });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(opened, false);
  listener({ initialized: true });
  await waiting;
  assert.equal(opened, true);
  assert.equal(stopped, true);
  kit.state.initialized = true;
  await context.kitReady(kit);  // ready: resolves at once
});

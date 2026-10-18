import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// Run the real switch markup and its button handler from main.js; no AppKit, no wallet.
const source = readFileSync(new URL("../app/main.js", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const choice = section("function networkChoice() {", "function renderHero() {");
const handler = section('"sign-in-network": async (el) => {', "\n  },\n").replace('"sign-in-network": ', "") + "\n  }";

function setup(wallet, switchImpl = async (chain) => ({ name: "WalletConnect", chain, address: "new-account" })) {
  const calls = [], toasts = [];
  const context = vm.createContext({
    state: { wallet },
    networkSwitching: false, signingIn: false, render() {},
    setWallet: (wallet) => { context.state.wallet = wallet; },
    switchAppKitNetwork: async (chain) => { calls.push(chain); return switchImpl(chain); },
    toast: (message, error) => toasts.push([message, error]),
    explain: (error) => error.message,
  });
  vm.runInContext(choice + "\nglobalThis.press = " + handler + ";", context);
  return { context, calls, toasts };
}

test("a wallet connected through AppKit can pick Base or Solana before signing in", () => {
  const onBase = setup({ name: "WalletConnect", chain: "base", address: "0x3937" }).context.networkChoice();
  assert.match(onBase, /data-chain="base"\s+class="on" aria-pressed="true"\s*>Base/);
  assert.match(onBase, /data-chain="solana"\s+class="" aria-pressed="false"\s*>Solana/);
  const onSolana = setup({ name: "WalletConnect", chain: "solana", address: "3dTW" }).context.networkChoice();
  assert.match(onSolana, /data-chain="solana"\s+class="on" aria-pressed="true"\s*>Solana/);
});

test("a wallet extension, or no wallet, gets no switch", () => {
  assert.equal(setup({ name: "Phantom", chain: "solana", address: "3dTW" }).context.networkChoice(), "");
  assert.equal(setup(null).context.networkChoice(), "");
});

test("pressing the other network switches AppKit; the current one does nothing", async () => {
  const { context, calls } = setup({ name: "WalletConnect", chain: "base", address: "0x3937" });
  await context.press({ dataset: { chain: "base" } });
  await context.press({ dataset: { chain: "solana" } });
  assert.deepEqual(calls, ["solana"]);
  assert.equal(context.state.wallet.chain, "solana");
});

test("a switch the wallet refuses is shown, not swallowed", async () => {
  const { context, toasts } = setup({ name: "WalletConnect", chain: "base", address: "0x3937" },
    async () => { throw new Error("This wallet has no Solana account."); });
  await context.press({ dataset: { chain: "solana" } });
  assert.deepEqual(toasts, [["This wallet has no Solana account.", true]]);
  assert.equal(context.state.wallet.chain, "base");
});

test("a new social connection waits for network choice and an explicit sign-in", async () => {
  const state = { wallet: null, session: null };
  const nonces = [];
  const context = vm.createContext({ state, window: { addEventListener() {} }, location: { reload() {} },
    render() {}, appKitConfigured: () => true, openAppKit: async () => {}, toast() {}, explain: String,
    busy: async (_text, task) => task(), setCsrf() {}, getUtm: () => ({}),
    api: { nonce: async (address) => { nonces.push(address); return { message: "test-only sign-in" }; },
      verify: async () => ({ account: "solana:SolanaAddress", address: "SolanaAddress", chain: "solana", csrfToken: "test" }) },
    loadAllowance: async () => {}, loadChats: async () => {}, loadModels: async () => {},
  });
  vm.runInContext(section("let networkSwitching =", "async function signOut()"), context);
  context.connectWallet();
  context.setWallet({ name: "WalletConnect", chain: "base", address: "0x123" });
  assert.deepEqual(nonces, [], "connection must not immediately sign on Base");
  context.setWallet({ name: "WalletConnect", chain: "solana", address: "SolanaAddress", signMessage: async () => "signature" });
  await context.signIn();
  assert.deepEqual(nonces, ["SolanaAddress"]);
  assert.equal(state.session.chain, "solana");
});

test("the real SDK wrapper opts into thrown switch failures and requires the selected account", async () => {
  const walletSource = readFileSync(new URL("../app/wallet.js", import.meta.url), "utf8");
  const start = walletSource.indexOf("export async function switchAppKitNetwork(");
  const end = walletSource.indexOf("// AppKit picks", start);
  const base = { id: 8453 }, solana = { id: "solana-mainnet", chainNamespace: "solana" };
  let active = base, account = { isConnected: true, address: "0x1", caipAddress: "eip155:8453:0x1" };
  let refuses = true;
  const kit = { getCaipNetwork: () => active, getAccount: () => account,
    async switchNetwork(network, { throwOnFailure = false } = {}) {
      if (refuses) { if (throwOnFailure) throw new Error("Switch refused"); return; }
      active = { ...network, chainNamespace: network.chainNamespace || "eip155" };
    } };
  const context = vm.createContext({ appKit: async () => kit, kitReady: async () => {}, kitNetworks: { base, solana }, kitWallet: (_k, a) => a });
  vm.runInContext(walletSource.slice(start, end).replace("export ", ""), context);
  await assert.rejects(context.switchAppKitNetwork("solana"), /Switch refused/);
  refuses = false;
  await assert.rejects(context.switchAppKitNetwork("solana"), /no connected Solana account/);
  account = { isConnected: true, address: "SolanaAddress", caipAddress: "solana:solana-mainnet:SolanaAddress" };
  assert.equal((await context.switchAppKitNetwork("solana")).address, "SolanaAddress");
  account = { isConnected: true, address: "0x1", caipAddress: "eip155:8453:0x1" };
  assert.equal((await context.switchAppKitNetwork("base")).address, "0x1");
});

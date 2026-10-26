import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../app/main.js", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} .. ${end}`);
  return source.slice(from, to);
}

const presets = section("const PRESETS = [", "const esc =");
const helpers = section("const esc =", "function amount(");
const views = section("function renderSetup(heading) {", "function renderStale(");
const tracked = [];
const context = vm.createContext({ state: { preset: 0, allowance: null }, track: (name, props) => tracked.push([name, props]) });
vm.runInContext(`${presets}\n${helpers}\n${views}`, context);

test("an unconfigured Solana account does not get the Base contract guarantee", () => {
  context.state.allowance = { chain: "solana", configured: false, supported: true };
  const html = context.renderAllowance();
  assert.match(html, /Solana enforces the total you approve/);
  assert.match(html, /SingIt enforces the daily and per-purchase limits/);
  assert.match(html, /deploys no contract/);
  assert.match(html, /Save my limits/);
  assert.doesNotMatch(html, /even if our server/);
  assert.doesNotMatch(html, /contract on Base/);
  assert.doesNotMatch(html, /Creating your limiter on Base/);
});

test("Solana with the lane off still says limits are coming", () => {
  context.state.allowance = { chain: "solana", configured: false, supported: false, text: "Soon." };
  const html = context.renderAllowance();
  assert.match(html, /Limits on Solana are/);
  assert.match(html, /Soon\./);
  assert.doesNotMatch(html, /contract on Base/);
});

test("an unconfigured Base account still describes the on-chain limiter", () => {
  context.state.allowance = { chain: "base", configured: false };
  const html = context.renderAllowance();
  assert.match(html, /even if our server or the agent is compromised/);
  assert.match(html, /A small contract on Base/);
  assert.match(html, /Create my limiter/);
});

test("saving Solana limits does not say a Base contract is being created", () => {
  const fn = section("async function createLimiter() {", "function hasGas() {");
  assert.match(fn, /state\.session\?\.chain === "solana"/);
  assert.match(fn, /Saving your limits\./);
  assert.match(fn, /Limits saved\. Now approve them in your wallet\./);
});

// The configured Solana page: the approval defaults to, and is capped at, the daily limit.
const solanaPage = (() => {
  const money = section("const esc =", "function atomicFromUsdc(");
  const parse = section("function atomicFromUsdc(", "\n}\n") + "\n}\n";
  const today = section("function spendableToday(a) {", "\n}\n") + "\n}\n";
  const page = section("function renderSolanaAllowance(a) {", "// Solana setup saves limits");
  const grantFn = section("function grant() {", "async function pause() {");
  const ctx = vm.createContext({ state: { allowance: null, spend30: null }, calls: [], toasts: [], inputValue: "" });
  vm.runInContext(`${money}\n${parse}\n${today}\nconst last30Line = () => "";\n${page}\n${grantFn}
    function $() { return { value: inputValue }; }
    function toast(text, bad) { toasts.push([text, bad]); }
    function method() { return "approve"; }
    function walletOperation(kind, body) { calls.push([kind, body]); }`, ctx);
  return ctx;
})();
const sol = (over) => ({ chain: "solana", configured: true, state: "waiting_for_grant", limiter: "AgentDelegate1111",
  dailyCapAtomic: 20000000, perPurchaseCapAtomic: 5000000, remainingTodayAtomic: 20000000, allowanceAtomic: 0,
  ownerUsdcAtomic: 50000000, ownerSolLamports: "7000000", ...over });

test("Solana: the approval defaults to the daily limit and says why", () => {
  const html = solanaPage.renderSolanaAllowance(sol({ dailyCapAtomic: 1500000000, remainingTodayAtomic: 1500000000 }));
  assert.match(html, /id="grant-amount"[^>]*\n?\s*value="1500"/);  // no thousands comma in the input
  assert.match(html, /capped at your daily limit/);
  assert.match(html, /does not refill on its own/);
  assert.doesNotMatch(html, /on-chain daily/i);
});

test("Solana: a granted approval at the daily limit shows no approve button", () => {
  const html = solanaPage.renderSolanaAllowance(sol({ state: "granted", allowanceAtomic: 20000000 }));
  assert.doesNotMatch(html, /data-action="grant"/);
  assert.match(html, /Pause the agent/);
});

test("Solana: a used-up part can be approved again, back to the daily limit", () => {
  const html = solanaPage.renderSolanaAllowance(sol({ state: "granted", allowanceAtomic: 7500000 }));
  assert.match(html, /7\.5 USDC of your approval is left/);
  assert.match(html, /Approve again/);
  assert.match(html, /value="20"/);
});

test("Solana: an approval above a lowered daily limit asks to approve again", () => {
  const html = solanaPage.renderSolanaAllowance(sol({ state: "granted", dailyCapAtomic: 8000000, allowanceAtomic: 20000000 }));
  assert.match(html, /still approves 20 USDC, more than your\s+8 USDC daily limit/);
  assert.match(html, /Approve again/);
  assert.doesNotMatch(html, /even if our server misbehaved/);  // not true while the wallet approves more
});

test("Solana: a paused account with an oversized approval is warned, not reassured", () => {
  const html = solanaPage.renderSolanaAllowance(sol({ state: "paused", dailyCapAtomic: 8000000, allowanceAtomic: 20000000 }));
  assert.match(html, /still approves 20 USDC/);
  assert.match(html, /or revoke it/);
  assert.doesNotMatch(html, /even if our server misbehaved/);
  assert.match(html, /data-action="grant"/);
});

test("Solana: grant() refuses more than the daily limit before the wallet opens", () => {
  solanaPage.state.allowance = sol({});
  solanaPage.calls.length = 0; solanaPage.toasts.length = 0;
  solanaPage.inputValue = "20.01";
  solanaPage.grant();
  assert.equal(solanaPage.calls.length, 0);
  assert.match(solanaPage.toasts[0][0], /capped at your daily limit, 20 USDC/);
  solanaPage.inputValue = "20";
  solanaPage.grant();
  assert.equal(JSON.stringify(solanaPage.calls), JSON.stringify([["grant", { amount: "20", method: "approve" }]]));
  solanaPage.state.allowance = { ...sol({}), chain: "base" };  // Base keeps its own contract limits
  solanaPage.inputValue = "50";
  solanaPage.grant();
  assert.equal(solanaPage.calls.length, 2);
});

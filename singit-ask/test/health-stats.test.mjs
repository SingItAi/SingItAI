import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthStats, FacilitatorCheck, numbersBody, healthBody,
  HOUR, PAYER_CAP, BUCKET_PAYER_CAP } from "../src/health-stats.mjs";
const BASE = "eip155:8453";
const payer = "0x" + "A".repeat(40), own = "0x" + "B".repeat(40);
const settle = (s, extra = {}) => s.recordSettlement({ route: "/public", network: BASE,
  ok: true, amount: "1000", payer, ...extra });
test("model transitions, caller faults and window expiry", () => {
  let now = Date.UTC(2026, 9, 30);
  const s = new HealthStats({ now: () => now });
  s.recordModel("text", { ok: true }); assert.equal(s.models().text.status, "up");
  s.recordModel("text", { ok: false, status: 400 });
  s.recordModel("text", { ok: false, status: 413 });
  s.recordModel("text", { ok: false, status: 422 });
  s.recordModel("text", { ok: false, code: "max_tokens_spent_reasoning" });
  assert.equal(s.models().text.failures, 0);
  s.recordModel("text", { ok: false }); assert.equal(s.models().text.status, "degraded");
  s.recordModel("text", { ok: false }); assert.equal(s.models().text.status, "down");
  assert.equal(s.models().text.errorRatePct, 66.7);
  now += 24 * HOUR; assert.deepEqual(s.models(), {});
});
test("real volumes, own exclusions, internal rails, dedupe and windows", () => {
  let now = Date.UTC(2026, 9, 30);
  const s = new HealthStats({ now: () => now, ownPayers: [own], isPublicRoute: r => r === "/public" });
  settle(s); settle(s, { payer: payer.toLowerCase(), amount: undefined });
  settle(s, { payer: own.toLowerCase() }); settle(s, { route: "/internal" }); settle(s, { ok: false });
  const n = numbersBody(s);
  assert.equal(n.paid_calls.total, 2); assert.equal(n.usdc_volume.total, 0.001);
  assert.equal(n.usdc_volume.calls_without_amount, 1); assert.equal(n.own_payments_excluded, 1);
  assert.deepEqual(n.unique_payers, { total: 1, last_24h: 1, last_7d: 1 });
  assert.equal(s.rails().base.settled, 4); assert.equal(s.rails().base.failed, 1);
  assert.equal(healthBody(s, null, "text").payments.networks.base.status, "degraded");
  assert.ok(!JSON.stringify(n).includes(payer)); assert.ok(!JSON.stringify(healthBody(s, null)).includes(own));
  now += 25 * HOUR;
  assert.equal(numbersBody(s).unique_payers.last_24h, 0);
  assert.equal(numbersBody(s).unique_payers.last_7d, 1);
  now += 7 * 24 * HOUR; assert.equal(numbersBody(s).unique_payers.last_7d, 0);
});
test("private persistence, round trip and corrupt input", t => {
  const dir = mkdtempSync(join(tmpdir(), "health-stats-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "stats.json"), s = new HealthStats({ file });
  settle(s); s.flush();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file, "utf8").includes(payer));
  assert.deepEqual(new HealthStats({ file }).numbers(), s.numbers());
  writeFileSync(file, "broken"); assert.equal(new HealthStats({ file }).numbers().total.calls, 0);
  writeFileSync(file, JSON.stringify({ buckets: [] }));
  assert.equal(new HealthStats({ file }).numbers().total.calls, 0);
});
test("unique caps report unavailable and model count is bounded", () => {
  const s = new HealthStats();
  for (let i = 0; i <= PAYER_CAP; i++) settle(s, { payer: `payer-${i}` });
  assert.equal(s.state.payers.length, PAYER_CAP);
  assert.equal(Object.values(s.state.buckets)[0].payers.length, BUCKET_PAYER_CAP);
  assert.equal(numbersBody(s).unique_payers.total, null);
  assert.equal(numbersBody(s).unique_payers.last_24h, null);
  for (let i = 0; i < 310; i++) s.recordModel(`text-${i}`, { ok: true });
  assert.equal(Object.keys(s.state.models).length, 300); assert.equal(Object.keys(s.models()).length, 50);
});
const tick = () => new Promise(resolve => setImmediate(resolve));
test("facilitator cache is background, guarded, read only and expires", async () => {
  let count = 0, now = 1000;
  const c = new FacilitatorCheck({ now: () => now, client: { getSupported: async () => {
    count++; return { kinds: [{ network: BASE }] };
  } } });
  assert.equal(c.get(), null); c.get(); await tick();
  assert.equal(count, 1); assert.equal(c.get().networks.base, true); assert.equal(c.get().networks.solana, false);
  now += 300001; c.get(); await tick(); assert.equal(count, 2);
  const bad = new FacilitatorCheck({ client: { getSupported() { throw new Error("private"); } } });
  bad.get(); await tick(); assert.equal(bad.get().reachable, false);
  assert.equal(new FacilitatorCheck({ client: {} }).get(), null);
  const hang = new FacilitatorCheck({ timeoutMs: 5, client: { getSupported: () => new Promise(() => {}) } });
  hang.get(); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(hang.get().reachable, false);
});

test("unusual model ids, failed writes and unexpected state remain safe", t => {
  const s = new HealthStats();
  s.recordModel("constructor", { ok: true }); s.recordModel("__proto__", { ok: false });
  assert.equal(s.models().constructor.successes, 1); assert.equal(s.models().__proto__.failures, 1);
  const dir = mkdtempSync(join(tmpdir(), "stats-failure-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let logs = 0;
  const bad = new HealthStats({ file: dir, log: code => { assert.equal(typeof code, "string"); logs++; } });
  settle(bad); bad.flush(); bad.flush(); assert.equal(logs, 1);
  const file = join(dir, "malformed.json");
  writeFileSync(file, JSON.stringify({ ...s.state, buckets: { bad: { models: null } } }));
  const fresh = new HealthStats({ file }); assert.deepEqual(fresh.models(), {});
});

test("rail health uses supported networks before settlement rates", () => {
  const s = new HealthStats();
  assert.equal(healthBody(s, null).payments.networks.base.status, "unknown");
  assert.equal(healthBody(s, { reachable: false, networks: {} }).status, "degraded");
  assert.equal(healthBody(s, { reachable: true, networks: { base: false, solana: false } }).status, "down");
  settle(s); settle(s, { ok: false }); settle(s, { ok: false });
  assert.equal(healthBody(s, null).payments.networks.base.status, "down");
  assert.equal(healthBody(s, { reachable: true, networks: { base: false, solana: true } })
    .payments.networks.base.basis, "facilitator");
});

test("Solana and other rails, invalid amounts and retained lifetime totals", () => {
  let now = Date.UTC(2026, 9, 30, 10, 12, 59);
  const s = new HealthStats({ now: () => now });
  const solana = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  settle(s, { network: solana, amount: 0 });
  for (const amount of [-1, 0.5, "-1", "1.2", "0x10", undefined]) settle(s, { amount });
  settle(s, { network: "unknown", ok: false });
  assert.equal(s.rails().solana.settled, 1);
  assert.equal(s.rails().solana.lastSettledAt, "2026-10-30T10:12:00.000Z");
  assert.equal(numbersBody(s).usdc_volume.calls_without_amount, 6);
  assert.equal(numbersBody(s).settlement_failures.last_24h, 1);
  now += 31 * 24 * HOUR; settle(s, { amount: "1000000" });
  assert.equal(Object.keys(s.state.buckets).length, 1);
  assert.equal(numbersBody(s).paid_calls.total, 8);
  assert.equal(numbersBody(s).paid_calls.last_7d, 1);
  assert.equal(s.rails().solana.lastSettledAt, null);
});

test("fresh counters are measured zeros and hashes never leave aggregate responses", () => {
  const s = new HealthStats();
  assert.deepEqual(numbersBody(s).unique_payers, { total: 0, last_24h: 0, last_7d: 0 });
  assert.equal(numbersBody(s).paid_calls.total, 0);
  settle(s);
  const output = JSON.stringify([numbersBody(s), healthBody(s, null)]);
  for (const hash of s.state.payers) assert.ok(!output.includes(hash));
});

test("a newer failed facilitator probe degrades previously successful rails", () => {
  let now = Date.UTC(2026, 9, 30);
  const s = new HealthStats({ now: () => now });
  settle(s);
  settle(s, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
  now += 1000;
  const check = { reachable: false, networks: {}, checkedAt: new Date(now).toISOString() };
  const health = healthBody(s, check);
  assert.equal(health.status, "degraded");
  for (const rail of Object.values(health.payments.networks)) {
    assert.equal(rail.status, "degraded"); assert.equal(rail.basis, "facilitator");
  }
  now += 1000;
  settle(s);
  assert.equal(healthBody(s, check).payments.networks.base.status, "up");
  assert.equal(healthBody(s, check).payments.networks.base.basis, "settlements");
});

test("a failed facilitator probe preserves worse or equal settlement health", () => {
  let now = Date.UTC(2026, 9, 30);
  const s = new HealthStats({ now: () => now });
  const networks = [BASE, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"];
  for (const network of networks) settle(s, { network, ok: false });
  now += 1000;
  const check = { reachable: false, networks: {}, checkedAt: new Date(now).toISOString() };
  const degraded = healthBody(s, check);
  assert.equal(degraded.status, "degraded");
  for (const rail of Object.values(degraded.payments.networks)) {
    assert.equal(rail.status, "degraded"); assert.equal(rail.basis, "settlements");
  }
  for (const network of networks) {
    settle(s, { network, ok: false }); settle(s, { network, ok: false });
  }
  const down = healthBody(s, check);
  assert.equal(down.status, "down");
  for (const rail of Object.values(down.payments.networks)) {
    assert.equal(rail.status, "down"); assert.equal(rail.basis, "settlements");
    assert.equal(rail.failed, 3);
  }
});

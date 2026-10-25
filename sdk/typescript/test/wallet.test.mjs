import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generatePrivateKey } from "viem/accounts";
import { SingIt } from "../src/index.js";

const addr = suffix => `0x${"0".repeat(40 - suffix.length)}${suffix}`;
const PAY_TO = addr("ab1e");
const privateKey = generatePrivateKey();

function startJsonServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(r => server.close(r)),
    }));
  });
}

test("walletReport() parses a reconciliation document and allowance() reads its allowance field", async () => {
  const address = addr("f00d");
  const app = await startJsonServer((req, res) => {
    assert.equal(req.url, `/v1/wallet/${address}/reconciliation?days=7`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ address, allowance: { limitUsd: 5, spentTodayUsd: 1.2, remainingUsd: 3.8 }, entries: [] }));
  });
  try {
    const singit = new SingIt({ evmPrivateKey: privateKey, network: "base", payTo: PAY_TO,
      appBaseUrl: app.url, maxPerCallUsd: 0.01, maxPerDayUsd: 1 });
    const report = await singit.walletReport(address, { days: 7 });
    assert.equal(report.address, address);
    const allowance = await singit.allowance(address, { days: 7 });
    assert.equal(allowance.limitUsd, 5);
    assert.equal(allowance.remainingUsd, 3.8);
  } finally {
    await app.close();
  }
});

test("walletReport() reports clearly when the reconciliation endpoint is not deployed (404)", async () => {
  const app = await startJsonServer((req, res) => { res.writeHead(404).end(); });
  try {
    const singit = new SingIt({ evmPrivateKey: privateKey, network: "base", payTo: PAY_TO,
      appBaseUrl: app.url, maxPerCallUsd: 0.01, maxPerDayUsd: 1 });
    await assert.rejects(singit.walletReport(addr("f00d")), /SI-67/);
  } finally {
    await app.close();
  }
});

test("pricing() parses pricing.json", async () => {
  const ask = await startJsonServer((req, res) => {
    assert.equal(req.url, "/pricing.json");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "deepseek-v4.1-flash", maxChargeAtomic: "3000" }));
  });
  try {
    const singit = new SingIt({ evmPrivateKey: privateKey, network: "base", payTo: PAY_TO,
      baseUrl: ask.url, maxPerCallUsd: 0.01, maxPerDayUsd: 1 });
    const pricing = await singit.pricing();
    assert.equal(pricing.model, "deepseek-v4.1-flash");
  } finally {
    await ask.close();
  }
});

test("pricing() reports clearly when pricing.json is not deployed (404)", async () => {
  const ask = await startJsonServer((req, res) => { res.writeHead(404).end(); });
  try {
    const singit = new SingIt({ evmPrivateKey: privateKey, network: "base", payTo: PAY_TO,
      baseUrl: ask.url, maxPerCallUsd: 0.01, maxPerDayUsd: 1 });
    await assert.rejects(singit.pricing(), /SI-68/);
  } finally {
    await ask.close();
  }
});

test("SingIt is constructed from a plain evmPrivateKey in three lines", () => {
  const singit = new SingIt({ evmPrivateKey: privateKey, network: "base", maxPerCallUsd: 0.01, maxPerDayUsd: 1 });
  assert.ok(singit instanceof SingIt);
});

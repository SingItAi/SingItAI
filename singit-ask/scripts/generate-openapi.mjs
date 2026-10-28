// Prints the openapi.json that singit-ask serves, built offline: no network, no keys, no payment. A stub facilitator,
// a price book that is never read, and a catalogue of every pinned model route stand in for Coinbase and Surplus, so the document has every route.
// Used to check the spec against the pay-skills catalogue linter (`pay catalog check`) and by test/openapi-lint.test.mjs.
//   node scripts/generate-openapi.mjs > openapi.json
import http from "node:http";
import { createApp, BASE, SOLANA } from "../src/app.mjs";
import { PriceBook } from "../src/prices.mjs";
import { MODEL_ROUTES } from "../src/model-routes.mjs";

const stubFacilitator = {
  async getSupported() {
    return { kinds: [
      { x402Version: 2, scheme: "exact", network: BASE },
      { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
      { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
      { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
        receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
    ], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} };
  },
};
const models = MODEL_ROUTES.map((m, i) => ({ id: m.id, name: m.name, provider: m.provider ?? "stub", contextLength: 1e6,
  promptUsdPerToken: (1 + i) * 1e-6, completionUsdPerToken: (1 + i) * 4e-6 }));
const catalogue = { async resolve(id) { return models.find((m) => m.id === id); }, async canAnswer() { return true; },
  async list() { return models; }, models };

export async function generateOpenapi(overrides = {}) {
  const config = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", payToBase: "0x1111111111111111111111111111111111111111",
    surplusKey: "inf_stub", surplusUrl: "https://surplus.invalid", model: "deepseek-v4.1-flash", exaKey: "stub", videoSold: false,
    observedFile: "/nonexistent/observed.json", ...overrides };
  const app = createApp(config, { facilitatorClient: stubFacilitator, catalogue, priceBook: new PriceBook({ publicClient: null }), log: () => {} });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  try {
    // Asked as the public site is (https, its host name), so `servers` names the production origin. fetch() cannot set Host.
    return await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: listener.address().port, path: "/openapi.json",
        headers: { host: "ask.singitai.app", "x-forwarded-proto": "https" } }, (res) => {
        let text = ""; res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
      }).on("error", reject);
    });
  } finally { listener.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await generateOpenapi(), null, 2));
}

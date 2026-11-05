// Prints the openapi.json that singit-ask serves, built offline: no network, no keys, no payment. A stub facilitator,
// a price book that is never read, and a catalogue of every pinned model route stand in for Coinbase and Surplus, so the document has every route.
// Used to check the spec against the pay-skills catalogue linter (`pay catalog check`) and by test/openapi-lint.test.mjs.
//   node scripts/generate-openapi.mjs > openapi.json
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
  // Offline media fixtures: rates also exercised in images.test.mjs and image-edits-embeddings.test.mjs.
  async editModels() { return new Map([["gpt-image-2-edit", { id: "gpt-image-2-edit", metering: "per_image", imageUsd: 0.36 }]]); },
  async embeddingModels() { return new Map([["venice-embed-1", { id: "venice-embed-1", usdPerMillionTokens: 0.1625 }]]); },
  async list() { return models; }, models };

export async function generateOpenapi(overrides = {}) {
  const config = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", payToBase: "0x1111111111111111111111111111111111111111",
    surplusKey: "inf_stub", surplusUrl: "https://surplus.invalid", model: "deepseek-v4.1-flash", exaKey: "stub", videoSold: false,
    observedFile: "/nonexistent/observed.json", ...overrides };
  const app = createApp(config, { facilitatorClient: stubFacilitator, catalogue, priceBook: new PriceBook({ publicClient: null }), log: () => {} });
  // Invoke the registered document handler directly: offline generation needs no listening socket.
  const route = app.router.stack.find(layer => layer.route?.path === "/openapi.json").route;
  let document;
  await route.stack.at(-1).handle({ protocol: "https", get: name => name === "host" ? "ask.singitai.app" : undefined },
    { json: value => { document = value; } });
  return document;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await generateOpenapi(), null, 2));
}

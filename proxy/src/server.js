// Local OpenAI-compatible proxy: clients talk to http://127.0.0.1:<port>/v1 like any
// OpenAI baseURL. This process holds the wallet, signs x402 to ask.singitai.app, and
// never treats HTTP 402 as a successful completion.
import http from "node:http";
import { SingIt, NETWORKS } from "@singitai/sdk";
import { loadOrCreateWallet, loadWallet, sessionPath, NETWORK } from "@singitai/session-wallet";
import { readConfig, assertNetworkAllowed, VERSION } from "./config.js";
export { VERSION };
import { withClientHeader, withRetries } from "./headers.js";

const BODY_LIMIT = 1_000_000;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-singit-client",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Send a JSON body."), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

/** Pin chat to POST /v1/chat/completions (agent envelope: tools and the 8192-token cap).
 *  Path-pinned /v1/chat/<id> and /v1/models/<id>/chat are rewritten so we never depend on
 *  the older indexed routes that used to strip tools. */
export function routeUpstream(urlPath, body) {
  const path = urlPath.split("?")[0];
  if (path === "/v1/chat/completions") return { path, body: body ?? {} };
  const pinned = path.match(/^\/v1\/chat\/([^/]+)$/);
  if (pinned && pinned[1] !== "completions") {
    return { path: "/v1/chat/completions", body: { ...(body ?? {}), model: body?.model || pinned[1] } };
  }
  const alias = path.match(/^\/v1\/models\/([^/]+)\/chat$/);
  if (alias) {
    return { path: "/v1/chat/completions", body: { ...(body ?? {}), model: body?.model || decodeURIComponent(alias[1]) } };
  }
  return null;
}

const fundingHint = () =>
  `Send USDC on Base (${NETWORK}, token ${NETWORKS.base.asset}) to the address from GET /wallet. `
  + "Payments are signed authorizations, so no ETH is needed for gas.";

export function createProxy({ env = process.env, fetchImpl = fetch, config: given } = {}) {
  const config = given ?? readConfig({ env });
  const limits = { maxPerCallUsd: config.maxPerCallUsd, maxPerDayUsd: config.maxPerDayUsd };
  const tagged = withRetries(withClientHeader(fetchImpl, { client: config.client, version: VERSION }));
  let singit = null;
  let singitAddress = null;

  function payer() {
    const { wallet } = loadOrCreateWallet(env);
    if (!singit || singitAddress !== wallet.address) {
      singit = new SingIt({
        evmPrivateKey: wallet.privateKey, network: config.network, baseUrl: config.askUrl,
        rpcUrl: config.rpcUrl, ...limits, fetchImpl: tagged,
      });
      singitAddress = wallet.address;
    }
    return { singit, wallet };
  }

  async function handle(req, res) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }
    const url = new URL(req.url, "http://singit-proxy.local");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json(res, 200, {
        name: "singit-proxy", version: VERSION, ok: true,
        listen: `http://${config.host}:${config.port}/v1/`,
        upstream: `${config.askUrl}/v1/chat/completions`,
        network: config.network, client: config.client, limits,
        wallet: "GET /wallet",
      });
    }

    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/wallet") {
      const found = req.method === "POST" ? loadOrCreateWallet(env) : loadWallet(env) ?? loadOrCreateWallet(env);
      const created = found.created === true;
      const address = found.address ?? found.wallet?.address;
      return json(res, 200, {
        mode: "wallet", walletExists: true, created,
        address, network: NETWORK, asset: "USDC",
        keySource: found.source === "env" ? "SINGIT_WALLET_KEY" : sessionPath(env),
        limits, funding: `Send USDC on Base (${NETWORK}, token ${NETWORKS.base.asset}). Payments are signed authorizations, so no ETH is needed for gas.`,
      });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const response = await tagged(`${config.askUrl}/v1/models`, { signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json", ...CORS });
      return res.end(text);
    }

    if (req.method === "POST" && url.pathname === "/chat/completions") {
      return json(res, 404, { error: { message: "No such route. Point your client at this proxy's /v1/ base (apiBase must end with /v1/).", type: "invalid_request_error" } });
    }

    if (req.method !== "POST") {
      return json(res, 404, { error: { message: "Not found.", type: "invalid_request_error" } });
    }

    const body = await readBody(req);
    const routed = routeUpstream(url.pathname, body);
    if (!routed) return json(res, 404, { error: { message: "Not found. This proxy serves OpenAI chat completions at /v1/chat/completions.", type: "invalid_request_error" } });
    if (routed.body?.stream === true) {
      return json(res, 400, { error: { message: "This proxy returns a complete JSON answer after payment; set stream to false.", type: "invalid_request_error" } });
    }

    const paying = payer();
    const target = `${config.askUrl}${routed.path}`;
    try {
      const response = await paying.singit.paidFetch()(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(routed.body),
      });
      // A 402 after the SDK tried to pay is a refusal, never a chat completion.
      if (response.status === 402) {
        return json(res, 402, {
          error: {
            message: `SingIt Ask answered HTTP 402 (payment required) and the local wallet could not pay. ${fundingHint()}`,
            type: "payment_required",
          },
        });
      }
      const text = await response.text();
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json", ...CORS });
      return res.end(text);
    } catch (error) {
      const message = error?.message || "Request failed.";
      const status = /HTTP 402/.test(message) ? 402 : 502;
      return json(res, status, {
        error: {
          message: `${message} ${fundingHint()}`,
          type: status === 402 ? "payment_required" : "proxy_error",
        },
      });
    }
  }

  return { config, handle, payer };
}

export async function startProxy({ env = process.env, fetchImpl = fetch, listen = true } = {}) {
  const config = readConfig({ env, argv: process.argv.slice(2) });
  await assertNetworkAllowed(config.network, { askUrl: config.askUrl, fetchImpl });
  // Create the wallet at listen time so GET /wallet works before the first paid call.
  loadOrCreateWallet(env);
  const { handle } = createProxy({ env, fetchImpl, config });
  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch(error => {
      if (!res.headersSent) json(res, error.status || 500, { error: { message: error.message || "Request failed.", type: "proxy_error" } });
    });
  });
  if (!listen) return { server, config };
  await new Promise((resolve, reject) => {
    server.listen(config.port, config.host, resolve);
    server.on("error", reject);
  });
  return { server, config };
}

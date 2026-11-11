// Local OpenAI-compatible proxy: clients talk to http://127.0.0.1:<port>/v1 like any
// OpenAI baseURL. The same process also speaks Anthropic Messages at /v1/messages by
// translating to Ask's /v1/chat/completions. It holds the wallet, signs x402, and never
// treats HTTP 402 as a successful completion or message.
import http from "node:http";
import { resolveModel, isAlias } from "./models.js";
import { SingIt, NETWORKS } from "@singitai/sdk";
import { loadOrCreateWallet, loadWallet, sessionPath, NETWORK } from "@singitai/session-wallet";
import { readConfig, assertNetworkAllowed, VERSION } from "./config.js";
export { VERSION };
import { withClientHeader, withRetries } from "./headers.js";
import { responsesToChatCompletions, chatCompletionToResponse } from "./responses.js";
import { anthropicToChatCompletions, chatCompletionToMessage, estimateTokenCount } from "./anthropic.js";
import {
  completionToOpenAiSse, messageToAnthropicSse, openaiSseToAnthropicSse,
  looksLikeSse, ensureOpenAiDone, responseToSse, openaiSseToResponsesSse, responsesErrorSse,
} from "./sse.js";

const BODY_LIMIT = 1_000_000;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-api-key, anthropic-version, anthropic-beta, x-singit-client",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

function anthropicError(res, status, message, type = status === 400 || status === 422 ? "invalid_request_error" : "api_error") {
  return json(res, status, { type: "error", error: { type, message } });
}

function writeSse(res, body) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    ...CORS,
  });
  res.end(body);
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
    return { path: "/v1/chat/completions", body: { ...(body ?? {}), model: body?.model || decodeURIComponent(pinned[1]) } };
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
  let catalogPromise;
  function catalog() {
    catalogPromise ??= tagged(`${config.askUrl}/v1/models`, { signal: AbortSignal.timeout(5000) })
      .then(response => response.ok ? response.json() : undefined).catch(() => undefined);
    return catalogPromise;
  }
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

  async function upstreamChat(paying, openaiBody) {
    const target = `${config.askUrl}/v1/chat/completions`;
    const streaming = openaiBody?.stream === true;
    const headers = { "content-type": "application/json" };
    if (streaming) {
      const preview = await tagged(target, { method: "POST", headers, body: JSON.stringify(openaiBody) });
      if (preview.status !== 402) return preview;
      const paidBody = { ...openaiBody, stream: false };
      delete paidBody.stream_options;
      return paying.singit.paidFetch()(target, { method: "POST", headers, body: JSON.stringify(paidBody) });
    }
    return paying.singit.paidFetch()(target, { method: "POST", headers, body: JSON.stringify(openaiBody) });
  }

  async function sendChatResponse(res, response, { streaming, format }) {
    if (response.status === 402) {
      const message = `SingIt Ask answered HTTP 402 (payment required) and the local wallet could not pay. ${fundingHint()}`;
      if (format === "anthropic") return anthropicError(res, 402, message);
      return json(res, 402, { error: { message, type: "payment_required" } });
    }
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    if (response.status !== 200) {
      if (format === "responses") {
        let message = `Upstream request failed (HTTP ${response.status}).`;
        try { message = JSON.parse(text)?.error?.message || message; } catch { /* keep safe fallback */ }
        return streaming ? writeSse(res, responsesErrorSse(message))
          : json(res, response.status, { error: { type: "api_error", message } });
      }
      if (format === "anthropic") {
        let message = text;
        try {
          const parsed = JSON.parse(text);
          message = parsed?.error?.message || parsed?.message || text;
        } catch { /* keep raw text */ }
        return anthropicError(res, response.status, message || "Upstream request failed.");
      }
      res.writeHead(response.status, { "content-type": contentType || "application/json", ...CORS });
      return res.end(text);
    }

    if (format === "responses") {
      if (/text\/event-stream/i.test(contentType) || looksLikeSse(text)) return writeSse(res, openaiSseToResponsesSse(text));
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { error: { message: "Upstream returned an unreadable answer." } }; }
      if (parsed?.error || !Array.isArray(parsed?.choices)) {
        const message = parsed?.error?.message || "Upstream request failed.";
        return streaming ? writeSse(res, responsesErrorSse(message)) : json(res, 502, { error: { type: "api_error", message } });
      }
      const answer = chatCompletionToResponse(parsed);
      return streaming ? writeSse(res, responseToSse(answer)) : json(res, 200, answer);
    }

    if (format === "openai") {
      if (!streaming) {
        res.writeHead(response.status, { "content-type": contentType || "application/json", ...CORS });
        return res.end(text);
      }
      if (/text\/event-stream/i.test(contentType) || looksLikeSse(text)) return writeSse(res, ensureOpenAiDone(text));
      let parsed;
      try { parsed = JSON.parse(text); }
      catch {
        res.writeHead(response.status, { "content-type": contentType || "application/json", ...CORS });
        return res.end(text);
      }
      if (parsed?.error && !parsed?.choices) {
        return json(res, response.status >= 400 ? response.status : 502, parsed);
      }
      return writeSse(res, completionToOpenAiSse(parsed));
    }

    if (/text\/event-stream/i.test(contentType) || looksLikeSse(text)) {
      return writeSse(res, openaiSseToAnthropicSse(text));
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return anthropicError(res, 502, "Upstream returned an unreadable answer."); }
    if (parsed?.error && !parsed?.choices) {
      return anthropicError(res, response.status >= 400 ? response.status : 502, parsed.error?.message || "Upstream request failed.");
    }
    const message = parsed?.type === "message" && parsed?.role === "assistant"
      ? parsed : chatCompletionToMessage(parsed);
    return streaming ? writeSse(res, messageToAnthropicSse(message)) : json(res, 200, message);
  }

  function paymentCatch(error, format) {
    const message = error?.message || "Request failed.";
    // SDK pre-sign refusals are unpayable challenges, not failed model turns.
    const refused = format === "responses" && /per-call ceiling|Daily spend cap reached|refusing to sign|payment challenge|payment header|offer on|payment asset|payee|facilitator address|timeout window/i.test(message);
    const status = /HTTP 402/.test(message) || refused ? 402 : 502;
    const wrapped = `${message} ${fundingHint()}`;
    if (format === "anthropic") return { status, body: { type: "error", error: { type: "api_error", message: wrapped } } };
    return { status, body: { error: { message: wrapped, type: status === 402 ? "payment_required" : "proxy_error" } } };
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
        routes: ["/v1/responses", "/v1/chat/completions", "/v1/messages", "/v1/messages/count_tokens"],
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

    let body;
    try { body = await readBody(req); }
    catch (error) {
      if (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens") {
        return anthropicError(res, error.status || 400, error.message);
      }
      return json(res, error.status || 400, { error: { message: error.message, type: "invalid_request_error" } });
    }

    if (url.pathname === "/v1/messages/count_tokens") {
      try { return json(res, 200, estimateTokenCount(body ?? {})); }
      catch (error) { return anthropicError(res, error.status || 400, error.message); }
    }

    if (url.pathname === "/v1/responses") {
      try {
        // Validate before any upstream I/O.
        const preview = responsesToChatCompletions(body, { modelMap: config.modelMap });
        const models = isAlias(preview.model) ? await catalog() : undefined;
        const openaiBody = responsesToChatCompletions(body, { modelMap: config.modelMap, catalog: models });
        const response = await upstreamChat(payer(), openaiBody);
        return await sendChatResponse(res, response, { streaming: body.stream === true, format: "responses" });
      } catch (error) {
        if (error.status) return json(res, error.status, { error: { type: "invalid_request_error", message: error.message } });
        const mapped = paymentCatch(error, "responses");
        if (mapped.status !== 402 && body?.stream === true) return writeSse(res, responsesErrorSse(mapped.body.error.message));
        return json(res, mapped.status, mapped.body);
      }
    }

    if (url.pathname === "/v1/messages") {
      try {
        const openaiBody = anthropicToChatCompletions(body ?? {}, { modelMap: config.modelMap });
        const response = await upstreamChat(payer(), openaiBody);
        return await sendChatResponse(res, response, { streaming: body?.stream === true, format: "anthropic" });
      } catch (error) {
        if (error.status) return anthropicError(res, error.status, error.message);
        const mapped = paymentCatch(error, "anthropic");
        return json(res, mapped.status, mapped.body);
      }
    }

    const routed = routeUpstream(url.pathname, body);
    if (!routed) {
      return json(res, 404, {
        error: {
          message: "Not found. This proxy serves OpenAI chat completions at /v1/chat/completions and Anthropic Messages at /v1/messages, plus OpenAI Responses at /v1/responses.",
          type: "invalid_request_error",
        },
      });
    }

    try {
      const mapped = resolveModel(routed.body.model, { modelMap: config.modelMap });
      routed.body.model = resolveModel(routed.body.model, { modelMap: config.modelMap, catalog: isAlias(mapped) ? await catalog() : undefined });
      const response = await upstreamChat(payer(), routed.body);
      return await sendChatResponse(res, response, { streaming: routed.body?.stream === true, format: "openai" });
    } catch (error) {
      const mapped = paymentCatch(error, "openai");
      return json(res, mapped.status, mapped.body);
    }
  }

  return { config, handle, payer };
}

export async function startProxy({ env = process.env, fetchImpl = fetch, listen = true, argv = process.argv.slice(2) } = {}) {
  const config = readConfig({ env, argv });
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

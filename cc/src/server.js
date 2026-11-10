// Claude Code speaks Anthropic Messages; the SDK pays for non-streaming JSON only.
import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SingIt } from '@singitai/sdk';
import { loadOrCreateWallet } from '@singitai/session-wallet';
import { readConfig, assertNetworkAllowed, VERSION, FALLBACK_MODEL } from './config.js';
import { withClientHeader, withRetries } from './headers.js';
import { messageToSSE } from './sse.js';
import { recordSpend } from './ledger.js';
export { VERSION };
export const fundingHint = 'Send USDC on Base. No ETH needed — the facilitator pays gas.';
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const fail = (res, status, message, type = 'proxy_error') => json(res, status, { type: 'error', error: { type, message } });
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* invalid below */ }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Send a JSON object.'), { status: 400 });
  return body;
}

export function createProxy({ env = process.env, fetchImpl = fetch, config = readConfig({ env }) } = {}) {
  const attempts = new AsyncLocalStorage();
  const observed = (input, init) => {
    const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
    if (headers.has('payment-signature') && attempts.getStore()) attempts.getStore().signed = true;
    return fetchImpl(input, init);
  };
  const tagged = withRetries(withClientHeader(observed, { client: config.client, version: VERSION }));
  let singit, address, catalogue;
  function payer() {
    const { wallet } = loadOrCreateWallet(env);
    if (!singit || address !== wallet.address) {
      singit = new SingIt({ evmPrivateKey: wallet.privateKey, network: config.network, baseUrl: config.askUrl,
        rpcUrl: config.rpcUrl, maxPerCallUsd: config.maxPerCallUsd, maxPerDayUsd: config.maxPerDayUsd, fetchImpl: tagged });
      address = wallet.address;
    }
    return singit;
  }
  async function resolveModel(model) {
    let chosen = model || config.defaultModel;
    if (['sonnet', 'opus', 'haiku'].includes(chosen)) chosen = config[`${chosen}Model`];
    if (chosen === 'auto' && !['auto', 'sonnet', 'opus', 'haiku'].includes(config.defaultModel)) chosen = config.defaultModel;
    if (chosen !== 'auto') return chosen;
    catalogue ??= (async () => {
      try {
        const r = await tagged(`${config.askUrl}/v1/models`, { signal: AbortSignal.timeout(10000) });
        if (r.ok) {
          const c = await r.json();
          return (typeof c.default === 'string' && c.default) || c.data?.find(m => m.default === true)?.id || FALLBACK_MODEL;
        }
      } catch { /* offline catalogue */ }
      return FALLBACK_MODEL;
    })();
    return catalogue;
  }
  async function handle(req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && ['/', '/health'].includes(pathname)) return json(res, 200, { name: 'singit-cc', version: VERSION, ok: true, network: config.network });
    if (['GET', 'POST'].includes(req.method) && pathname === '/wallet') {
      const { wallet } = loadOrCreateWallet(env);
      return json(res, 200, { address: wallet.address, network: wallet.network, asset: 'USDC', funding: fundingHint });
    }
    if (req.method === 'GET' && ['/v1/models', '/api/v1/models'].includes(pathname)) {
      const r = await tagged(`${config.askUrl}/v1/models`, { signal: AbortSignal.timeout(30000) });
      return json(res, r.status, await r.json());
    }
    if (req.method !== 'POST' || !['/v1/messages', '/api/v1/messages'].includes(pathname)) return fail(res, 404, 'Not found.', 'invalid_request_error');
    const body = await readBody(req);
    const stream = body.stream === true;
    body.stream = false;
    delete body.stream_options;
    const cap = Math.min(config.maxTokens, 32000);
    if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)) return fail(res, 400, 'max_tokens must be a positive integer.', 'invalid_request_error');
    body.max_tokens = Math.min(body.max_tokens ?? cap, cap);
    body.model = await resolveModel(body.model);
    const headers = { 'content-type': 'application/json' };
    if (req.headers['anthropic-version']) headers['anthropic-version'] = req.headers['anthropic-version'];
    // Track whether any signature left the process. A fallback must always be a fresh unsigned request.
    // paidFetch errors after signing must never cause another attempt, even if their text mentions a cap/model.
    const state = { signed: false };
    const client = payer();
    return attempts.run(state, async () => {
      try {
        let response;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            response = await client.paidFetch()(`${config.askUrl}/v1/messages`, { method: 'POST', headers,
              signal: AbortSignal.timeout(90000), body: JSON.stringify(body) });
          } catch (error) {
            if (!state.signed && attempt === 0 && config.fallback && config.freeModel && body.model !== config.freeModel && /daily.*cap|daily.*limit/i.test(error.message)) {
              body.model = config.freeModel;
              continue;
            }
            throw error;
          }
          if (!state.signed && attempt === 0 && config.fallback && config.freeModel && body.model !== config.freeModel && response.status === 400) {
            const problem = await response.clone().text();
            if (/model_not_found/.test(problem)) { body.model = config.freeModel; continue; }
          }
          break;
        }
        if (response.status === 402) return fail(res, 402, `HTTP 402: payment required. ${fundingHint}`, 'payment_required');
        const answer = await response.json();
        if (!response.ok) return fail(res, response.status, answer.error?.message || 'Upstream request failed.', answer.error?.type || 'api_error');
        if (answer.type !== 'message') return fail(res, 502, 'Upstream did not return an Anthropic message.');
        if (state.signed && answer.billing?.totalAtomic) {
          // A local disk failure must not turn a settled answer into a retryable upstream error.
          try { recordSpend({ model: answer.model || body.model, totalAtomic: answer.billing.totalAtomic }, env); }
          catch { console.error('singit-cc: could not update local spend statistics.'); }
        }
        if (!stream) return json(res, response.status, answer);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(messageToSSE(answer));
      } catch (error) {
        const payment = /HTTP 402/i.test(error.message) || (!state.signed && /daily.*cap|daily.*limit|ceiling/i.test(error.message));
        // Do not echo arbitrary upstream/transport text that might contain credentials.
        return fail(res, payment ? 402 : 502, payment ? `Payment refused or spending limit reached. ${fundingHint}` : 'Upstream request failed; signed payments are never repeated.', payment ? 'payment_required' : 'proxy_error');
      }
    });
  }
  return { config, handle, resolveModel };
}

export async function startProxy({ env = process.env, fetchImpl = fetch, flags = {}, listen = true } = {}) {
  const config = readConfig({ env, flags });
  if (config.host !== '127.0.0.1') throw new Error('singit-cc must listen on 127.0.0.1.');
  await assertNetworkAllowed(config.network, { askUrl: config.askUrl, fetchImpl });
  loadOrCreateWallet(env);
  const proxy = createProxy({ env, fetchImpl, config });
  const server = http.createServer((req, res) => {
    proxy.handle(req, res).catch(error => {
      if (!res.headersSent) fail(res, error.status || 500, error.status ? error.message : 'Proxy request failed.', 'invalid_request_error');
      else res.end();
    });
  });
  if (listen) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
    config.port = server.address().port;
  }
  return { ...proxy, server };
}

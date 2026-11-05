import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerLogFor } from '../src/answer-log.mjs';
import { numbersBody } from '../src/health-stats.mjs';
import { modelRoutePaths } from '../src/model-routes.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, SOLANA, ROUTE, readRequest, askSurplus, createApp, UpstreamError } from '../src/app.mjs';
import { UnknownModel } from '../src/catalogue.mjs';
import { AGENT_LIMITS } from '../src/limits.mjs';
import { ceilings } from '../src/metered.mjs';
import { ceilingAtomic, TERMS, SOLANA_TERMS, exactReserveTokens } from '../src/pricing.mjs';
import { unsupportedCapability } from '../src/agent-chat.mjs';
const SOLANA_PAY_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const BASE_PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const CONFIG = {
  payToSolana: SOLANA_PAY_TO, payToBase: BASE_PAY_TO, surplusKey: "inf_test", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash",
};

function fakeFacilitator() {
  const calls = { verify: 0, settle: [] };
  return {
    calls,
    async getSupported() {
      return {
        kinds: [
          { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
          { x402Version: 2, scheme: "exact", network: BASE },
          { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
          { x402Version: 2, scheme: "upto", network: SOLANA, extra: {
            feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88", receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
        ],
        extensions: ["bazaar", "eip2612GasSponsoring"],
        signers: {},
      };
    },
    async verify() {
      calls.verify += 1;
      return { isValid: true, payer: PAYER };
    },
    async settle(_payload, requirements) {
      calls.settle.push(requirements.amount);
      return { success: true, transaction: "0x" + "a".repeat(64), network: requirements.network, payer: PAYER };
    },
  };
}

const PRICEY = { id: "pro-model", name: "Pro", provider: "X", contextLength: 1e6, promptUsdPerToken: 30e-6, completionUsdPerToken: 180e-6 };
const CHEAP = { id: "cheap-model", name: "Cheap", provider: "X", contextLength: 1e5, promptUsdPerToken: 0.1e-6, completionUsdPerToken: 0.3e-6 };
const IDLE = { id: "idle-model", name: "Idle", provider: "X", contextLength: 1, promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 };
const fakeCatalogue = { async market() { return new Map([["pro-model", { trustedShare: 0.25 }]]); }, async resolve(id) { const m = [PRICEY, CHEAP, IDLE].find((x) => x.id === id); if (!m) throw new UnknownModel("That model is not available."); return m; },
  async list() { return [CHEAP, PRICEY]; }, async canAnswer(id) { return id !== "idle-model"; } };

async function serve(t, { upstream, config = CONFIG, catalogue = fakeCatalogue, fetchImpl } = {}) {
  const facilitator = fakeFacilitator();
  const asked = [];
  const answer = upstream ?? (async (_config, messages, maxTokens) => {
    asked.push({ messages, maxTokens });
    return { content: "Try Caffè Propaganda.", finishReason: "stop", usage: { total_tokens: 42, buyer_cost_micro: 100 } };
  });
  const app = createApp(config, { facilitatorClient: facilitator, upstream: answer, log: () => {}, catalogue, fetchImpl });
  // Exercise the actual Express and x402 middleware without binding a network socket.
  const url = async (body, headers = {}, path = ROUTE) => {
    const chunks = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    socket.remoteAddress = '127.0.0.1';
    const req = new IncomingMessage(socket);
    req.method = path === '/openapi.json' ? 'GET' : 'POST'; req.url = path; req.httpVersionMajor = 1; req.httpVersionMinor = 1; req.httpVersion = '1.1';
    const json = JSON.stringify(body);
    req.headers = { host: 'ask.test', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(json)), ...headers };
    req.complete = true; req.push(json); req.push(null);
    const res = new ServerResponse(req); res.assignSocket(socket);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`In-process request stalled: status=${res.statusCode} bytes=${chunks.reduce((n,c)=>n+c.length,0)} ended=${res.writableEnded} readable=${req.readableEnded}`)), 3000);
      res.on('error', reject);
      res.on('finish', () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString();
        const split = raw.indexOf('\r\n\r\n');
        const head = raw.slice(0, split).split('\r\n');
        const responseHeaders = new Headers(head.slice(1).map(line => { const i = line.indexOf(':'); return [line.slice(0,i), line.slice(i+1).trim()]; }));
        let data = raw.slice(split + 4);
        if (responseHeaders.get('transfer-encoding') === 'chunked') {
          let decoded = '';
          while (data) { const i = data.indexOf('\r\n'), n = parseInt(data.slice(0,i),16); if (!n) break; decoded += data.slice(i+2,i+2+n); data = data.slice(i+2+n+2); }
          data = decoded;
        }
        resolve(new Response(data || null, { status: res.statusCode, headers: responseHeaders }));
      });
      app.handle(req, res, error => reject(error ?? new Error('Unhandled request')));
    });
  };
  return { url, facilitator, asked, app };
}

const QUESTION = { messages: [{ role: "user", content: "Coffee near the Colosseum?" }], max_tokens: 300 };

function post(url, body, headers = {}) { return url(body, headers); }

function decode(header) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

// A Base payment the fake facilitator accepts, echoing the merchant's extensions as a real buyer does.
function baseSignature(required) {
  const accepted = required.accepts.find((a) => a.network === BASE && a.scheme === "upto");
  return Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource, accepted,
    payload: { signature: "0xsigned" }, extensions: required.extensions })).toString("base64");
}

// A buyer that only ever signs `exact`, like vet402: picks the exact offer instead of the upto one.
function exactSignature(required, network = BASE) {
  const accepted = required.accepts.find((a) => a.network === network && a.scheme === "exact");
  return Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource, accepted,
    payload: { signature: "0xsigned" }, extensions: required.extensions })).toString("base64");
}


const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
const calls = [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"secret":"argument"}' } }];
const body = { messages: [{ role: 'user', content: 'private prompt' }], tools, tool_choice: 'auto', parallel_tool_calls: false };
const agent = b => readRequest(b, { agent: true });
test('legacy baseline and agent plain messages are identical', () => {
  const baseline = { messages: QUESTION.messages, maxTokens: 300, chars: 25, modelOmitted: true, model: undefined, messageCount: 1 };
  baseline.chars = QUESTION.messages[0].content.length;
  assert.deepEqual(readRequest(QUESTION), baseline);
  assert.deepEqual(agent(QUESTION).messages, baseline.messages);
  assert.equal(agent({ ...body, max_tokens: 99999 }).maxTokens, 8192);
  assert.equal(agent({ ...body, max_tokens: -1 }).maxTokens, 800);
});
test('agent normalizes tools, calls, tool replies, developer and image/text blocks', () => {
  const input = agent({ ...body, messages: [
    { role: 'developer', content: 'instructions', ignored: true },
    { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'https://images.test/a.png', detail: 'low' } }] },
    { role: 'assistant', content: null, tool_calls: calls },
    { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'found' }] }
  ] });
  assert.equal(input.messages[0].role, 'system');
  assert.equal(input.messages[0].ignored, undefined);
  assert.deepEqual(input.messages[2].tool_calls, calls);
  assert.deepEqual(input.request.tools, tools);
  assert.deepEqual(input.flags, { tools: true, images: 1 });
  assert.equal(input.chars, 12 + 3 + 5 + 8000 + JSON.stringify(tools).length + 6 + calls[0].function.arguments.length);
});
test('agent rejection matrix and legacy route refusals', () => {
  const invalid = [
    { messages: [{ role: 'other', content: 'x' }] },
    { messages: [{ role: 'tool', content: 'x' }] },
    { tools: Array(65).fill(tools[0]) },
    { messages: Array(201).fill(body.messages[0]) },
    { messages: [{ role: 'user', content: 'x'.repeat(100001) }] },
    { messages: [{ role: 'user', content: Array(5).fill({ type: 'image_url', image_url: { url: 'https://a.test/i' } }) }] },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://a.test/i' } }] }] },
    { tool_choice: { type: 'function', function: { name: 'unknown' } } },
    { tools: null, tool_choice: 'auto' }, { tools: null, parallel_tool_calls: true },
    { functions: [] }, { function_call: 'auto' }, { stream: true },
    { messages: [{ role: 'assistant', content: null, tool_calls: [{ ...calls[0], id: '' }] }] }
  ];
  for (const change of invalid) assert.throws(() => agent({ ...body, ...change }), e => e.status === 400);
  for (const key of ['tools','tool_choice','functions','function_call','parallel_tool_calls'])
    assert.throws(() => readRequest({ ...QUESTION, [key]: false }), e => e.code === 'tools_unsupported');
  assert.throws(() => readRequest({ messages: [{ role: 'tool', content: 'x' }] }), e => e.code === 'tools_unsupported');
  assert.throws(() => readRequest({ messages: [{ role: 'user', content: [] }] }), e => e.code === 'content_blocks_unsupported');
});
test('tool-only upstream answer is billable, sanitized, forwarded and never reasoning-retried', async () => {
  let count = 0;
  const answer = await askSurplus(CONFIG, body.messages, 8192, async (_url, init) => {
    count++;
    const sent = JSON.parse(init.body);
    assert.deepEqual(sent.tools, tools); assert.equal(sent.tool_choice, 'auto'); assert.equal(sent.parallel_tool_calls, false);
    return Response.json({ choices: [{ message: { content: null, tool_calls: calls.map(c => ({ ...c, ignored: true })) }, finish_reason: 'length' }], usage: { buyer_cost_micro: 100 } });
  }, CONFIG.model, { agent: agent(body).request, retryOnReasoning: true });
  assert.equal(count, 1); assert.equal(answer.content, null); assert.deepEqual(answer.message.tool_calls, calls);
});
test('catalogue capability gate uses declared evidence; unknown entries allowed', () => {
  assert.equal(unsupportedCapability({}, { tools: true, images: 1 }), null);
  assert.equal(unsupportedCapability({ params: ['max_tokens'] }, { tools: true }), 'tools');
  assert.equal(unsupportedCapability({ inputs: ['text'] }, { images: 1 }), 'images');
  assert.equal(unsupportedCapability({ params: ['tools'], inputs: ['text','image'] }, { tools: true, images: 1 }), null);
});
const DEFAULT = { id: CONFIG.model, promptUsdPerToken: 0.14e-6, completionUsdPerToken: 0.28e-6 };
test('agent ceiling uses formula on both networks; exact reserve stays bounded', () => {
  const input = { ...agent({ ...body, max_tokens: 8192 }), isDefault: true, share: 1 };
  const quoted = ceilings(DEFAULT, input);
  assert.deepEqual(quoted, { upto: { [BASE]: '4001', [SOLANA]: '5001' }, exact: { [BASE]: '1901', [SOLANA]: '2901' } });
  assert.deepEqual(ceilings(DEFAULT, { chars: 24000, messageCount: 40, maxTokens: 1200, isDefault: true, share: 1 }), { upto: { [BASE]: '3000', [SOLANA]: '3000' }, exact: { [BASE]: '2254', [SOLANA]: '3000' } });
  for (const [net, terms] of [[BASE, TERMS], [SOLANA, SOLANA_TERMS]]) {
    assert.equal(quoted.upto[net], ceilingAtomic(DEFAULT, { ...input, charsPerToken: 1 }, terms, 1));
    assert.equal(quoted.exact[net], ceilingAtomic(DEFAULT, { ...input, maxTokens: Math.ceil(8192 * 0.3), reserveTokens: exactReserveTokens(DEFAULT.id, 8192, DEFAULT) }, terms, 1));
    assert.ok(BigInt(quoted.upto[net]) > BigInt(ceilings(DEFAULT, { ...input, maxTokens: 800 }).upto[net]));
  }
});
for (const network of [BASE, SOLANA]) for (const scheme of ['upto','exact']) test(`agent paid tool round trip ${network} ${scheme}`, async t => {
  let sent;
  const catalogue = { ...fakeCatalogue, resolve: async () => ({ ...DEFAULT, params: ['max_tokens','tools'], inputs: ['text','image'] }) };
  const { url, facilitator } = await serve(t, { catalogue, fetchImpl: async (_url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({ choices: [{ message: sent.messages.at(-1).role === 'tool' ? { content: 'done' } : { content: null, tool_calls: calls }, finish_reason: sent.messages.at(-1).role === 'tool' ? 'stop' : 'tool_calls' }], usage: { buyer_cost_micro: 100 } });
  }, upstream: askSurplus });
  const input = { ...body, max_tokens: 8192 };
  const quoteResponse = await post(url, input); assert.equal(quoteResponse.status, 402);
  const quote = decode(quoteResponse.headers.get('payment-required'));
  const accepted = quote.accepts.find(a => a.network === network && a.scheme === scheme);
  const payload = network === SOLANA && scheme === 'upto' ? { from: SOLANA_PAY_TO, channelId: SOLANA_PAY_TO, maxAmount: accepted.amount, deposit: accepted.amount, nonce: '1', openSlot: '123', openTransaction: 'mock', expiresAt: Math.floor(Date.now()/1000)+300, validAfter: Math.floor(Date.now()/1000), authorizedSigner: SOLANA_PAY_TO } : { signature: '0xsigned' };
  const signature = Buffer.from(JSON.stringify({ x402Version: 2, resource: quote.resource, accepted, payload, extensions: quote.extensions })).toString('base64');
  const paid = await post(url, input, { 'payment-signature': signature });
  assert.equal(paid.status, 200); const result = await paid.json();
  assert.equal(accepted.amount, ceilings(DEFAULT, { ...agent(input), isDefault: true, share: 1 })[scheme][network]);
  assert.deepEqual(result.choices[0].message.tool_calls, calls); assert.equal(result.choices[0].message.content, null);
  assert.equal(result.choices[0].finish_reason, 'tool_calls'); assert.ok(BigInt(result.billing.totalAtomic) <= BigInt(accepted.amount));
  assert.deepEqual(sent.tools, tools); assert.equal(sent.tool_choice, 'auto'); assert.equal(sent.parallel_tool_calls, false);
  assert.ok(facilitator.calls.settle.length);
  const follow = { ...input, messages: [...input.messages, { role: 'assistant', content: null, tool_calls: calls }, { role: 'tool', content: 'result', tool_call_id: 'call_1' }] };
  const followQuote = decode((await post(url, follow)).headers.get('payment-required'));
  const followAccepted = followQuote.accepts.find(a => a.network === network && a.scheme === scheme);
  const followSig = Buffer.from(JSON.stringify({ x402Version: 2, resource: followQuote.resource, accepted: followAccepted, payload: { ...payload, nonce: '2', ...(scheme === 'upto' && network === SOLANA ? { deposit: followAccepted.amount, maxAmount: followAccepted.amount } : {}) }, extensions: followQuote.extensions })).toString('base64');
  const response = await post(url, follow, { 'payment-signature': followSig });
  assert.equal(response.status, 200); assert.deepEqual(sent.messages.at(-1), follow.messages.at(-1));
  assert.equal((await response.json()).choices[0].message.content, 'done');

});

test('refusals happen before verify, settlement, upstream or paid counters', async t => {
  let upstreamCalls = 0;
  const catalogue = { ...fakeCatalogue, resolve: async () => ({ ...DEFAULT, params: ['max_tokens'], inputs: ['text'] }) };
  const { url, facilitator, app } = await serve(t, { catalogue, upstream: async () => { upstreamCalls++; throw new Error('unexpected'); } });
  const before = numbersBody(app.locals.healthStats).paid_calls;
  const image = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://image.test/a' } }] }] };
  for (const [input, status, code] of [
    [body, 400, 'tools_unsupported_for_model'], [image, 400, 'images_unsupported_for_model'],
    [{ ...body, messages: Array(201).fill(body.messages[0]) },400,'invalid_request'],
    [{ ...body, messages: [{ role: 'user', content: 'x'.repeat(140000) }] },413,'payload_too_large']
  ]) {
    const res = await post(url, input); assert.equal(res.status, status); assert.equal((await res.json()).error.code, code);
    assert.equal(res.headers.get('payment-required'), null);
  }
  assert.equal(upstreamCalls, 0); assert.equal(facilitator.calls.verify, 0); assert.deepEqual(facilitator.calls.settle, []);
  assert.deepEqual(numbersBody(app.locals.healthStats).paid_calls, before);
});
test('capable image model passes prepayment validation', async t => {
  const catalogue = { ...fakeCatalogue, resolve: async () => ({ ...DEFAULT, inputs: ['text','image'] }) };
  const { url } = await serve(t, { catalogue });
  const res = await post(url, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }] });
  assert.equal(res.status, 402);
});
for (const status of [400,500]) test(`upstream HTTP ${status} preserves no-charge handling`, async t => {
  let marked = 0;
  const catalogue = { ...fakeCatalogue, resolve: async () => DEFAULT, markUnservable: () => marked++, noteSellerFailure: () => marked++ };
  const { url, facilitator, app } = await serve(t, { catalogue, upstream: askSurplus, fetchImpl: async () => Response.json({ error: { code: 'request_rejected' } }, { status }) });
  const q = decode((await post(url, body)).headers.get('payment-required'));
  const res = await post(url, body, { 'payment-signature': baseSignature(q) });
  assert.equal(res.status, status === 400 ? 400 : 503);
  assert.equal((await res.json()).error.code, status === 400 ? 'upstream_rejected_request' : 'no_billable_answer');
  if (status === 400) assert.equal(marked, 0);
  assert.deepEqual(facilitator.calls.settle, []);
  assert.equal(numbersBody(app.locals.healthStats).paid_calls.total, 0);
});
test('free and per-model routes refuse agent fields with actionable errors', async t => {
  const { url, facilitator } = await serve(t, { config: { ...CONFIG, freeModels: [CONFIG.model] } });
  for (const input of [{ ...body, model: 'free/deepseek-v4.1-flash' }, body]) {
    const path = input.model ? ROUTE : modelRoutePaths({ id: 'deepseek-v4.1-flash' })[0];
    const res = await url(input, {}, path);
    assert.equal(res.status, 400); const error = (await res.json()).error;
    assert.equal(error.code, 'tools_unsupported'); assert.match(error.message, /POST \/v1\/chat\/completions/);
  }
  assert.equal(facilitator.calls.verify, 0);
});
test('auto excludes proven incapable candidates and refuses when all are incapable', async t => {
  for (const capable of [true,false]) {
    const catalogue = { ...fakeCatalogue, resolve: async id => ({ ...DEFAULT, id, params: ['max_tokens', ...(capable && id === 'kimi-k3' ? ['tools'] : [])] }) };
    const { url, facilitator } = await serve(t, { catalogue });
    const res = await post(url, { ...body, model: 'singit/auto' });
    assert.equal(res.status, capable ? 402 : 400);
    if (capable) assert.equal(res.headers.get('x-singit-model'), 'kimi-k3');
    else assert.equal((await res.json()).error.code, 'tools_unsupported_for_model');
    assert.equal(facilitator.calls.verify, 0);
  }
});
test('settled tool request answer log contains only accounting metadata', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'singit-agent-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { ...CONFIG, answerLogFile: join(dir, 'answers.jsonl') };
  const { url } = await serve(t, { config, catalogue: { ...fakeCatalogue, resolve: async () => DEFAULT }, upstream: askSurplus,
    fetchImpl: async () => Response.json({ choices: [{ message: { content: null, tool_calls: calls }, finish_reason: 'tool_calls' }], usage: { buyer_cost_micro: 100 } }) });
  const q = decode((await post(url, body)).headers.get('payment-required'));
  assert.equal((await post(url, body, { 'payment-signature': baseSignature(q) })).status, 200);
  await answerLogFor(config).flush(); const line = await readFile(config.answerLogFile, 'utf8');
  assert.equal(line.trim().split('\n').length, 1);
  for (const secret of ['lookup','secret','argument','private prompt','call_1']) assert.ok(!line.includes(secret));
});
test('chat schema advertises agent envelope without changing model routes', async t => {
  const { url } = await serve(t);
  const res = await url({}, {}, '/openapi.json'); assert.equal(res.status, 200);
  const doc = await res.json();
  const schema = doc.paths[ROUTE].post.requestBody.content['application/json'].schema;
  assert.equal(schema.properties.max_tokens.maximum, 8192);
  assert.equal(schema.properties.messages.maxItems, 200);
  const pinned = doc.paths[modelRoutePaths()[0]].post.requestBody.content['application/json'].schema;
  assert.equal(pinned.properties.max_tokens.maximum, 1200); assert.equal(pinned.properties.tools, undefined);
  assert.ok(schema.properties.tools); assert.deepEqual(schema.properties.stream.enum, [false]);
});

test('larger default request cannot be quoted without model prices', async t => {
  const { url, facilitator } = await serve(t, { catalogue: null });
  const res = await post(url, body); assert.equal(res.status, 503); assert.equal((await res.json()).error.code, 'quote_unavailable');
  assert.equal(facilitator.calls.verify, 0);
});

test('reasoning-tagged default at 8192 keeps the bounded exact reserve', () => {
  const info = { ...DEFAULT, tags: ['reasoning'] };
  assert.equal(exactReserveTokens(info.id, 8192, info), 256);
  const input = { ...agent({ messages: [{ role: 'user', content: 'Hi' }], max_tokens: 8192 }), isDefault: true, share: 1 };
  assert.deepEqual(ceilings(info, input), { upto: { [BASE]: '4078', [SOLANA]: '5078' }, exact: { [BASE]: '1990', [SOLANA]: '2990' } });
});

import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { BASE, SOLANA, ROUTE, createApp } from '../../src/app.mjs';
import { UnknownModel } from '../../src/catalogue.mjs';
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

async function serve(t, { upstream, config = CONFIG, catalogue = fakeCatalogue, fetchImpl, log = () => {}, clock } = {}) {
  const facilitator = fakeFacilitator();
  const asked = [];
  const answer = upstream === null ? undefined : upstream ?? (async (_config, messages, maxTokens) => {
    asked.push({ messages, maxTokens });
    return { content: "Try Caffè Propaganda.", finishReason: "stop", usage: { total_tokens: 42, buyer_cost_micro: 100 } };
  });
  const app = createApp(config, { facilitatorClient: facilitator, upstream: answer, log, catalogue, fetchImpl, clock });
  // Exercise the actual Express and x402 middleware without binding a network socket.
  const url = async (body, headers = {}, path = ROUTE) => {
    const chunks = [];
    app.locals.testWireBytes = 0;
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); app.locals.testWireBytes += chunk.length; app.locals.testOnWire?.(Buffer.from(chunk).toString()); callback(); } });
    socket.remoteAddress = '127.0.0.1';
    const req = new IncomingMessage(socket);
    req.method = ['/openapi.json', '/numbers.json', '/v1/models'].includes(path) ? 'GET' : 'POST'; req.url = path; req.httpVersionMajor = 1; req.httpVersionMinor = 1; req.httpVersion = '1.1';
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
        // The status line that went out; res.statusCode may be changed after a stream's head is committed (it is how the payment middleware is told not to charge).
        resolve(new Response(data || null, { status: Number(head[0].split(' ')[1]), headers: responseHeaders }));
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



export { post, serve, CONFIG, fakeCatalogue, QUESTION, decode, baseSignature, exactSignature, SOLANA_PAY_TO, BASE_PAY_TO, PAYER, PRICEY, CHEAP, IDLE };

// A fetch Response carrying SSE frames. `steps` is a list of frame strings or numbers (ms to wait before the next one);
// `onFrame(index)` runs as each frame is produced, so a test can tell when the upstream last spoke.
export function sseResponse(steps, { onFrame, headers, status = 200 } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      while (index < steps.length) {
        const step = steps[index++];
        if (typeof step === 'number') { await new Promise(resolve => setTimeout(resolve, step)); continue; }
        onFrame?.(index - 1, step); controller.enqueue(encoder.encode(step)); return;
      }
      controller.close();
    },
  }), { status, headers: { 'content-type': 'text/event-stream', ...headers } });
}

import { createApp, askSurplus } from '../../src/app.mjs';
import { BASE } from '../../src/pricing.mjs';
export function fixture(fetchImpl) {
  const info = { id: 'tagged', tags: ['reasoning'], params: ['max_tokens', 'reasoning'], promptUsdPerToken: 0, completionUsdPerToken: 0.000001 };
  const catalogue = { resolve: async () => info, list: async () => [info], canAnswer: async () => true };
  const app = createApp({ model: 'tagged', surplusUrl: 'https://unused.invalid' }, {
    catalogue, fetchImpl, upstream: askSurplus, log() {},
    facilitatorClient: { getSupported: async () => ({ kinds: [], extensions: [], signers: {} }) },
  });
  return { app, info };
}
export function response() {
  return { statusCode: 200, locals: {}, headers: {},
    set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
}
export async function invoke(app, info, route, scheme = 'upto') {
  const accepted = { network: BASE, scheme };
  const input = { model: info.id, info, maxTokens: 32, chars: 5, messageCount: 1, messages: [{ role: 'user', content: 'hello' }] };
  const request = route === '/v1/messages' ? { model: info.id, messages: input.messages, max_tokens: 32 }
    : { model: info.id, input: 'hello', max_output_tokens: 32 };
  const req = { askInput: input, format: { ...input, request }, askCeilings: { upto: { [BASE]: '1500' }, exact: { [BASE]: '1500' } },
    get: name => name === 'payment-signature' ? Buffer.from(JSON.stringify({ accepted })).toString('base64') : undefined };
  const layers = (app.router ?? app._router).stack.filter(l => l.route?.path === route && l.route.methods.post);
  const res = response();
  await layers.at(-1).route.stack.at(-1).handle(req, res);
  return res;
}
export function exhaustedFormat(route) {
  return route === '/v1/messages' ? { type: 'message', content: [{ type: 'thinking', thinking: '...' }], stop_reason: 'max_tokens' }
    : { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning', summary: [] }] };
}
export function answeredFormat(route) {
  return route === '/v1/messages' ? { type: 'message', content: [{ type: 'text', text: 'hello' }], usage: { buyer_cost_micro: 5000 } }
    : { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }], usage: { buyer_cost_micro: 5000 } };
}

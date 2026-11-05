// Local fake-only SDK exercise. No provider, facilitator, wallet or network client is used.
import { createApp, BASE, SOLANA } from '../src/app.mjs';
import { UnknownModel } from '../src/catalogue.mjs';
const model = { id: 'session-model', name: 'Session fake', provider: 'fake', contextLength: 100000, promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 };
const catalogue = { async list() { return [model]; }, async resolve(id) { if (id !== model.id) throw new UnknownModel('Unknown model.'); return model; }, async canAnswer() { return true; } };
const facilitatorClient = {
  async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: BASE }, { x402Version: 2, scheme: 'exact', network: SOLANA }], extensions: [], signers: {} }; },
  async verify() { throw new Error('This fake session server cannot verify payments.'); },
  async settle() { throw new Error('This fake session server cannot settle payments.'); },
};
const upstream = async (_config, messages, _maxTokens, _fetch, _model, options) => {
  const last = messages.at(-1), user = messages.findLast(m => m.role === 'user');
  const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
  if (options?.agent?.tools?.length && last?.role !== 'tool') {
    const name = options.agent.tools[0].function.name;
    return { content: null, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_session', type: 'function', function: { name, arguments: '{}' } }] }, finishReason: 'tool_calls', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, buyer_cost_micro: 1 } };
  }
  return { content: last?.role === 'tool' ? `Tool result: ${last.content}` : `Echo: ${text}`, finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, buyer_cost_micro: 1 } };
};
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535');
const app = createApp({ model: model.id, freeModels: [model.id], freeBudgetUsdPerDay: 0, freeLimits: { perVisitorPerDay: 1000, perDay: 10000 }, surplusUrl: 'https://fake.invalid', observedFile: null }, { catalogue, facilitatorClient, upstream, fetchImpl: async () => { throw new Error('Network disabled in session server'); }, log: () => {} });
const server = app.listen(port, '127.0.0.1', () => console.log(`READY http://127.0.0.1:${port}/v1`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());

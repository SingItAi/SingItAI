import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reasoningHeadroom, REASONING_FLOOR_TOKENS, setReasoningHeadroomOverrides, ceilingAtomic, TERMS, SOLANA_TERMS, exactReserveTokens, setExactReserve, DEFAULT_EXACT_RESERVE, EXACT_RESERVE_FULL, isUptoPrimary } from '../src/pricing.mjs';
import { askSurplus, priceRange } from '../src/app.mjs';
import { ceilings } from '../src/metered.mjs';
import { withHeadroom } from '../src/formats.mjs';
import { MODEL_ROUTES, modelExample, modelPriceRange } from '../src/model-routes.mjs';
import { LIMITS } from '../src/limits.mjs';
const entries = [
  { id: 'tagged', tags: ['reasoning'], headroom: 256 },
  { id: 'gemini-3.1-pro-preview', tags: ['reasoning'], headroom: 1024 },
  { id: 'claude-opus-5.5', tags: ['reasoning'], headroom: 256 },
  { id: 'plain', tags: [], headroom: 0 },
  { id: 'qwen3.5-plus', tags: [], headroom: 256 },
].map(m => ({ ...m, promptUsdPerToken: 0, completionUsdPerToken: 1 / 1024 }));
afterEach(() => { setReasoningHeadroomOverrides({}); setExactReserve(DEFAULT_EXACT_RESERVE); });
test('floor rule and process override, including zero', () => {
  assert.equal(REASONING_FLOOR_TOKENS, 256);
  for (const m of entries) assert.equal(reasoningHeadroom(m.id, m), m.headroom);
  setReasoningHeadroomOverrides({ tagged: 0, 'gemini-3.1-pro-preview': 128 });
  assert.equal(reasoningHeadroom('tagged', entries[0]), 0);
  assert.equal(reasoningHeadroom('gemini-3.1-pro-preview', entries[1]), 128);
  assert.equal(reasoningHeadroom('__proto__'), 0);
});
test('ceiling and every upstream format price and send the same headroom', async () => {
  const size = { chars: 0, messageCount: 1, maxTokens: 32 };
  for (const info of entries) {
    const provider = BigInt(Math.ceil((32 + info.headroom) / 1024 * 1e6));
    const expected = String(provider + (provider * 3000n + 9999n) / 10000n + 1000n);
    assert.equal(ceilingAtomic(info, size, TERMS), expected);
    const quoted = ceilings(info, size);
    assert.equal(quoted.upto[Object.keys(quoted.upto)[0]], expected);
    const reserve = exactReserveTokens(info.id, size.maxTokens, info) ?? info.headroom;
    const exactProvider = BigInt(Math.ceil((Math.ceil(32 * 0.3) + reserve) / 1024 * 1e6));
    const exactExpected = String(exactProvider + (exactProvider * 3000n + 9999n) / 10000n + 1000n);
    assert.equal(quoted.exact[Object.keys(quoted.exact)[0]], exactExpected);
    let body;
    await askSurplus({ surplusUrl: 'https://unused.invalid' }, [], 32, async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));
    }, info.id, { info });
    assert.equal(body.max_tokens, 32 + info.headroom);
    assert.equal(withHeadroom({ model: info.id, max_tokens: 32 }, info).max_tokens, body.max_tokens);
    assert.equal(withHeadroom({ model: info.id, max_output_tokens: 32 }, info).max_output_tokens, body.max_tokens);
    assert.equal(exactReserveTokens(info.id, 32, info), info.headroom && info.headroom <= 256 ? 32 : null);
  }
  assert.equal(exactReserveTokens('claude-opus-5.5', 32, entries[2]), 32);
});
test('all listed maximum prices cover maximum-size model quotes', async () => {
  const catalogue = { resolve: async id => entries.find(m => m.id === id), list: async () => entries };
  const generic = await priceRange(catalogue);
  for (const info of entries) {
    const range = await modelPriceRange(catalogue, info);
    const size = { chars: LIMITS.chars, messageCount: LIMITS.messages, maxTokens: LIMITS.maxTokens, charsPerToken: 1 };
    const quote = Number(ceilingAtomic(info, size, SOLANA_TERMS));
    assert.ok(Math.round(Number(range.max) * 1e6) >= quote);
    assert.ok(Math.round(Number(generic.max) * 1e6) >= quote);
  }
});
test('reasoning model route examples provide at least 640 upstream tokens', () => {
  const fixture = new Set(['claude-haiku-5.5', 'claude-opus-5.5', 'gpt-5.5', 'gemini-3.1-pro-preview']);
  for (const model of MODEL_ROUTES.filter(m => fixture.has(m.id))) {
    const info = { ...model, tags: ['reasoning'] };
    const example = modelExample(model);
    assert.ok(example.max_tokens + reasoningHeadroom(model.id, info) >= 640);
    assert.match(example.messages[0].content, /one sentence/);
  }
});

// Pre-floor pricing formula from the branch's committed baseline: full explicit
// headroom, except Opus's reduced reserve. Keep independent of ceilingAtomic.
function baselinePrice(info, size, scheme, headroom = 0) {
  const input = Math.ceil(size.chars / (scheme === 'upto' ? 1 : 4)) + 4 * size.messageCount;
  const output = scheme === 'upto' ? size.maxTokens : Math.ceil(size.maxTokens * 0.3);
  const provider = BigInt(Math.ceil((input * info.promptUsdPerToken
    + (output + headroom) * info.completionUsdPerToken) * size.share * 1e6));
  return String([1500n, provider + (provider * 3000n + 9999n) / 10000n + 1000n].reduce((a, b) => a > b ? a : b));
}
const priced = (id, input, output, tags = ['reasoning']) => ({ id, tags,
  promptUsdPerToken: input / 1e6, completionUsdPerToken: output / 1e6 });
const comparisonFixtures = [
  priced('claude-opus-5.5', 5, 25),
  priced('claude-sonnet-5.5', 3, 15),
  priced('gpt-5.5', 5, 30),
  priced('deepseek-v4.1-flash', 0.14, 0.28),
];
test('generic-floor exact reserve, explicit larger headroom, and baseline compatibility', () => {
  const size = { chars: 42, messageCount: 1, maxTokens: 400, share: 0.3 };
  const table = [
    [priced('cheap', 0.14, 0.28), 256, 100],
    [priced('expensive', 30, 180), 256, 100],
    [priced('gemini-3.1-pro-preview', 2, 12), 1024, 1024],
    [priced('plain', 5, 30, []), 0, 0],
    [priced('claude-opus-5.5', 5, 25), 256, 100],
    [priced('qwen3.5-plus', 1, 2, []), 256, 100],
  ];
  for (const [info, full, reserve] of table) {
    const quote = ceilings(info, size);
    assert.equal(quote.upto['eip155:8453'], baselinePrice(info, size, 'upto', full), info.id);
    assert.equal(quote.exact['eip155:8453'], baselinePrice(info, size, 'exact', reserve), info.id);
    assert.equal(exactReserveTokens(info.id, 400, info), reserve === 100 ? 100 : null);
    assert.equal(isUptoPrimary(info.id), info.id.startsWith('claude-opus-'));
    setExactReserve(EXACT_RESERVE_FULL);
    assert.equal(exactReserveTokens(info.id, 400, info), null);
    assert.equal(ceilings(info, size).exact['eip155:8453'], baselinePrice(info, size, 'exact', full));
    setExactReserve(DEFAULT_EXACT_RESERVE);
  }
  setReasoningHeadroomOverrides({ expensive: 16 });
  assert.equal(exactReserveTokens('expensive', 400, table[1][0]), 16);
});
test('compare-402 exact price delta from no headroom, in micro-USDC', t => {
  const size = { chars: 42, messageCount: 1, maxTokens: 500, share: 0.3 };
  const expectedDeltas = [1218, 731, 1463, 0];
  comparisonFixtures.forEach((info, i) => {
    const without = baselinePrice(info, size, 'exact');
    const withFloor = ceilings(info, size).exact['eip155:8453'];
    const delta = Number(BigInt(withFloor) - BigInt(without));
    t.diagnostic(`${info.id}: no headroom=${without}, floor reserve=${withFloor}, delta=${delta} micro-USDC`);
    assert.equal(withFloor, baselinePrice(info, size, 'exact', 125));
    assert.equal(delta, expectedDeltas[i], info.id);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentFailureLine, transactionAccounts, malformedPaymentWarning, paymentExtractor } from '../src/payment-diagnostics.mjs';
import { addFreeRoute, freeTerms } from '../src/free.mjs';
import { UpstreamError } from '../src/app.mjs';
import { addPaymentRoute } from '../src/metered.mjs';
import { x402ResourceServer, x402HTTPResourceServer, ExpressAdapter } from '@x402/express';

const payer = '7xKX' + 'a'.repeat(32) + '9abc';
const ata = '8yLY' + 'b'.repeat(32) + '8def';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const requirements = { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', scheme: 'exact', amount: '1234' };
const payload = { payer, sourceTokenAccount: ata };

test('failure diagnostics preserve facilitator codes in reason fields and thrown messages', () => {
  const code = 'invalid_exact_svm_payload_transaction_simulation_failed';
  const message = 'simulation failed: transaction would fail on-chain: map[InstructionError:[2 InvalidAccountData]]';
  for (const error of [
    { errorReason: code, message },
    { invalidReason: code, invalidMessage: message },
    Object.assign(new Error(`${code}: ${message}`), { name: 'VerifyError' }),
  ]) {
    const line = paymentFailureLine('/ask', 'verify failed', { requirements, error });
    assert.equal(line.split(' reason=')[1], `${code}: ${message}`);
  }
});

test('failure diagnostics still redact secrets in codes, messages and embedded-code remainders', () => {
  // Synthetic fixtures only.
  for (const secret of ['Ab9+/='.repeat(6) + 'Ab9+', 'Bearer xyz', 'Authorization: private-fixture', '0x1234abcdef']) {
    for (const error of [
      { errorReason: secret, message: 'simulation failed' },
      { invalidReason: secret, invalidMessage: 'simulation failed' },
      { errorReason: 'simulation_failed', message: secret },
      new Error(secret),
      new Error(`invalid_exact_svm_payload_transaction_simulation_failed: ${secret}`),
    ]) {
      const reason = paymentFailureLine('/ask', 'verify failed', { requirements, error }).split(' reason=')[1];
      assert.ok(reason.includes('[redacted]'));
      assert.ok(!reason.includes(secret));
      assert.ok(!reason.includes('xyz'));
      assert.ok(!reason.includes('private-fixture'));
    }
  }
});

test('Solana failure diagnostics truncate accounts and redact/cap untrusted reason', () => {
  const header = encode({ payload });
  for (const error of [{ errorReason: 'invalid_account_data', message: `InvalidAccountData\n${payer} ${ata} ${header} Authorization: Bearer secret` },
    { invalidReason: 'invalid_account_data', invalidMessage: 'x'.repeat(900) }]) {
    const line = paymentFailureLine('POST /ask', 'verify failed', { requirements, paymentPayload: { payload }, error });
    assert.match(line, /payer=7xKX\.\.\.9abc ata=8yLY\.\.\.8def/);
    assert.match(line, /scheme=exact amount=1234/);
    assert.ok(line.includes(`network=${requirements.network}`));
    assert.match(line, /invalid_account_data/);
    for (const secret of [payer, ata, header, 'secret', '\n']) assert.ok(!line.includes(secret));
    assert.ok(line.split(' reason=')[1].length <= 200);
  }
  const line = paymentFailureLine('/ask', 'settle failed', { requirements,
    transportContext: { request: { adapter: { getHeader: name => name === 'x-payment' ? header : undefined } } },
    error: new Error('InvalidAccountData') });
  assert.match(line, /ata=8yLY\.\.\.8def/);
  assert.match(paymentFailureLine('/ask', 'settle failed', { requirements,
    paymentPayload: { payload: { channelConfig: { payer } } }, error: new Error('invalid_account_data') }),
  /payer=7xKX\.\.\.9abc ata=unknown/);
});

// A wire-format transaction with a token TransferChecked instruction; no keys or signatures are used to sign.
function transaction(versioned = false) {
  const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const c of token) n = n * 58n + BigInt(alphabet.indexOf(c));
  const program = Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 9),
    Buffer.from(versioned ? [128, 1, 0, 1, 5] : [1, 0, 1, 5]),
    Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3), Buffer.alloc(32, 4), program,
    Buffer.alloc(32), Buffer.from([1, 4, 4, 1, 2, 3, 0, 10, 12]), Buffer.alloc(9),
    ...(versioned ? [Buffer.from([0])] : [])]).toString('base64');
}
test('extract static source/authority keys from legacy and v0 TransferChecked; tolerate malformed transactions', () => {
  for (const versioned of [false, true]) {
    const accounts = transactionAccounts(transaction(versioned));
    assert.equal(accounts.payer, '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi');
    assert.equal(accounts.ata, '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR');
    const line = paymentFailureLine('/ask', 'settle failed', { requirements,
      paymentPayload: { payload: { transaction: transaction(versioned) } }, error: new Error('InvalidAccountData') });
    assert.match(line, /payer=4vJ9\.\.\.kLKi ata=8qbH\.\.\.VfeR/);
    assert.ok(!line.includes(accounts.ata)); assert.ok(!line.includes(accounts.payer));
  }
  for (const value of [undefined, '', '!!!', Buffer.alloc(100).toString('base64')]) assert.deepEqual(transactionAccounts(value), {});
});

test('failure hooks cover returned invalid verify, thrown verify and failed settle', async () => {
  const lines = [];
  const server = new x402ResourceServer({ getSupported: async () => ({ kinds: [] }) });
  const app = { locals: {}, post() {}, use() {} };
  addPaymentRoute(app, { 'POST /ask': { accepts: [] } }, server,
    { discoverable: false, log: line => lines.push(line), permitGuard: { middleware() {}, record() {} } });
  const ctx = { requirements, paymentPayload: { payload }, error: new Error('InvalidAccountData') };
  for (const hook of server.onVerifyFailureHooks) await hook(ctx);
  for (const hook of server.onSettleFailureHooks) await hook(ctx);
  for (const hook of server.afterVerifyHooks) await hook({ ...ctx, error: undefined, result: { isValid: false, invalidReason: 'invalid_account_data' } });
  assert.equal(lines.length, 3);
  for (const line of lines) { assert.match(line, /payer=7xKX\.\.\.9abc ata=8yLY\.\.\.8def/); assert.ok(!line.includes(payer)); assert.ok(!line.includes(ata)); }
});

test('malformed header warns once per minute across extractors, with suppressed count and no stack; fallback unchanged', () => {
  let time = 0;
  const lines = [], warn = malformedPaymentWarning({ now: () => time });
  const extractors = [paymentExtractor(line => lines.push(line), warn), paymentExtractor(line => lines.push(line), warn)];
  const headers = ['!!!', Buffer.from('{').toString('base64')];
  const original = new x402HTTPResourceServer(new x402ResourceServer(), {});
  const previousWarn = console.warn;
  try {
    console.warn = () => {};
    for (let i = 0; i < 4; i++) {
      const req = { path: '/ask', header: () => headers[i % 2] };
      const adapter = new ExpressAdapter(req);
      assert.equal(extractors[i % 2](adapter), original.extractPayment(adapter));
    }
    assert.equal(lines.length, 1);
    time = 59_999; extractors[0](new ExpressAdapter({ path: '/other', header: () => headers[0] }));
    assert.equal(lines.length, 1);
    time = 60_000; extractors[1](new ExpressAdapter({ path: '/other', header: () => headers[1] }));
    assert.equal(lines.length, 2);
    assert.match(lines[1], /on \/other \(SyntaxError\) suppressed=4$/);
    for (const line of lines) { assert.ok(!line.includes('\n')); assert.ok(!line.includes(' at ')); assert.ok(!line.includes(headers[1])); }
    const valid = encode({ accepted: requirements, payload });
    assert.deepEqual(extractors[0](new ExpressAdapter({ path: '/ask', header: () => valid })), { accepted: requirements, payload });
  } finally { console.warn = previousWarn; }
});

test('free upstream failures log code/status, other failures name only, and keep the 503 response', async () => {
  for (const error of [new UpstreamError('private message', { code: 'model_unavailable', status: 429 }), new TypeError('private message')]) {
    let handler; const lines = [];
    const terms = freeTerms({ freeModels: ['test'], freeBudgetUsdPerDay: 0 });
    addFreeRoute({ post: (_route, fn) => { handler = fn; } }, '/ask', { config: {}, terms,
      readRequest: () => ({ chars: 1, messages: [], maxTokens: 1 }), RequestError: class extends Error {},
      upstream: async () => { throw error; }, log: line => lines.push(line) });
    const response = { set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await handler({ body: { model: 'free/test' }, get: () => '127.0.0.1' }, response, () => assert.fail());
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { error: { message: 'No answer came back. Try again.', type: 'upstream_error', code: 'no_billable_answer' } });
    assert.equal(lines.length, 1);
    if (error.name === 'UpstreamError') assert.match(lines[0], /UpstreamError code=model_unavailable status=429/);
    else assert.match(lines[0], /\(TypeError\)$/);
    assert.ok(!lines[0].includes('private message'));
  }
});

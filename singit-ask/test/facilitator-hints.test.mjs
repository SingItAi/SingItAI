import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VerifyError } from '@x402/core/types';
import { x402ResourceServer } from '@x402/core/server';
import { withFacilitatorHints } from '../src/facilitator-hints.mjs';
import { paymentFailureLine } from '../src/payment-diagnostics.mjs';

const requirements = { network: 'solana:mainnet', scheme: 'exact', amount: '100' };
const failure = { isValid: false, invalidReason: 'simulation_failed', invalidMessage: 'InstructionError [2, InvalidAccountData]' };
const expected = "simulation_failed: The payer's USDC token account is missing or not initialised. Fund the wallet with USDC on Solana mainnet so the associated token account exists, and send the payment from the wallet that owns that account.";

for (const thrown of [false, true]) test(`hints ${thrown ? 'thrown' : 'returned'} Solana failures through resource server`, async () => {
  const original = thrown ? new VerifyError(400, failure) : { ...failure };
  const client = withFacilitatorHints({ async verify() { if (thrown) throw original; return original; } });
  const server = new x402ResourceServer(client);
  server.register(requirements.network, { scheme: 'exact', defaultAssetTransferMethod: 'spl', paymentFlows: { spl: { default: 'authorization', supported: ['authorization'] } } });
  let result;
  try { result = await server.verifyPayment({ x402Version: 2 }, requirements); }
  catch (error) {
    assert.ok(thrown);
    assert.ok(error instanceof VerifyError);
    assert.equal(error.statusCode, 400);
    result = error;
  }
  assert.equal(result.invalidReason, expected);
  assert.equal(result.invalidMessage, failure.invalidMessage);
  assert.equal(original.invalidReason, 'simulation_failed');
  // SDK HTTP response uses invalidReason for returned results, Error.message for throws.
  const body = await server.createPaymentRequiredResponse([requirements], { url: 'https://example.test/ask' },
    thrown ? result.message : result.invalidReason);
  assert.equal(body.error, expected);
  const line = paymentFailureLine('/ask', 'verify failed', { requirements, [thrown ? 'error' : 'result']: result });
  assert.match(line, /simulation_failed.*InvalidAccountData/);
  assert.ok(!line.includes('Fund the wallet'));
});

test('matches underscore spelling in reason, preserving machine prefix and excluding raw text', async () => {
  const result = await withFacilitatorHints({ verify: async () => ({ isValid: false,
    invalidReason: 'invalid_account_data', invalidMessage: 'private simulation text\n' + 'A'.repeat(44) }) }).verify({}, requirements);
  assert.ok(result.invalidReason.startsWith('invalid_account_data: '));
  assert.ok(!result.invalidReason.includes('private'));
  assert.match(result.invalidReason, /^[\x20-\x7e]+$/);
});

test('unaffected results and exceptions retain identity', async () => {
  for (const req of [requirements, { ...requirements, network: 'eip155:8453' }]) {
    for (const value of [{ ...failure, isValid: true }, { ...failure, invalidMessage: 'InsufficientFunds' },
      ...(req.network.startsWith('eip155:') ? [failure] : [])]) {
      assert.equal(await withFacilitatorHints({ verify: async () => value }).verify({}, req), value);
    }
    for (const error of [new Error('InvalidAccountData'), new VerifyError(400, { ...failure, invalidMessage: 'InsufficientFunds' }),
      ...(req.network.startsWith('eip155:') ? [new VerifyError(400, failure)] : [])]) {
      await assert.rejects(withFacilitatorHints({ verify: async () => { throw error; } }).verify({}, req), actual => actual === error);
    }
  }
});

test('delegates supported, settle and other methods with original receiver and arguments', async () => {
  const client = { marker: {}, getSupported(...args) { assert.equal(this, client); return args; },
    settle(...args) { assert.equal(this, client); return args; }, extra() { return this.marker; } };
  const wrapped = withFacilitatorHints(client);
  assert.deepEqual(await wrapped.getSupported('a'), ['a']);
  assert.deepEqual(await wrapped.settle('b', 'c'), ['b', 'c']);
  assert.equal(wrapped.extra(), client.marker);
});

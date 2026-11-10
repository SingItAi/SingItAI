import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { createApp, ROUTE } from '../src/app.mjs';
import { SOLANA, SOLANA_TERMS, SOLANA_ASSET, SOLANA_PAY_TO, billUsage } from '../src/pricing.mjs';
import {
  INCIDENT_2208, ERR_CHANNEL_ALREADY_OPEN, ERR_MISSING_VOUCHER, ERR_PAYLOAD_TYPE,
  selectUptoSvmSettlePath, simulateUptoSvmSettle,
  createUptoSvmServerScheme, applySettlementOverrideAmount,
} from '../src/upto-svm-claim.mjs';

const encode = v => Buffer.from(JSON.stringify(v)).toString('base64');
const decode = v => JSON.parse(Buffer.from(v, 'base64').toString());
const sig = 'a'.repeat(88);
const signer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(23));
const feePayer = 'Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88';
const authorizer = '9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox';

// Redacted 22:08 client shape: no type, no voucher. Never reuse a live payer.
function incidentPayload(maxAmount) {
  return {
    from: '[P1]',
    channelId: '[CHANNEL]',
    maxAmount,
    deposit: maxAmount,
    nonce: '1',
    openSlot: '123',
    openTransaction: 'mock',
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    validAfter: Math.floor(Date.now() / 1000),
    authorizedSigner: '[AUTH]',
  };
}

test('22:08 payload with type stripped and amount==maxAmount opens as deposit', () => {
  for (const ceiling of INCIDENT_2208.ceilingsAtomic) {
    const seen = simulateUptoSvmSettle(
      { payload: incidentPayload(ceiling) },
      { amount: ceiling },
      { channelExists: true, stripType: true },
    );
    assert.equal(seen.path, 'deposit');
    assert.equal(seen.success, false);
    assert.equal(seen.errorReason, ERR_CHANNEL_ALREADY_OPEN);
  }
});

test('current SDK outbound (type:claim, billed amount) hits settleClaim', () => {
  const seen = simulateUptoSvmSettle(
    { payload: { ...incidentPayload('2004'), type: 'claim' } },
    { amount: INCIDENT_2208.billedAtomic },
    { channelExists: true },
  );
  assert.equal(seen.path, 'claim');
  assert.equal(seen.success, true);
});

test('type stripped and billed amount without a voucher is missing_voucher, not already_open', () => {
  const seen = simulateUptoSvmSettle(
    { payload: incidentPayload('2004') },
    { amount: INCIDENT_2208.billedAtomic },
    { channelExists: true, stripType: true },
  );
  assert.equal(seen.path, 'invalid');
  assert.equal(seen.errorReason, ERR_MISSING_VOUCHER);
});

test('fixed payload (empty voucherSignature) hits settleClaim even after type is stripped', () => {
  const payload = { ...incidentPayload('2004'), type: 'claim', voucherSignature: '' };
  const seen = simulateUptoSvmSettle(
    { payload },
    { amount: INCIDENT_2208.billedAtomic },
    { channelExists: true, stripType: true },
  );
  assert.equal(selectUptoSvmSettlePath({ payload }, { amount: '2000' }).path, 'claim');
  assert.equal(seen.path, 'claim');
  assert.equal(seen.success, true);
});

test('delegated facilitator without type still requires an explicit type', () => {
  const seen = simulateUptoSvmSettle(
    { payload: incidentPayload('2004') },
    { amount: INCIDENT_2208.billedAtomic },
    { delegated: true, stripType: true },
  );
  assert.equal(seen.errorReason, ERR_PAYLOAD_TYPE);
});

test('createUptoSvmServerScheme keeps rpcUrl for recentSlot stamping', () => {
  const scheme = createUptoSvmServerScheme({ withdrawDelay: 300, rpcUrl: 'https://api.mainnet-beta.solana.com' });
  assert.equal(scheme.rpcUrl, 'https://api.mainnet-beta.solana.com');
});

test('createUptoSvmServerScheme stamps claim plus an empty voucher on after-handler', async () => {
  const scheme = createUptoSvmServerScheme({ withdrawDelay: 300 });
  const deposit = await scheme.enrichSettlementPayload({
    phase: 'before-handler',
    paymentPayload: { payload: incidentPayload('2004') },
    requirements: { amount: '2004' },
  });
  assert.deepEqual(deposit, { type: 'deposit' });
  assert.equal(Object.prototype.hasOwnProperty.call(deposit, 'voucherSignature'), false);

  const claim = await scheme.enrichSettlementPayload({
    phase: 'after-handler',
    paymentPayload: { payload: incidentPayload('2004') },
    requirements: { amount: INCIDENT_2208.billedAtomic },
  });
  assert.deepEqual(claim, { type: 'claim', voucherSignature: '' });

  const fixed = { payload: { ...incidentPayload('2004'), ...claim } };
  const seen = simulateUptoSvmSettle(fixed, { amount: INCIDENT_2208.billedAtomic }, {
    channelExists: true, stripType: true,
  });
  assert.equal(seen.path, 'claim');
});

test('after-handler Settlement-Overrides rewrite the ceiling on the settle requirements', () => {
  const requirements = { scheme: 'upto', amount: '2004' };
  applySettlementOverrideAmount({
    phase: 'before-handler',
    requirements,
    transportContext: { responseHeaders: { 'settlement-overrides': JSON.stringify({ amount: '2000' }) } },
  });
  assert.equal(requirements.amount, '2004');
  applySettlementOverrideAmount({
    phase: 'after-handler',
    requirements,
    transportContext: { responseHeaders: { 'Settlement-Overrides': JSON.stringify({ amount: '2000' }) } },
  });
  assert.equal(requirements.amount, '2000');
});

test('public route: type-stripping facilitator still claims after the handler', async t => {
  const settles = [];
  const facilitator = {
    getSupported: async () => ({ kinds: [
      { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
      { x402Version: 2, scheme: 'upto', network: 'eip155:8453', extra: { facilitatorAddress: '0x' + '1'.repeat(40) } },
      { x402Version: 2, scheme: 'exact', network: SOLANA, extra: { feePayer } },
      { x402Version: 2, scheme: 'upto', network: SOLANA, extra: { feePayer, receiverAuthorizer: authorizer } },
    ], extensions: [], signers: {} }),
    verify: async () => ({ isValid: true, payer: signer.address }),
    settle: async (p, r) => {
      const raw = { ...p.payload };
      settles.push({
        type: raw.type,
        amount: r.amount,
        maxAmount: raw.maxAmount,
        hasVoucherKey: Object.prototype.hasOwnProperty.call(raw, 'voucherSignature'),
        voucherLength: typeof raw.voucherSignature === 'string' ? raw.voucherSignature.length : null,
      });
      const stripped = { ...p, payload: { ...raw } };
      delete stripped.payload.type;
      const seen = simulateUptoSvmSettle(stripped, r, { channelExists: settles.length > 1 });
      if (!seen.success) {
        return { success: false, errorReason: seen.errorReason, errorMessage: seen.errorReason,
          network: SOLANA, payer: signer.address, transaction: '' };
      }
      return { success: true, network: SOLANA, payer: signer.address, transaction: sig, amount: r.amount };
    },
  };
  const app = createApp({ payToBase: '0x' + '1'.repeat(40), payToSolana: SOLANA_PAY_TO }, {
    facilitatorClient: facilitator, log: () => {},
    upstream: async () => ({ content: 'Hello', usage: { buyer_cost_micro: 100 } }),
  });
  const listener = await new Promise(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  t.after(() => listener.close());
  const send = h => fetch(`http://127.0.0.1:${listener.address().port}${ROUTE}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...h },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
  });
  const first = await send({});
  assert.equal(first.status, 402);
  const q = decode(first.headers.get('payment-required'));
  const accepted = q.accepts.find(a => a.network === SOLANA);
  const payload = {
    from: signer.address, channelId: authorizer, maxAmount: accepted.amount, deposit: accepted.amount,
    nonce: '1', openSlot: '123', openTransaction: 'mock',
    expiresAt: Math.floor(Date.now() / 1000) + 300, validAfter: Math.floor(Date.now() / 1000),
    authorizedSigner: authorizer,
  };
  const response = await send({ 'PAYMENT-SIGNATURE': encode({ x402Version: 2, resource: q.resource, accepted, payload }) });
  assert.equal(response.status, 200);
  assert.equal(decode(response.headers.get('payment-response')).amount, billUsage({ buyer_cost_micro: 100 }, SOLANA_TERMS).totalAtomic);
  assert.equal(settles.length, 2);
  assert.equal(settles[0].type, 'deposit');
  assert.equal(settles[0].hasVoucherKey, false);
  assert.equal(settles[1].type, 'claim');
  assert.equal(settles[1].hasVoucherKey, true);
  assert.equal(settles[1].voucherLength, 0);
  assert.notEqual(settles[1].amount, settles[1].maxAmount);
});

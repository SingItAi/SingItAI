import test from 'node:test';
import assert from 'node:assert/strict';
import { getBase58Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { InvoiceTransfers } from '../src/invoice.mjs';
import { TokenAllowance, usdcAccount } from '../src/allowance.mjs';
import { dispatch } from '../src/gateway.mjs';
import { Store } from '../src/store.mjs';
import { USDC, TOKEN_PROGRAM, ATA_PROGRAM } from '../src/config.mjs';
import { testWallet, directory } from './helpers.mjs';

const INVOICE = 'c9f81d5d-269e-4c65-bc81-989c5b84485a';
const BLOCKHASH = '11111111111111111111111111111111';

function tokenAccount(owner, { amount = 20_000_000n, delegate = null, delegated = 0n, state = 1 } = {}) {
  const data = Buffer.alloc(165);
  const enc = getBase58Encoder();
  Buffer.from(enc.encode(USDC)).copy(data, 0);
  Buffer.from(enc.encode(owner)).copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  if (delegate) { data.writeUInt32LE(1, 72); Buffer.from(enc.encode(delegate)).copy(data, 76); data.writeBigUInt64LE(delegated, 121); }
  data[108] = state;
  return data;
}

// Solana at the RPC level: token accounts by address, the agent's SOL, a fee, a send and its status.
function fakeRpc({ accounts, sol = 10_000_000n, fee = 5000n, status = 'confirmed' }) {
  const sent = [];
  const call = value => ({ send: async () => value });
  return {
    sent,
    getAccountInfo: address => call({ value: accounts[address] ? { owner: TOKEN_PROGRAM, data: [accounts[address].toString('base64'), 'base64'] } : null }),
    getLatestBlockhash: () => call({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    getBalance: () => call({ value: sol }),
    getFeeForMessage: () => call({ value: fee }),
    getMinimumBalanceForRentExemption: size => call(size === 0 ? 890_880n : 2_039_280n),
    sendTransaction: wire => { sent.push(wire); return call('sig'); },
    getSignatureStatuses: () => call({ value: [status && { confirmationStatus: status, err: null }] }),
  };
}

async function setup(options = {}) {
  const [owner, agent, deposit, feePayer] = [await testWallet(), await testWallet(), await testWallet(), await testWallet()];
  const accounts = {
    [await usdcAccount(owner.address)]: tokenAccount(owner.address, { delegate: agent.address, delegated: options.delegated ?? 5_000_000n }),
    ...(options.noDepositAccount ? {} : { [await usdcAccount(deposit.address)]: tokenAccount(deposit.address, { amount: 0n, state: options.depositState ?? 1 }) }),
    ...(options.noFeeAccount ? {} : { [await usdcAccount(feePayer.address)]: tokenAccount(feePayer.address, { amount: 0n }) }),
  };
  const rpc = fakeRpc({ accounts, ...options });
  const chain = { rpc };
  const allowance = new TokenAllowance({ chain, sleep: async () => {}, confirmTimeoutMs: 10 });
  const store = new Store(directory());
  const transfers = new InvoiceTransfers({ wallet: agent, chain, store, feePayer: options.noFeePayer ? null : feePayer, allowance });
  const pay = (extra = {}) => transfers.pay({ invoiceId: INVOICE, payTo: deposit.address, amount: '70000', feeAmount: '1000', owner: owner.address, ...extra });
  return { owner, agent, deposit, feePayer, rpc, chain, store, allowance, pay };
}

function decoded(wire) {
  const tx = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const instructions = message.instructions.map(ix => ({
    program: message.staticAccounts[ix.programAddressIndex], data: [...ix.data],
    accounts: (ix.accountIndices || []).map(i => message.staticAccounts[i]) }));
  return { tx, message, instructions };
}

test('the invoice and its network fee both leave the owner in USDC; our fee payer pays the SOL', async () => {
  const { owner, agent, deposit, feePayer, rpc, store, pay } = await setup();
  const paid = await pay();
  assert.deepEqual([paid.state, paid.amount, paid.feeAmount], ['confirmed', '70000', '1000']);
  assert.equal(rpc.sent.length, 1);
  const { tx, message, instructions } = decoded(rpc.sent[0]);
  assert.equal(message.staticAccounts[0], feePayer.address, 'our fee payer pays the SOL fee');
  assert.deepEqual(Object.keys(tx.signatures).sort(), [agent.address, feePayer.address].sort());
  assert.equal(instructions.length, 2, 'no account is created when ours exists');
  const source = await usdcAccount(owner.address);
  assert.deepEqual(instructions[0], { program: TOKEN_PROGRAM, data: [12, 0x70, 0x11, 0x01, 0, 0, 0, 0, 0, 6],
    accounts: [source, USDC, await usdcAccount(deposit.address), agent.address] });
  assert.deepEqual(instructions[1], { program: TOKEN_PROGRAM, data: [12, 0xe8, 0x03, 0, 0, 0, 0, 0, 0, 6],
    accounts: [source, USDC, await usdcAccount(feePayer.address), agent.address] }, '0.001 USDC back to the fee payer');
  assert.equal(store.invoiceAttempt(INVOICE).amount, '71000');
});

test('our fee payer opens its own USDC account once, at its own cost', async () => {
  const { feePayer, rpc, pay } = await setup({ noFeeAccount: true });
  await pay();
  const { instructions } = decoded(rpc.sent[0]);
  assert.equal(instructions[0].program, ATA_PROGRAM);
  assert.equal(instructions[0].accounts[0], feePayer.address, 'the fee payer pays the rent');
  assert.equal(instructions.length, 3);
});

test('an invoice is never paid twice', async () => {
  const { rpc, pay } = await setup();
  await pay();
  await assert.rejects(pay(), e => e.code === 'ALREADY_ATTEMPTED');
  assert.equal(rpc.sent.length, 1);
});

test('a fee payer short of SOL sends nothing and says why', async () => {
  const { rpc, store, pay } = await setup({ sol: 895_879n, fee: 5000n });  // one lamport under fee + rent-exempt minimum
  await assert.rejects(pay(), e => e.code === 'FEE_PAYER_LOW' && /needs 895880 lamports, holds 895879/.test(e.reason));
  assert.equal(rpc.sent.length, 0);
  assert.equal(store.invoiceAttempt(INVOICE), null, 'not claimed: the purchase can be tried again');
});

test('without a fee payer nothing is sent', async () => {
  const { rpc, pay } = await setup({ noFeePayer: true });
  await assert.rejects(pay(), e => e.code === 'FEE_PAYER_REQUIRED');
  assert.equal(rpc.sent.length, 0);
});

test('nothing is sent where it should not be', async () => {
  const cases = [
    ['a deposit address with no USDC account', { noDepositAccount: true }, {}, 'RECIPIENT_ACCOUNT_MISSING'],
    ['a deposit account that is not usable', { depositState: 2 }, {}, 'RECIPIENT_ACCOUNT_MISSING'],
    ['an approval that covers the invoice but not its fee', { delegated: 70_999n }, {}, 'ALLOWANCE_TOO_LOW'],
    ['a fee above the sanity ceiling', {}, { feeAmount: '10001' }, 'INVALID_AMOUNT'],
    ['no fee', {}, { feeAmount: '0' }, 'INVALID_AMOUNT'],
    ['a zero amount', {}, { amount: '0' }, 'INVALID_AMOUNT'],
    ['a malformed deposit address', {}, { payTo: '0x7073241f5aff0c5200DBe1DE8f4E143FCCFc31d6' }, 'INVALID_RECIPIENT'],
    ['an invalid invoice id', {}, { invoiceId: 'x;drop' }, 'INVALID_INVOICE'],
  ];
  for (const [name, options, extra, code] of cases) {
    const { rpc, pay } = await setup(options);
    await assert.rejects(pay(extra), e => e.code === code, name);
    assert.equal(rpc.sent.length, 0, name);
  }
  const { owner, agent, feePayer, rpc, pay } = await setup();
  for (const own of [owner.address, agent.address, feePayer.address]) await assert.rejects(pay({ payTo: own }), e => e.code === 'INVALID_RECIPIENT');
  assert.equal(rpc.sent.length, 0);
});

test('an answer that does not confirm stays uncertain and is not repeated', async () => {
  const { store, pay } = await setup({ status: null });
  const paid = await pay();
  assert.equal(paid.state, 'uncertain');
  assert.equal(store.invoiceAttempt(INVOICE).state, 'uncertain');
  await assert.rejects(pay(), e => e.code === 'ALREADY_ATTEMPTED');
});

test('the bridge runs a transfer for the agent that asks', async () => {
  const { owner, agent, deposit, feePayer, chain, store, allowance, rpc } = await setup();
  const paid = await dispatch({ operation: 'bitrefill-invoice-transfer', payer: agent.address, invoiceId: INVOICE,
    payTo: deposit.address, amount: '70000', feeAmount: '1000', owner: owner.address }, { wallet: agent, chain, store, feePayer, allowance });
  assert.equal(paid.state, 'confirmed');
  assert.equal(rpc.sent.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { getBase58Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { InvoiceTransfers } from '../src/invoice.mjs';
import { TokenAllowance, usdcAccount } from '../src/allowance.mjs';
import { dispatch } from '../src/gateway.mjs';
import { Store } from '../src/store.mjs';
import { USDC, TOKEN_PROGRAM } from '../src/config.mjs';
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
function fakeRpc({ accounts, sol = 1_000_000n, fee = 5000n, status = 'confirmed' }) {
  const sent = [];
  const call = value => ({ send: async () => value });
  return {
    sent,
    getAccountInfo: address => call({ value: accounts[address] ? { owner: TOKEN_PROGRAM, data: [accounts[address].toString('base64'), 'base64'] } : null }),
    getLatestBlockhash: () => call({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    getBalance: () => call({ value: sol }),
    getFeeForMessage: () => call({ value: fee }),
    sendTransaction: wire => { sent.push(wire); return call('sig'); },
    getSignatureStatuses: () => call({ value: [status && { confirmationStatus: status, err: null }] }),
  };
}

async function setup(options = {}) {
  const [owner, agent, deposit] = [await testWallet(), await testWallet(), await testWallet()];
  const accounts = {
    [await usdcAccount(owner.address)]: tokenAccount(owner.address, { delegate: agent.address, delegated: options.delegated ?? 5_000_000n }),
    ...(options.noDepositAccount ? {} : { [await usdcAccount(deposit.address)]: tokenAccount(deposit.address, { amount: 0n, state: options.depositState ?? 1 }) }),
  };
  const rpc = fakeRpc({ accounts, ...options });
  const chain = { rpc };
  const allowance = new TokenAllowance({ chain, sleep: async () => {}, confirmTimeoutMs: 10 });
  const store = new Store(directory());
  const transfers = new InvoiceTransfers({ wallet: agent, chain, store, allowance });
  const pay = (extra = {}) => transfers.pay({ invoiceId: INVOICE, payTo: deposit.address, amount: '70000', owner: owner.address, ...extra });
  return { owner, agent, deposit, rpc, chain, store, allowance, pay };
}

test('an MCP invoice is paid by a USDC transfer from the owner to the deposit account, the agent paying the fee', async () => {
  const { owner, agent, deposit, rpc, store, pay } = await setup();
  const paid = await pay();
  assert.equal(paid.state, 'confirmed');
  assert.equal(paid.amount, '70000');
  assert.equal(rpc.sent.length, 1);
  const tx = getTransactionDecoder().decode(Buffer.from(rpc.sent[0], 'base64'));
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(message.staticAccounts[0], agent.address, 'the agent is the fee payer');
  assert.deepEqual(Object.keys(tx.signatures), [agent.address], 'nobody else signs');
  assert.equal(message.instructions.length, 1);
  const [ix] = message.instructions;
  assert.equal(message.staticAccounts[ix.programAddressIndex], TOKEN_PROGRAM);
  assert.deepEqual([...ix.data], [12, 0x70, 0x11, 0x01, 0, 0, 0, 0, 0, 6], 'TransferChecked 70,000 at 6 decimals');
  const used = ix.accountIndices.map(i => message.staticAccounts[i]);
  assert.deepEqual(used, [await usdcAccount(owner.address), USDC, await usdcAccount(deposit.address), agent.address]);
  assert.equal(store.invoiceAttempt(INVOICE).state, 'accepted');
});

test('an invoice is never paid twice', async () => {
  const { rpc, pay } = await setup();
  await pay();
  await assert.rejects(pay(), e => e.code === 'ALREADY_ATTEMPTED');
  assert.equal(rpc.sent.length, 1);
});

test('without SOL for the fee the agent pays nothing and says why', async () => {
  const { rpc, store, pay } = await setup({ sol: 4999n, fee: 5000n });
  await assert.rejects(pay(), e => e.code === 'AGENT_SOL_REQUIRED' && /needs 5000 lamports, holds 4999/.test(e.reason));
  assert.equal(rpc.sent.length, 0);
  assert.equal(store.invoiceAttempt(INVOICE), null, 'not claimed: the purchase can be tried again once funded');
});

test('nothing is sent where it should not be', async () => {
  const cases = [
    ['a deposit address with no USDC account', { noDepositAccount: true }, {}, 'RECIPIENT_ACCOUNT_MISSING'],
    ['a deposit account that is not usable', { depositState: 2 }, {}, 'RECIPIENT_ACCOUNT_MISSING'],
    ['an approval that does not cover it', { delegated: 69_999n }, {}, 'ALLOWANCE_TOO_LOW'],
    ['a zero amount', {}, { amount: '0' }, 'INVALID_AMOUNT'],
    ['a malformed deposit address', {}, { payTo: '0x7073241f5aff0c5200DBe1DE8f4E143FCCFc31d6' }, 'INVALID_RECIPIENT'],
    ['an invalid invoice id', {}, { invoiceId: 'x;drop' }, 'INVALID_INVOICE'],
  ];
  for (const [name, options, extra, code] of cases) {
    const { rpc, pay } = await setup(options);
    await assert.rejects(pay(extra), e => e.code === code, name);
    assert.equal(rpc.sent.length, 0, name);
  }
  const { owner, agent, rpc, pay } = await setup();
  for (const own of [owner.address, agent.address]) await assert.rejects(pay({ payTo: own }), e => e.code === 'INVALID_RECIPIENT');
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
  const { owner, agent, deposit, chain, store, allowance, rpc } = await setup();
  const paid = await dispatch({ operation: 'bitrefill-invoice-transfer', payer: agent.address, invoiceId: INVOICE,
    payTo: deposit.address, amount: '70000', owner: owner.address }, { wallet: agent, chain, store, allowance });
  assert.equal(paid.state, 'confirmed');
  assert.equal(rpc.sent.length, 1);
});

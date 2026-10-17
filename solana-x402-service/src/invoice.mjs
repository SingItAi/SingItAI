// Paying a Bitrefill invoice over x402 on Solana, as Bitrefill documents it for MCP invoices
// created with usdc_solana (docs.bitrefill.com, "Paying an MCP invoice with x402"):
//   1. POST /x402/invoice/pay {invoice_id} answers 402 with a PAYMENT-REQUIRED header;
//   2. the payment is signed and the POST repeated with a PAYMENT-SIGNATURE header; 200 = accepted.
// The wallet is the agent, which holds exactly what the invoice needs (pulled from the owner's
// allowance). Bitrefill's fee payer sponsors the transaction. One attempt per invoice, recorded
// before the only submission; an uncertain result is never retried here.
import { isAddress, partiallySignTransaction } from '@solana/kit';
import { ClientError, NETWORK, USDC, TOKEN_PROGRAM } from './config.mjs';
import { isTransactionId, messageHash } from './chain.mjs';
import { TokenAllowance, assertDelegated, createAccountInstruction, parseTokenAccount, transferInstruction, usdcAccount } from './allowance.mjs';

export const BITREFILL_PAY_URL = 'https://api.bitrefill.com/x402/invoice/pay';

function decode(header) {
  try { return JSON.parse(Buffer.from(header, 'base64').toString('utf8')); }
  catch { throw new ClientError('INVALID_CHALLENGE', 'Bitrefill sent an unreadable payment request.'); }
}

export function selectInvoiceRequirement(challenge, maxAmount, payer) {
  const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
  const matches = accepts.filter(r => r?.scheme === 'exact' && r.network === NETWORK && r.asset === USDC);
  if (matches.length !== 1) throw new ClientError('UNSUPPORTED_PAYMENT', 'Bitrefill offered no single USDC payment on Solana for this invoice.');
  const r = matches[0];
  if (typeof r.amount !== 'string' || !/^[1-9][0-9]*$/.test(r.amount)) throw new ClientError('INVALID_AMOUNT', 'Bitrefill asked for an invalid amount.');
  if (BigInt(r.amount) > BigInt(maxAmount)) throw new ClientError('PRICE_CHANGED', 'Bitrefill now asks more than the invoice you were quoted. Nothing was paid.');
  if (!r.extra?.feePayer || r.extra.feePayer === payer) throw new ClientError('UNEXPECTED_FEE_PAYER', 'This payment must be sponsored by Bitrefill.');
  return structuredClone(r);
}

function transactionOf(response) {
  const header = response.headers.get('payment-response') || response.headers.get('x-payment-response');
  let receipt = null;
  if (header) { try { receipt = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { receipt = null; } }
  const found = [receipt?.transaction, receipt?.txHash];
  return found.find(isTransactionId) || null;
}

export class InvoicePayments {
  constructor({ wallet, chain, store, fetcher = fetch }) { Object.assign(this, { wallet, chain, store, fetcher }); }

  async post(url, headers = {}) {
    try {
      return await this.fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify({ invoice_id: this.invoiceId }), redirect: 'error', signal: AbortSignal.timeout(120000) });
    } catch { throw new ClientError('NETWORK_ERROR', 'Bitrefill did not answer. Nothing was retried.'); }
  }

  async pay({ url, invoiceId, maxAmount, owner = null }) {
    if (url !== BITREFILL_PAY_URL) throw new ClientError('UNSUPPORTED_MERCHANT', 'Only Bitrefill invoices are paid here.');
    if (typeof invoiceId !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(invoiceId)) throw new ClientError('INVALID_INVOICE', 'Invalid invoice.');
    if (!/^[1-9][0-9]*$/.test(String(maxAmount))) throw new ClientError('INVALID_AMOUNT', 'Invalid maximum amount.');
    if (this.store.invoiceAttempt(invoiceId)) throw new ClientError('ALREADY_ATTEMPTED', 'This invoice was already paid or attempted. Nothing more was sent.');
    this.invoiceId = invoiceId;
    const challenge = await this.post(url);
    if (challenge.status !== 402) throw new ClientError('CHALLENGE_FAILED', `Bitrefill answered HTTP ${challenge.status} instead of a payment request.`);
    const header = challenge.headers.get('payment-required');
    if (!header) throw new ClientError('INVALID_CHALLENGE', 'Bitrefill sent no payment request.');
    const offer = decode(header);
    const requirement = selectInvoiceRequirement(offer, maxAmount, this.wallet.address);
    const resource = offer.resource || { url, description: 'Bitrefill invoice', mimeType: 'application/json' };
    let built;
    if (owner) {  // straight from the owner's account, the agent as their approved delegate
      await assertDelegated(this.chain, owner, this.wallet.address, requirement.amount);
      built = await this.chain.buildDelegated(requirement, resource, this.wallet, owner);
    } else {
      const funds = await this.chain.balances(this.wallet.address);
      if (BigInt(funds.usdcAtomic) < BigInt(requirement.amount)) throw new ClientError('INSUFFICIENT_USDC', 'The agent does not hold this invoice amount yet.');
      built = await this.chain.build(requirement, resource, this.wallet);
    }
    this.store.claimInvoice(invoiceId, this.wallet.address, built.messageHash, requirement.amount);
    let response;
    try { response = await this.post(url, { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(built.payload)).toString('base64') }); }
    catch {
      this.store.updateInvoice(invoiceId, 'uncertain');
      throw new ClientError('PAYMENT_UNCERTAIN', 'The payment answer was lost. Do not pay again; check the invoice status.');
    }
    const transaction = transactionOf(response);
    if (response.status !== 200) {
      this.store.updateInvoice(invoiceId, 'uncertain', transaction);
      throw new ClientError('PAYMENT_UNCERTAIN', `Bitrefill answered HTTP ${response.status}. Do not pay again; check the invoice status.`);
    }
    this.store.updateInvoice(invoiceId, 'accepted', transaction);
    return { invoiceId, state: 'accepted', transaction, amount: requirement.amount };
  }
}

// Paying a Bitrefill MCP invoice by a plain USDC transfer to its own deposit address on Solana.
// Bitrefill's x402 pay route stopped knowing MCP invoices (it asks its generic 1,000 USDC ceiling
// for any of them, seen 17 October 2026); the invoice's payment_info names a deposit address
// instead. One transaction, two USDC transfers out of the owner's account, both signed by the agent
// as its approved delegate: the invoice amount to the deposit account, and `feeAmount` to our fee
// payer, which pays the network fee in SOL and so is paid back in USDC by the buyer, from the same
// wallet. The deposit address's USDC account must already exist (Bitrefill opens it); our fee
// payer's is opened once, at its own cost, if missing. One attempt per invoice, recorded before
// the only submission.
export const MAX_FEE_AMOUNT = 10_000n;  // 0.01 USDC: far above a Solana fee; refuses a typo, not a policy

export class InvoiceTransfers {
  constructor({ wallet, chain, store, feePayer = null, allowance = null }) {
    Object.assign(this, { wallet, chain, store, feePayer, lane: allowance || new TokenAllowance({ chain }) });
  }

  async tokenAccount(holder) {
    const account = await usdcAccount(holder);
    let info;
    try { info = await this.chain.rpc.getAccountInfo(account, { encoding: 'base64', commitment: 'confirmed' }).send({ abortSignal: AbortSignal.timeout(20000) }); }
    catch { throw new ClientError('RPC_UNAVAILABLE', 'Could not reach Solana to check where to pay. Nothing was paid.'); }
    if (!info.value) return { account, usable: false, exists: false };
    if (info.value.owner !== TOKEN_PROGRAM) return { account, usable: false, exists: true };
    const data = Buffer.from(info.value.data[0], 'base64');
    let parsed;
    try { parsed = parseTokenAccount(data, holder); } catch { return { account, usable: false, exists: true }; }
    return { account, usable: data[108] === 1 && !parsed.frozen, exists: true };
  }

  async pay({ invoiceId, payTo, amount, owner, feeAmount }) {
    if (typeof invoiceId !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(invoiceId)) throw new ClientError('INVALID_INVOICE', 'Invalid invoice.');
    if (!/^[1-9][0-9]*$/.test(String(amount))) throw new ClientError('INVALID_AMOUNT', 'Invalid amount.');
    if (!/^[1-9][0-9]*$/.test(String(feeAmount)) || BigInt(feeAmount) > MAX_FEE_AMOUNT) throw new ClientError('INVALID_AMOUNT', 'Invalid network fee.');
    for (const [value, what] of [[payTo, 'deposit'], [owner, 'owner']]) {
      if (typeof value !== 'string' || !isAddress(value)) throw new ClientError('INVALID_RECIPIENT', `Invalid ${what} address.`);
    }
    if (!this.feePayer) throw new ClientError('FEE_PAYER_REQUIRED', 'No fee payer is configured.');
    const payer = this.feePayer.address;
    if ([owner, this.wallet.address, payer].includes(payTo)) throw new ClientError('INVALID_RECIPIENT', 'That is not a seller’s address. Nothing was paid.');
    if (this.store.invoiceAttempt(invoiceId)) throw new ClientError('ALREADY_ATTEMPTED', 'This invoice was already paid or attempted. Nothing more was sent.');

    const deposit = await this.tokenAccount(payTo);
    if (!deposit.usable) throw new ClientError('RECIPIENT_ACCOUNT_MISSING', 'Bitrefill’s deposit address cannot take USDC. Nothing was paid.');
    const ours = await this.tokenAccount(payer);
    if (ours.exists && !ours.usable) throw new ClientError('FEE_PAYER_UNAVAILABLE', 'The fee payer’s USDC account is unusable. Nothing was paid.');
    const total = BigInt(amount) + BigInt(feeAmount);
    await assertDelegated(this.chain, owner, this.wallet.address, total);
    const source = await usdcAccount(owner);
    const tx = await this.lane.compile(payer, [
      ...(ours.exists ? [] : [createAccountInstruction({ payer, account: ours.account, owner: payer })]),
      transferInstruction({ source, destination: deposit.account, authority: this.wallet.address, amount: String(amount) }),
      transferInstruction({ source, destination: ours.account, authority: this.wallet.address, amount: String(feeAmount) }),
    ]);
    let balance, fee, rent, accountRent;
    try {
      const options = { abortSignal: AbortSignal.timeout(20000) };
      [balance, fee, rent, accountRent] = await Promise.all([
        this.chain.rpc.getBalance(payer, { commitment: 'confirmed' }).send(options).then(r => r.value),
        this.chain.rpc.getFeeForMessage(Buffer.from(tx.messageBytes).toString('base64'), { commitment: 'confirmed' }).send(options).then(r => r.value),
        this.chain.rpc.getMinimumBalanceForRentExemption(0).send(options),
        ours.exists ? 0n : this.chain.rpc.getMinimumBalanceForRentExemption(165).send(options),
      ]);
    } catch { throw new ClientError('RPC_UNAVAILABLE', 'Could not price the network fee. Nothing was paid.'); }
    if (fee === null || fee === undefined) throw new ClientError('RPC_UNAVAILABLE', 'Could not price the network fee. Nothing was paid.');
    // The fee payer must stay rent-exempt after paying, or Solana refuses the transaction.
    const needed = BigInt(fee) + BigInt(rent) + BigInt(accountRent);
    if (BigInt(balance) < needed) {
      const error = new ClientError('FEE_PAYER_LOW', 'The fee payer holds too little SOL. Nothing was paid.');
      error.reason = `needs ${needed} lamports, holds ${balance}`;
      throw error;
    }

    let signed;
    try { signed = await partiallySignTransaction([this.wallet.signer.keyPair, this.feePayer.signer.keyPair], tx); }
    catch { throw new ClientError('BUILD_FAILED', 'Could not sign the Solana payment. Nothing was submitted.'); }
    this.store.claimInvoice(invoiceId, this.wallet.address, messageHash(tx.messageBytes), String(total));
    const sent = await this.lane.send(signed);
    this.store.updateInvoice(invoiceId, sent.state === 'confirmed' ? 'accepted' : 'uncertain', sent.transaction);
    return { invoiceId, state: sent.state, transaction: sent.transaction, amount: String(amount), feeAmount: String(feeAmount) };
  }
}

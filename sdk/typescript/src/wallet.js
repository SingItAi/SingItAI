import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { webcrypto } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { NETWORKS } from './pins.js';

export function normalizeAmount(amount) {
  if (typeof amount !== 'string' || !/^\d+(\.\d{1,6})?$/.test(amount)) {
    throw new Error('Amount must be a positive decimal with at most 6 decimals.');
  }
  const [whole, fraction = ''] = amount.split('.');
  const atomic = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (!atomic) throw new Error('Amount must be positive.');
  const tail = fraction.replace(/0+$/, '');
  return {
    atomic: String(atomic),
    decimal: `${BigInt(whole)}${tail ? '.' + tail : ''}`,
  };
}

export function validateNetwork(network) {
  if (!['base', 'solana'].includes(network)) {
    throw new Error('Network must be base or solana.');
  }
}

export function fundingUri({ network, address, amount }) {
  validateNetwork(network);
  const value = amount === undefined ? undefined : normalizeAmount(amount);
  return network === 'base'
    ? `ethereum:${NETWORKS.base.asset}@${NETWORKS.base.chainId}/transfer?address=${address}${value ? '&uint256=' + value.atomic : ''}`
    : `solana:${address}?spl-token=${NETWORKS.solana.asset}${value ? '&amount=' + value.decimal : ''}`;
}

export async function renderQr(text, { ansi = false } = {}) {
  const { encode } = await import('uqr');
  const matrix = encode(text, { ecc: 'M', boostEcc: false, border: 0 }).data;
  const size = matrix.length + 8;
  const dark = (row, col) => Boolean(matrix[row - 4]?.[col - 4]);
  const draw = (row, col) => ansi ? dark(row, col) : !dark(row, col);
  const lines = [];
  for (let row = 0; row < size; row += 2) {
    let line = '';
    for (let col = 0; col < size; col++) {
      const top = draw(row, col);
      const bottom = draw(row + 1, col);
      line += top ? (bottom ? '█' : '▀') : (bottom ? '▄' : ' ');
    }
    lines.push(ansi ? `\x1b[30;47m${line}\x1b[0m` : line);
  }
  return lines.join('\n');
}

export async function createWallet({ network = 'base', outPath, home, includeKey = false } = {}) {
  validateNetwork(network);
  let address;
  let privateKey;
  if (network === 'base') {
    privateKey = generatePrivateKey();
    address = privateKeyToAccount(privateKey).address;
  } else {
    const { createKeyPairSignerFromPrivateKeyBytes } = await import('@solana/kit');
    const seed = webcrypto.getRandomValues(new Uint8Array(32));
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed, true);
    address = signer.address;
    const pub = new Uint8Array(await webcrypto.subtle.exportKey('raw', signer.keyPair.publicKey));
    privateKey = JSON.stringify([...seed, ...pub]);
  }
  const walletHome = home ?? process.env.SINGIT_HOME ?? path.join(os.homedir(), '.singit');
  const filename = `${network}-${address.replace(/^0x/, '').slice(0, 8)}.key`;
  const keyPath = path.resolve(outPath ?? path.join(walletHome, 'wallets', filename));
  let fd;
  try {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    fd = fs.openSync(keyPath, 'wx', 0o600);
    try {
      try {
        fs.fchmodSync(fd, 0o600);
      } catch (error) {
        if (process.platform !== 'win32') throw error;
      }
      fs.writeFileSync(fd, privateKey + '\n');
      fs.fsyncSync(fd);
    } catch {
      fs.closeSync(fd);
      fd = undefined;
      fs.unlinkSync(keyPath);
      throw new Error('Unable to write key file.');
    }
    fs.closeSync(fd);
    fd = undefined;
  } catch (e) {
    throw new Error(e.code === 'EEXIST' ? 'Key file already exists; refusing to overwrite.' : 'Unable to create key file.');
  }
  return { network, address, keyPath, ...(includeKey ? { privateKey } : {}) };
}

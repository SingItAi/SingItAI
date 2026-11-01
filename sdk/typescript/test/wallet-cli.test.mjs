import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { getBase58Decoder } from '@solana/kit';
import { main } from '../src/cli.js';
import { createWallet, fundingUri } from '../src/wallet.js';
import { NETWORKS } from '../src/pins.js';
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'singit-wallet-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

async function run(home, args = []) {
  let out = '';
  let err = '';
  const code = await main(['wallet', 'new', ...args], {
    env: { SINGIT_HOME: home },
    stdout: { write: text => { out += text; } },
    stderr: { write: text => { err += text; } },
  });
  return { code, out, err };
}

function assertSolanaKey(key, output) {
  const bytes = JSON.parse(key);
  const decode = values => getBase58Decoder().decode(Uint8Array.from(values));
  assert.equal(bytes.length, 64);
  assert.ok(bytes.every(n => Number.isInteger(n) && n >= 0 && n < 256));
  assert.ok(!output.includes(bytes.join(',')));
  assert.ok(!output.includes(decode(bytes)));
  assert.ok(!output.includes(decode(bytes.slice(0, 32))));
  return decode(bytes.slice(32));
}

for (const network of ['base', 'solana']) {
  test(`${network}: secure files, address, QR and secret opt-in`, async t => {
    const home = setup(t);
    const result = await run(home, ['--network', network]);
    assert.equal(result.code, 0);
    const directory = path.join(home, 'wallets');
    const file = path.join(directory, fs.readdirSync(directory)[0]);
    const key = fs.readFileSync(file, 'utf8').trim();
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    }
    let address;
    if (network === 'base') {
      assert.match(key, /^0x[0-9a-f]{64}$/);
      address = privateKeyToAccount(key).address;
    } else {
      address = assertSolanaKey(key, result.out + result.err);
    }
    assert.ok(result.out.includes('Address: ' + address));
    assert.ok(result.out.includes('Funding text: ' + address));
    assert.match(result.out, /[█▀▄]/);
    assert.ok(!(result.out + result.err).includes(key));

    const shown = await run(home, ['--network', network, '--show-key', '--no-qr']);
    assert.equal(shown.code, 0);
    const shownFile = shown.out.match(/Key file: (.*)/)[1];
    const shownKey = fs.readFileSync(shownFile, 'utf8').trim();
    assert.equal(shown.out.split('\n').filter(line => line === shownKey).length, 1);
    assert.ok(!shown.err.includes(shownKey));
    assert.doesNotMatch(shown.out, /[█▀▄]/);
  });
}

test('exclusive files, library return, and repository warning', async t => {
  const home = setup(t);
  fs.mkdirSync(path.join(home, '.git'));
  const out = path.join(home, 'nested', 'wallet.key');
  const result = await run(home, ['--out', out, '--no-qr']);
  assert.equal(result.code, 0);
  assert.match(result.err, /do not commit it/);
  const before = fs.readFileSync(out, 'utf8');
  const again = await run(home, ['--out', out]);
  assert.equal(again.code, 1);
  assert.equal(fs.readFileSync(out, 'utf8'), before);
  assert.ok(!(again.out + again.err).includes(before.trim()));
  const wallet = await createWallet({ home });
  assert.ok(!Object.hasOwn(wallet, 'privateKey'));
  const withKey = await createWallet({ home, includeKey: true });
  assert.match(withKey.privateKey, /^0x/);
});

const invalidOptions = [
  ['--wat'],
  ['--amount', '1'],
  ...['0', '-1', 'abc', '0.1234567'].map(amount => ['--uri', '--amount', amount]),
  ['--network', 'base-sepolia'],
  ['--network', 'bad'],
  ['--out'],
];
for (const args of invalidOptions) {
  test(`invalid options ${args.join(' ')}`, async t => {
    const home = setup(t);
    const result = await run(home, args);
    assert.equal(result.code, 2);
    assert.equal(fs.readdirSync(home).length, 0);
  });
}

test('funding requests use exact decimal arithmetic', () => {
  const base = `ethereum:${NETWORKS.base.asset}@8453/transfer?address=recipient`;
  const solana = `solana:recipient?spl-token=${NETWORKS.solana.asset}`;
  assert.equal(fundingUri({ network: 'base', address: 'recipient' }), base);
  assert.equal(fundingUri({ network: 'solana', address: 'recipient' }), solana);
  const amounts = [
    ['1', '1000000', '1'],
    ['0.5', '500000', '0.5'],
    ['1.000000', '1000000', '1'],
  ];
  for (const [amount, atomic, decimal] of amounts) {
    assert.equal(fundingUri({ network: 'base', address: 'recipient', amount }), base + '&uint256=' + atomic);
    assert.equal(fundingUri({ network: 'solana', address: 'recipient', amount }), solana + '&amount=' + decimal);
  }
});

test('URI is printed below QR; accessible existing directory warns', async t => {
  const home = setup(t);
  const directory = path.join(home, 'open');
  fs.mkdirSync(directory, 0o755);
  const result = await run(home, ['--out', path.join(directory, 'key'), '--uri', '--amount', '0.5']);
  assert.equal(result.code, 0);
  assert.match(result.out, /Funding text: ethereum:.*&uint256=500000/);
  if (process.platform !== 'win32') {
    assert.match(result.err, /group\/other accessible/);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
  }
});

test('help does no IO', async t => {
  const home = setup(t);
  const result = await run(home, ['--help']);
  assert.equal(result.code, 0);
  assert.match(result.out, /Usage:/);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('write failure removes partial file and does not expose secrets', async t => {
  const home = setup(t);
  const original = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw new Error('simulated write failure'); };
    const result = await run(home);
    assert.equal(result.code, 1);
    assert.deepEqual(fs.readdirSync(path.join(home, 'wallets')), []);
    assert.ok(!result.out.includes('0x'));
  } finally {
    fs.fsyncSync = original;
  }
});

const qrTexts = [
  '0x1234567890123456789012345678901234567890',
  fundingUri({ network: 'base', address: '0x1234567890123456789012345678901234567890', amount: '123.456789' }),
  'So11111111111111111111111111111111111111112',
];

function decodeQr(output, ansi, matrixSize) {
  const rows = [];
  for (let line of output.split('\n')) {
    if (ansi) {
      assert.ok(line.startsWith('\x1b[30;47m'));
      assert.ok(line.endsWith('\x1b[0m'));
      line = line.slice(8, -4);
    } else {
      assert.ok(!line.includes('\x1b'));
    }
    const blocks = {
      '█': [true, true],
      '▀': [true, false],
      '▄': [false, true],
      ' ': [false, false],
    };
    const pairs = [...line].map(char => blocks[char]);
    assert.equal(pairs.length, matrixSize + 8);
    rows.push(pairs.map(pair => ansi ? pair[0] : !pair[0]));
    rows.push(pairs.map(pair => ansi ? pair[1] : !pair[1]));
  }
  assert.equal(rows.length, Math.ceil((matrixSize + 8) / 2) * 2);
  for (let row = 0; row < rows.length; row++) {
    for (let col = 0; col < rows[row].length; col++) {
      if (row < 4 || row >= matrixSize + 4 || col < 4 || col >= matrixSize + 4) {
        assert.equal(rows[row][col], false);
      }
    }
  }
  return rows.slice(4, matrixSize + 4).map(row => row.slice(4, -4));
}

for (const text of qrTexts) {
  test(`QR matrix roundtrip: ${text}`, async () => {
    const { encode } = await import('uqr');
    const { renderQr } = await import('../src/wallet.js');
    const matrix = encode(text, { ecc: 'M', boostEcc: false, border: 0 }).data;
    for (const ansi of [false, true]) {
      assert.deepEqual(decodeQr(await renderQr(text, { ansi }), ansi, matrix.length), matrix);
    }
  });
}

const terminalModes = [
  [undefined, undefined, false],
  [true, undefined, true],
  [true, '', true],
  [true, '1', false],
];
for (const [isTTY, noColor, expected] of terminalModes) {
  test(`CLI QR ANSI: tty=${isTTY}, NO_COLOR=${noColor}`, async t => {
    const home = setup(t);
    let output = '';
    const stdout = { write: text => { output += text; } };
    if (isTTY !== undefined) stdout.isTTY = isTTY;
    const code = await main(['wallet', 'new'], {
      stdout,
      stderr: { write() {} },
      env: { SINGIT_HOME: home, NO_COLOR: noColor },
    });
    assert.equal(code, 0);
    assert.equal(output.includes('\x1b'), expected);
  });
}

test('Base usage instruction quotes shell paths', async t => {
  const home = setup(t);
  const keyPath = path.join(home, "key's $file`name");
  const result = await run(home, ['--out', keyPath, '--no-qr']);
  assert.equal(result.code, 0);
  assert.ok(result.out.includes(`Use it with: export AGENT_PRIVATE_KEY="$(cat '${keyPath.replaceAll("'", "'\\''")}')"`));
});

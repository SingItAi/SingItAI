import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {
  createWallet,
  fundingUri,
  normalizeAmount,
  renderQr,
  validateNetwork,
} from './wallet.js';

const help = 'Usage: singit wallet new [--network base|solana] [--out PATH] [--uri] [--amount USDC] [--no-qr] [--show-key] [-h|--help]';

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function warnAboutDirectory(directory, stderr) {
  if (process.platform !== 'win32' && (fs.statSync(directory).mode & 0o077)) {
    stderr.write('Warning: key directory is group/other accessible.\n');
  }
  for (let current = directory;; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) {
      stderr.write('Warning: key file is inside a git work tree; do not commit it.\n');
      break;
    }
    if (path.dirname(current) === current) break;
  }
}

export async function main(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  home,
} = {}) {
  let values;
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        network: { type: 'string', default: 'base' },
        out: { type: 'string' },
        uri: { type: 'boolean' },
        amount: { type: 'string' },
        'no-qr': { type: 'boolean' },
        'show-key': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    values = parsed.values;
    if (values.help) {
      stdout.write(help + '\n');
      return 0;
    }
    if (parsed.positionals.join(' ') !== 'wallet new') throw new Error();
    validateNetwork(values.network);
    if (values.amount !== undefined) {
      if (!values.uri) throw new Error();
      normalizeAmount(values.amount);
    }
  } catch {
    stderr.write('Invalid options. ' + help + '\n');
    return 2;
  }

  try {
    const wallet = await createWallet({
      network: values.network,
      outPath: values.out,
      home: home ?? env.SINGIT_HOME,
      includeKey: values['show-key'],
    });
    stdout.write(`Network: ${wallet.network}\nAddress: ${wallet.address}\nKey file: ${wallet.keyPath}\n`);
    stdout.write('WARNING: The key file is the only copy. Anyone who has it can spend the funds. Back it up; never commit or share it. Fund only what you are willing to spend. SDK limits (maxPerCallUsd/maxPerDayUsd) are client-side.\n');
    if (values['show-key']) {
      stdout.write(`WARNING: Private key follows:\n${wallet.privateKey}\n`);
    }
    warnAboutDirectory(path.dirname(wallet.keyPath), stderr);
    const text = values.uri
      ? fundingUri({ network: wallet.network, address: wallet.address, amount: values.amount })
      : wallet.address;
    if (!values['no-qr']) {
      const ansi = Boolean(stdout.isTTY) && !env.NO_COLOR;
      stdout.write(await renderQr(text, { ansi }) + '\n');
    }
    const chain = wallet.network === 'base'
      ? 'Base (not Ethereum mainnet or other chains)'
      : 'Solana';
    stdout.write(`Funding text: ${text}\nSend USDC on ${chain} to this address.\n`);
    if (wallet.network === 'base') {
      stdout.write(`Use it with: export AGENT_PRIVATE_KEY="$(cat ${shellQuote(wallet.keyPath)})"\n`);
    } else {
      stdout.write('Keep the key file path for solanaSigner.\n');
    }
    return 0;
  } catch (error) {
    const safe = ['Key file already exists; refusing to overwrite.', 'Unable to create key file.'];
    stderr.write((safe.includes(error.message) ? error.message : 'Unable to create wallet.') + '\n');
    return 1;
  }
}

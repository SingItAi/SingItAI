"""The singit wallet new command."""
import argparse
import os
from pathlib import Path
import sys
from .wallet import create_wallet, funding_uri, normalize_amount, render_qr, validate_network


class OptionsError(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise OptionsError()


def main(argv=None, stdout=None, stderr=None, env=None):
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    env = os.environ if env is None else env
    parser = Parser(prog="singit wallet new", add_help=False, allow_abbrev=False)
    parser.add_argument("command", nargs="*")
    parser.add_argument("--network", default="base")
    parser.add_argument("--out")
    parser.add_argument("--amount")
    for option in ("uri", "no-qr", "show-key"):
        parser.add_argument("--" + option, action="store_true")
    parser.add_argument("-h", "--help", action="store_true")
    try:
        args = parser.parse_args(argv)
        if args.help:
            stdout.write(parser.format_help())
            return 0
        if args.command != ["wallet", "new"]:
            raise OptionsError()
        validate_network(args.network)
        if args.amount is not None:
            if not args.uri:
                raise OptionsError()
            normalize_amount(args.amount)
    except (OptionsError, ValueError):
        stderr.write("Invalid options. " + parser.format_usage())
        return 2
    try:
        wallet = create_wallet(args.network, args.out, env.get("SINGIT_HOME"), args.show_key)
    except RuntimeError as error:
        stderr.write(str(error) + "\n")
        return 1
    key_path = Path(wallet["keyPath"])
    stdout.write(f"Network: {wallet['network']}\nAddress: {wallet['address']}\nKey file: {key_path}\n")
    stdout.write("WARNING: The key file is the only copy. Anyone who has it can spend the funds. Back it up; never commit or share it. Fund only what you are willing to spend. SDK limits (maxPerCallUsd/maxPerDayUsd) are client-side.\n")
    if args.show_key:
        stdout.write("WARNING: Private key follows:\n" + wallet["privateKey"] + "\n")
    if os.name != "nt" and key_path.parent.stat().st_mode & 0o077:
        stderr.write("Warning: key directory is group/other accessible.\n")
    if any((parent / ".git").exists() for parent in key_path.parents):
        stderr.write("Warning: key file is inside a git work tree; do not commit it.\n")
    text = funding_uri(args.network, wallet["address"], args.amount) if args.uri else wallet["address"]
    if not args.no_qr:
        try:
            ansi = bool(getattr(stdout, "isatty", lambda: False)()) and not env.get("NO_COLOR")
            stdout.write(render_qr(text, ansi=ansi) + "\n")
        except ImportError:
            stdout.write('pip install "singit[qr]"\n')
    chain = "Base (not Ethereum mainnet or other chains)" if args.network == "base" else "Solana"
    stdout.write(f"Funding text: {text}\nSend USDC on {chain} to this address.\n")
    if args.network == "base":
        quoted_path = "'" + str(key_path).replace("'", "'\\''") + "'"
        stdout.write(f'Use it with: export AGENT_PRIVATE_KEY="$(cat {quoted_path})"\n')
    else:
        stdout.write("Keep the key file path for solanaSigner.\n")
    return 0

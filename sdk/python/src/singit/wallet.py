"""Local wallet creation and USDC funding requests. QR dependencies are lazy."""
import json
import os
from pathlib import Path
import re
from .pins import NETWORKS


def normalize_amount(amount):
    if not isinstance(amount, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]{1,6})?", amount):
        raise ValueError("Amount must be a positive decimal with at most 6 decimals.")
    whole, _, fraction = amount.partition(".")
    atomic = int(whole) * 1000000 + int(fraction.ljust(6, "0"))
    if not atomic:
        raise ValueError("Amount must be positive.")
    tail = fraction.rstrip("0")
    return str(atomic), str(int(whole)) + ("." + tail if tail else "")


def validate_network(network):
    if network not in ("base", "solana"):
        raise ValueError("Network must be base or solana.")


def funding_uri(network, address, amount=None):
    validate_network(network)
    value = normalize_amount(amount) if amount is not None else None
    if network == "base":
        return f"ethereum:{NETWORKS['base'].asset}@8453/transfer?address={address}" + (f"&uint256={value[0]}" if value else "")
    return f"solana:{address}?spl-token={NETWORKS['solana'].asset}" + (f"&amount={value[1]}" if value else "")


def create_wallet(network, out_path=None, home=None, include_key=False):
    validate_network(network)
    if network == "base":
        from eth_account import Account
        account = Account.create()
        address = account.address
        private_key = "0x" + bytes(account.key).hex()
    else:
        try:
            from solders.keypair import Keypair
        except ImportError:
            raise RuntimeError('Solana wallets require pip install "singit[svm]"') from None
        pair = Keypair()
        address = str(pair.pubkey())
        private_key = json.dumps(list(bytes(pair)), separators=(",", ":"))
    base = Path(home or os.environ.get("SINGIT_HOME") or Path.home() / ".singit")
    key_path = Path(out_path or base / "wallets" / f"{network}-{address.removeprefix('0x')[:8]}.key").resolve()
    # mkdir's recursive parents use default modes; create each missing ancestor explicitly.
    def mkdir(directory):
        if directory.exists():
            return
        mkdir(directory.parent)
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            pass
    try:
        mkdir(key_path.parent)
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise RuntimeError("Key file already exists; refusing to overwrite.") from None
    except OSError:
        raise RuntimeError("Unable to create key file.") from None
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(private_key + "\n")
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        key_path.unlink(missing_ok=True)
        raise RuntimeError("Unable to write key file.") from None
    result = {"network": network, "address": address, "keyPath": str(key_path)}
    if include_key:
        result["privateKey"] = private_key
    return result


def render_qr(text, ansi=False):
    import segno

    matrix = segno.make(text, error="m", boost_error=False).matrix
    size = len(matrix) + 8

    def draw(row, col):
        inside = 4 <= row < size - 4 and 4 <= col < size - 4
        dark = bool(matrix[row - 4][col - 4]) if inside else False
        return dark if ansi else not dark

    lines = []
    for row in range(0, size, 2):
        line = ""
        for col in range(size):
            top = draw(row, col)
            bottom = draw(row + 1, col)
            line += ("█" if bottom else "▀") if top else ("▄" if bottom else " ")
        lines.append("\x1b[30;47m" + line + "\x1b[0m" if ansi else line)
    return "\n".join(lines)

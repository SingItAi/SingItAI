import io
import json
import os
import re
import sys
from pathlib import Path

import pytest
from eth_account import Account
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from singit.cli import main
from singit.wallet import create_wallet, funding_uri
from singit.pins import NETWORKS


def run(home, *args):
    out = io.StringIO()
    err = io.StringIO()
    code = main(
        ["wallet", "new", *args],
        stdout=out,
        stderr=err,
        env={"SINGIT_HOME": str(home)},
    )
    return code, out.getvalue(), err.getvalue()


@pytest.mark.parametrize("network", ["base", "solana"])
def test_secure_wallet(tmp_path, network):
    code, out, err = run(tmp_path, "--network", network)
    assert code == 0
    file = next((tmp_path / "wallets").iterdir())
    key = file.read_text().strip()
    assert file.read_text().endswith("\n")
    if os.name != "nt":
        assert file.stat().st_mode & 0o777 == 0o600
        assert file.parent.stat().st_mode & 0o777 == 0o700
    if network == "base":
        assert re.fullmatch(r"0x[0-9a-f]{64}", key)
        address = Account.from_key(key).address
    else:
        values = json.loads(key)
        assert len(values) == 64
        assert all(isinstance(n, int) and 0 <= n <= 255 for n in values)
        address = str(Pubkey.from_bytes(bytes(values[32:])))
        assert str(Keypair.from_bytes(bytes(values))) not in out + err
        assert str(Pubkey.from_bytes(bytes(values[:32]))) not in out + err
        assert ",".join(map(str, values)) not in out + err
    assert f"Address: {address}" in out
    assert f"Funding text: {address}" in out
    assert re.search("[█▀▄]", out)
    assert key not in out + err
    code, shown, err = run(tmp_path, "--network", network, "--show-key", "--no-qr")
    assert code == 0
    shown_key = Path(re.search(r"Key file: (.*)", shown)[1]).read_text().strip()
    assert shown.splitlines().count(shown_key) == 1
    assert shown_key not in err
    assert not re.search("[█▀▄]", shown)


def test_exclusive_and_library(tmp_path):
    (tmp_path / ".git").mkdir()
    file = tmp_path / "nested" / "wallet.key"
    code, out, err = run(tmp_path, "--out", str(file), "--no-qr")
    assert code == 0
    assert "do not commit it" in err
    before = file.read_text()
    code, out, err = run(tmp_path, "--out", str(file))
    assert code == 1
    assert file.read_text() == before
    assert before.strip() not in out + err
    assert "privateKey" not in create_wallet("base", home=tmp_path)
    assert create_wallet("base", home=tmp_path, include_key=True)["privateKey"].startswith("0x")


@pytest.mark.parametrize(
    "args",
    [
        ["--wat"],
        ["--amount", "1"],
        *[
            ["--uri", "--amount", amount]
            for amount in ["0", "-1", "abc", "0.1234567"]
        ],
        ["--network", "base-sepolia"],
        ["--network", "bad"],
        ["--out"],
    ],
)
def test_invalid(tmp_path, args):
    assert run(tmp_path, *args)[0] == 2
    assert list(tmp_path.iterdir()) == []


def test_uris():
    base = f"ethereum:{NETWORKS['base'].asset}@8453/transfer?address=recipient"
    sol = f"solana:recipient?spl-token={NETWORKS['solana'].asset}"
    assert funding_uri("base", "recipient") == base
    assert funding_uri("solana", "recipient") == sol
    amounts = [
        ("1", "1000000", "1"),
        ("0.5", "500000", "0.5"),
        ("1.000000", "1000000", "1"),
    ]
    for amount, atomic, decimal in amounts:
        assert funding_uri("base", "recipient", amount) == base + "&uint256=" + atomic
        assert funding_uri("solana", "recipient", amount) == sol + "&amount=" + decimal


def test_no_segno(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "segno", None)
    code, out, err = run(tmp_path)
    assert code == 0
    assert "Address: 0x" in out
    assert 'pip install "singit[qr]"' in out


def test_no_solders(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "solders.keypair", None)
    code, out, err = run(tmp_path, "--network", "solana")
    assert code == 1
    assert 'pip install "singit[svm]"' in err
    assert not list(tmp_path.iterdir())


def test_uri_and_directory_warning(tmp_path):
    directory = tmp_path / "open"
    directory.mkdir(mode=0o755)
    code, out, err = run(
        tmp_path, "--out", str(directory / "key"), "--uri", "--amount", "0.5"
    )
    assert code == 0
    assert re.search(r"Funding text: ethereum:.*&uint256=500000", out)
    if os.name != "nt":
        assert "group/other accessible" in err
        assert directory.stat().st_mode & 0o777 == 0o755


def test_help(tmp_path):
    code, out, err = run(tmp_path, "--help")
    assert code == 0
    assert "usage:" in out
    assert not list(tmp_path.iterdir())


def test_write_failure_removes_partial_file(tmp_path, monkeypatch):
    import singit.wallet as wallet

    def fail(_fd):
        raise OSError("simulated write failure")

    monkeypatch.setattr(wallet.os, "fsync", fail)
    code, out, err = run(tmp_path)
    assert code == 1
    assert not list((tmp_path / "wallets").iterdir())
    assert "0x" not in out + err


def test_manifest_entrypoint():
    try:
        import tomllib
    except ImportError:
        import tomli as tomllib
    manifest = Path(__file__).parents[1] / "pyproject.toml"
    project = tomllib.loads(manifest.read_text())["project"]
    assert project["scripts"]["singit"] == "singit.cli:main"
    assert project["optional-dependencies"]["qr"] == ["segno>=1.6,<2"]


QR_TEXTS = [
    "0x1234567890123456789012345678901234567890",
    funding_uri("base", "0x1234567890123456789012345678901234567890", "123.456789"),
    "So11111111111111111111111111111111111111112",
]


def decode_qr(output, ansi, matrix_size):
    rows = []
    blocks = {
        "█": (True, True),
        "▀": (True, False),
        "▄": (False, True),
        " ": (False, False),
    }
    for line in output.split("\n"):
        if ansi:
            assert line.startswith("\x1b[30;47m")
            assert line.endswith("\x1b[0m")
            line = line[8:-4]
        else:
            assert "\x1b" not in line
        pairs = [blocks[char] for char in line]
        assert len(pairs) == matrix_size + 8
        for half in (0, 1):
            rows.append([pair[half] if ansi else not pair[half] for pair in pairs])
    assert len(rows) == ((matrix_size + 9) // 2) * 2
    for row, values in enumerate(rows):
        for col, dark in enumerate(values):
            if (
                row < 4 or row >= matrix_size + 4
                or col < 4 or col >= matrix_size + 4
            ):
                assert not dark
    return [row[4:-4] for row in rows[4:matrix_size + 4]]


@pytest.mark.parametrize("text", QR_TEXTS)
def test_qr_matrix_roundtrip(text):
    import segno
    from singit.wallet import render_qr

    encoded = segno.make(text, error="m", boost_error=False)
    matrix = [list(map(bool, row)) for row in encoded.matrix]
    for ansi in (False, True):
        assert decode_qr(render_qr(text, ansi=ansi), ansi, len(matrix)) == matrix


@pytest.mark.parametrize(
    "tty,no_color,expected",
    [(None, None, False), (True, None, True), (True, "", True), (True, "1", False)],
)
def test_cli_qr_ansi(tmp_path, tty, no_color, expected):
    class Output:
        def __init__(self):
            self.text = ""

        def write(self, text):
            self.text += text

    out = Output()
    if tty is not None:
        out.isatty = lambda: tty
    env = {"SINGIT_HOME": str(tmp_path)}
    if no_color is not None:
        env["NO_COLOR"] = no_color
    code = main(["wallet", "new"], stdout=out, stderr=io.StringIO(), env=env)
    assert code == 0
    assert ("\x1b" in out.text) == expected


def test_base_usage_quotes_shell_path(tmp_path):
    key_path = tmp_path / "key's $file`name"
    code, out, _ = run(tmp_path, "--out", str(key_path), "--no-qr")
    assert code == 0
    quoted = "'" + str(key_path).replace("'", "'\\''") + "'"
    assert f'Use it with: export AGENT_PRIVATE_KEY="$(cat {quoted})"' in out

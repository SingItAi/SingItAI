"""Base Builder Code attribution (ERC-8021): byte layout and wiring.

The vector in test_matches_ox_byte_layout_exactly is the output of running
ox's `Attribution.toDataSuffix({ codes: ["bc_test1234"] })` in Node; "bc_test1234"
is an obviously-fake example code, not a real one.
"""

import unittest
from unittest.mock import patch

from eth_account import Account
from eth_utils import keccak

from sign402_gateway import agent_allowance as aa
from sign402_gateway import base_builder_code as bbc

OWNER = "0x1111111111111111111111111111111111111111"
FAKE_CODE = "bc_test1234"
NOW = 1_800_000_000


class FakeRpc:
    """Same shape as the FakeRpc in test_agent_allowance.py."""

    def __init__(self, replies=None):
        self.replies = dict(replies or {})
        self.calls = []

    def call(self, method, params):
        self.calls.append((method, params))
        reply = self.replies[method]
        return reply(params) if callable(reply) else reply


def rpc_for_send(gas_hex=hex(100_000)):
    def send_raw(params):
        raw = params[0]
        return "0x" + keccak(bytes.fromhex(raw[2:])).hex()

    return FakeRpc({
        "eth_chainId": hex(aa.BASE_CHAIN_ID),
        "eth_getTransactionCount": "0x7",
        "eth_maxPriorityFeePerGas": hex(1_000_000),
        "eth_getBlockByNumber": {"baseFeePerGas": hex(5_000_000)},
        "eth_estimateGas": gas_hex,
        "eth_sendRawTransaction": send_raw,
    })


def client(rpc):
    return aa.EvmClient(rpc, sleep=lambda s: None, now=lambda: NOW)


def rlp_decode_data(raw_tx):
    """The hex `data` field of a signed EIP-1559 transaction, 0x-prefixed."""
    import rlp

    raw = bytes.fromhex(raw_tx.removeprefix("0x"))
    fields = rlp.decode(raw[1:])  # raw[0] is the 0x02 type byte
    data = fields[7]
    return "0x" + data.hex()


class EncodingTests(unittest.TestCase):
    def test_matches_ox_byte_layout_exactly(self):
        # Attribution.toDataSuffix({ codes: ["bc_test1234"] }) from ox/erc8021.
        expected_hex = "62635f74657374313233340b0080218021802180218021802180218021"
        self.assertEqual(bbc.encode_data_suffix(FAKE_CODE).hex(), expected_hex)
        # 11 ascii bytes + 1 length byte + 1 schema-id byte + 16-byte magic tail.
        self.assertEqual(len(bbc.encode_data_suffix(FAKE_CODE)), 29)

    def test_magic_tail_is_the_fixed_16_bytes(self):
        suffix = bbc.encode_data_suffix(FAKE_CODE)
        self.assertEqual(suffix[-16:].hex(), "80218021802180218021802180218021")


class LoadDataSuffixTests(unittest.TestCase):
    def test_unset_env_disables_attribution(self):
        self.assertIsNone(bbc.load_data_suffix(env={}))

    def test_empty_env_disables_attribution(self):
        self.assertIsNone(bbc.load_data_suffix(env={bbc.ENV_VAR: "   "}))

    def test_valid_code_loads(self):
        suffix = bbc.load_data_suffix(env={bbc.ENV_VAR: FAKE_CODE})
        self.assertEqual(suffix, bbc.encode_data_suffix(FAKE_CODE))

    def test_out_of_charset_code_is_disabled_not_raised(self):
        # Uppercase and punctuation are outside [a-z0-9_].
        self.assertIsNone(bbc.load_data_suffix(env={bbc.ENV_VAR: "Not-Valid!"}))

    def test_too_long_code_is_disabled_not_raised(self):
        self.assertIsNone(bbc.load_data_suffix(env={bbc.ENV_VAR: "a" * 33}))

    def test_33_char_boundary_and_32_char_accepted(self):
        self.assertIsNotNone(bbc.load_data_suffix(env={bbc.ENV_VAR: "a" * 32}))
        self.assertIsNone(bbc.load_data_suffix(env={bbc.ENV_VAR: "a" * 33}))


class AppendSuffixTests(unittest.TestCase):
    def test_disabled_suffix_is_a_no_op(self):
        self.assertEqual(bbc.append_suffix("0x1234", chain_id=8453, suffix=None), "0x1234")

    def test_non_base_chain_is_unaffected_even_when_configured(self):
        suffix = bbc.encode_data_suffix(FAKE_CODE)
        for chain_id in (1, 137, 10, 42161):
            self.assertEqual(
                bbc.append_suffix("0x1234", chain_id=chain_id, suffix=suffix),
                "0x1234",
            )

    def test_base_mainnet_and_sepolia_both_get_the_suffix(self):
        suffix = bbc.encode_data_suffix(FAKE_CODE)
        for chain_id in (bbc.BASE_MAINNET_CHAIN_ID, bbc.BASE_SEPOLIA_CHAIN_ID):
            result = bbc.append_suffix("0x1234", chain_id=chain_id, suffix=suffix)
            self.assertEqual(result, "0x1234" + suffix.hex())

    def test_plain_transfer_with_empty_data_becomes_suffix_only(self):
        suffix = bbc.encode_data_suffix(FAKE_CODE)
        self.assertEqual(bbc.append_suffix("0x", chain_id=8453, suffix=suffix), "0x" + suffix.hex())

    def test_appending_twice_does_not_duplicate_the_suffix(self):
        suffix = bbc.encode_data_suffix(FAKE_CODE)
        once = bbc.append_suffix("0x1234", chain_id=8453, suffix=suffix)
        twice = bbc.append_suffix(once, chain_id=8453, suffix=suffix)
        self.assertEqual(once, twice)


class EvmClientWiringTests(unittest.TestCase):
    """send() appends the suffix before signing, and the gas estimate taken
    for that same send sees the fully-suffixed data (so the limit covers the
    suffix's own gas cost)."""

    def test_unset_env_leaves_data_byte_identical_to_before(self):
        with patch.dict("os.environ", {}, clear=True):
            rpc = rpc_for_send()
            key = Account.create().key.to_0x_hex()
            tx_hash = client(rpc).send(key, to=OWNER, data="0x1234", value=5)

            estimate = next(p[0] for m, p in rpc.calls if m == "eth_estimateGas")
            self.assertEqual(estimate["data"], "0x1234")
            raw = next(p[0] for m, p in rpc.calls if m == "eth_sendRawTransaction")
            self.assertEqual(tx_hash, "0x" + keccak(bytes.fromhex(raw[2:])).hex())
            self.assertEqual(Account.recover_transaction(raw), Account.from_key(key).address)

    def test_configured_code_appends_suffix_before_estimating_and_signing(self):
        with patch.dict("os.environ", {bbc.ENV_VAR: FAKE_CODE}, clear=False):
            rpc = rpc_for_send()
            key = Account.create().key.to_0x_hex()
            client(rpc).send(key, to=OWNER, data="0x1234", value=5)

            expected_suffix = bbc.encode_data_suffix(FAKE_CODE).hex()
            estimate = next(p[0] for m, p in rpc.calls if m == "eth_estimateGas")
            self.assertEqual(estimate["data"], "0x1234" + expected_suffix)

            raw = next(p[0] for m, p in rpc.calls if m == "eth_sendRawTransaction")
            transaction = Account.recover_transaction(raw)
            self.assertEqual(transaction, Account.from_key(key).address)
            # The signed, broadcast raw bytes must carry the same suffixed data
            # (the data field is RLP-encoded inside the signed tx, not at its
            # literal end, so decode it back out rather than checking raw bytes).
            decoded = rlp_decode_data(raw)
            self.assertTrue(decoded.endswith(expected_suffix))

    def test_configured_code_on_a_plain_transfer_is_suffix_only_data(self):
        with patch.dict("os.environ", {bbc.ENV_VAR: FAKE_CODE}, clear=False):
            rpc = rpc_for_send()
            key = Account.create().key.to_0x_hex()
            client(rpc).send(key, to=OWNER, value=5)  # data defaults to "0x"

            expected_suffix = bbc.encode_data_suffix(FAKE_CODE).hex()
            estimate = next(p[0] for m, p in rpc.calls if m == "eth_estimateGas")
            self.assertEqual(estimate["data"], "0x" + expected_suffix)


if __name__ == "__main__":
    unittest.main()

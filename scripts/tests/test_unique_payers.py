import datetime
import importlib.util
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "unique-payers.py"

MERCHANT = "0xC23d1Dc0f5fCe1abfFB051e06cB93f0329968B4e"
PAYER_A = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
PAYER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

SOLANA_MERCHANT = "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu"
SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
SOLANA_PAYER_A = "SoLTestPayerAddressAAAAAAAAAAAAAAAAAAAAAA1"
SOLANA_PAYER_B = "SoLTestPayerAddressBBBBBBBBBBBBBBBBBBBBBB2"
SOLANA_FEE_PAYER = "SoLTestFacilitatorFeePayerAAAAAAAAAAAAAAA3"


def load_unique_payers():
    spec = importlib.util.spec_from_file_location("unique_payers", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def blockscout_item(*, from_addr, to_addr=MERCHANT, value="2500000", decimals="6",
                    timestamp="2026-01-15T10:00:00.000000Z", tx_hash="0xabc"):
    return {
        "from": {"hash": from_addr},
        "to": {"hash": to_addr},
        "total": {"value": value, "decimals": decimals},
        "timestamp": timestamp,
        "tx_hash": tx_hash,
    }


class ExclusionTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_default_merchant_is_always_excluded(self):
        exclude = self.up.load_exclusions(None, None)
        self.assertIn(MERCHANT.lower(), exclude)

    def test_env_value_is_comma_separated_and_case_insensitive(self):
        exclude = self.up.load_exclusions(f"{PAYER_A}, {PAYER_B.upper()}", None)
        self.assertIn(PAYER_A.lower(), exclude)
        self.assertIn(PAYER_B.lower(), exclude)

    def test_file_supports_comments_and_blank_lines(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mine.txt"
            path.write_text(f"# my wallets\n{PAYER_A}  # laptop\n\n  {PAYER_B}\n")
            exclude = self.up.load_exclusions(None, path)
        self.assertIn(PAYER_A.lower(), exclude)
        self.assertIn(PAYER_B.lower(), exclude)

    def test_env_and_file_and_defaults_all_merge(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mine.txt"
            path.write_text(PAYER_B)
            exclude = self.up.load_exclusions(PAYER_A, path)
        self.assertEqual(exclude, frozenset({MERCHANT.lower(), SOLANA_MERCHANT, PAYER_A.lower(), PAYER_B.lower()}))


class MergeMerchantsTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_extra_merchant_merges_in(self):
        other = "0x" + "9" * 40
        merged = self.up.merge_merchants({MERCHANT: "default"}, [other])
        self.assertEqual(merged, {MERCHANT: "default", other: "ad-hoc (--merchant)"})

    def test_extra_merchant_duplicating_default_case_insensitively_is_scanned_once(self):
        merged = self.up.merge_merchants({MERCHANT: "default"}, [MERCHANT.upper()])
        self.assertEqual(merged, {MERCHANT: "default"})

    def test_two_extra_merchants_differing_only_by_case_are_scanned_once(self):
        other = "0x" + "9" * 40
        merged = self.up.merge_merchants({}, [other, other.upper()])
        self.assertEqual(merged, {other: "ad-hoc (--merchant)"})


class AmountTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_parse_amount_applies_decimals(self):
        self.assertEqual(self.up.parse_amount("2500000", 6), Decimal("2.5"))
        self.assertEqual(self.up.parse_amount("1", 6), Decimal("0.000001"))

    def test_normalize_blockscout_item_uses_total_decimals(self):
        item = blockscout_item(from_addr=PAYER_A, value="1000000", decimals="6")
        normalized = self.up.normalize_blockscout_item(item)
        self.assertEqual(normalized["amount"], Decimal("1"))
        self.assertEqual(normalized["from"], PAYER_A.lower())
        self.assertIsInstance(normalized["timestamp"], datetime.datetime)

    def test_normalize_blockscout_item_falls_back_to_token_decimals(self):
        item = blockscout_item(from_addr=PAYER_A, value="1000000", decimals=None)
        item["total"].pop("decimals")
        item["token"] = {"decimals": 6}
        normalized = self.up.normalize_blockscout_item(item)
        self.assertEqual(normalized["amount"], Decimal("1"))

    def test_normalize_blockscout_item_rejects_incomplete_rows(self):
        self.assertIsNone(self.up.normalize_blockscout_item({"from": {}, "to": {"hash": MERCHANT}}))


class RetryTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def _http_error(self, code):
        return urllib.error.HTTPError("https://x.test", code, "err", {}, io.BytesIO(b""))

    def test_get_retries_on_429_then_succeeds_without_real_sleep(self):
        calls = {"n": 0}

        def fake_urlopen(request, timeout):
            calls["n"] += 1
            if calls["n"] < 3:
                raise self._http_error(429)
            return io.BytesIO(b'{"ok": true}')

        sleeps = []
        with patch.object(self.up.urllib.request, "urlopen", fake_urlopen):
            result = self.up._http_get_json("https://x.test", timeout=5, attempts=4, base_delay=1.0,
                                             sleep=sleeps.append)
        self.assertEqual(result, {"ok": True})
        self.assertEqual(calls["n"], 3)
        self.assertEqual(sleeps, [1.0, 2.0])  # exponential backoff, one sleep per failed attempt

    def test_get_retries_on_503_then_succeeds(self):
        calls = {"n": 0}

        def fake_urlopen(request, timeout):
            calls["n"] += 1
            if calls["n"] < 2:
                raise self._http_error(503)
            return io.BytesIO(b'{"ok": true}')

        sleeps = []
        with patch.object(self.up.urllib.request, "urlopen", fake_urlopen):
            result = self.up._http_get_json("https://x.test", timeout=5, sleep=sleeps.append)
        self.assertEqual(result, {"ok": True})
        self.assertEqual(sleeps, [0.5])

    def test_get_gives_up_after_exhausting_attempts(self):
        def fake_urlopen(request, timeout):
            raise self._http_error(500)

        sleeps = []
        with patch.object(self.up.urllib.request, "urlopen", fake_urlopen):
            with self.assertRaises(urllib.error.HTTPError):
                self.up._http_get_json("https://x.test", timeout=5, attempts=3, base_delay=0.1,
                                       sleep=sleeps.append)
        self.assertEqual(sleeps, [0.1, 0.2])  # slept between attempts, not after the last failure

    def test_get_does_not_retry_non_retryable_status(self):
        calls = {"n": 0}

        def fake_urlopen(request, timeout):
            calls["n"] += 1
            raise self._http_error(403)

        sleeps = []
        with patch.object(self.up.urllib.request, "urlopen", fake_urlopen):
            with self.assertRaises(urllib.error.HTTPError):
                self.up._http_get_json("https://x.test", timeout=5, sleep=sleeps.append)
        self.assertEqual(calls["n"], 1)
        self.assertEqual(sleeps, [])

    def test_post_retries_on_429_then_succeeds(self):
        calls = {"n": 0}

        def fake_urlopen(request, timeout):
            calls["n"] += 1
            if calls["n"] < 2:
                raise self._http_error(429)
            return io.BytesIO(b'{"result": 1}')

        sleeps = []
        with patch.object(self.up.urllib.request, "urlopen", fake_urlopen):
            result = self.up._http_post_json("https://x.test", {"a": 1}, timeout=5, sleep=sleeps.append)
        self.assertEqual(result, {"result": 1})
        self.assertEqual(sleeps, [0.5])

    def test_default_sleep_is_time_sleep_when_not_injected(self):
        def fake_urlopen(request, timeout):
            raise self._http_error(429)

        with patch.object(self.up.urllib.request, "urlopen", fake_urlopen), \
             patch.object(self.up.time, "sleep") as fake_sleep:
            with self.assertRaises(urllib.error.HTTPError):
                self.up._http_get_json("https://x.test", timeout=5, attempts=2, base_delay=0.1)
        fake_sleep.assert_called_once_with(0.1)


class BlockscoutPaginationTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_follows_next_page_params_until_absent(self):
        pages = [
            {"items": [blockscout_item(from_addr=PAYER_A)],
             "next_page_params": {"block_number": 100, "index": 1}},
            {"items": [blockscout_item(from_addr=PAYER_B)], "next_page_params": None},
        ]
        calls = []

        def fake_get(url, *, timeout):
            calls.append(url)
            return pages[len(calls) - 1]

        items = list(self.up.iter_blockscout_transfers(MERCHANT, http_get=fake_get))
        self.assertEqual(len(items), 2)
        self.assertEqual(len(calls), 2)
        self.assertIn("block_number=100", calls[1])
        self.assertIn("index=1", calls[1])

    def test_stops_when_next_page_params_missing_entirely(self):
        def fake_get(url, *, timeout):
            return {"items": [blockscout_item(from_addr=PAYER_A)]}

        items = list(self.up.iter_blockscout_transfers(MERCHANT, http_get=fake_get))
        self.assertEqual(len(items), 1)

    def test_runaway_pagination_raises_instead_of_looping_forever(self):
        def fake_get(url, *, timeout):
            return {"items": [], "next_page_params": {"x": 1}}

        with self.assertRaises(RuntimeError):
            list(self.up.iter_blockscout_transfers(MERCHANT, http_get=fake_get, max_pages=3))


class RpcFallbackTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_chunks_the_block_range(self):
        seen_ranges = []

        def fake_post(url, payload, *, timeout):
            params = payload["params"][0]
            seen_ranges.append((int(params["fromBlock"], 16), int(params["toBlock"], 16)))
            return {"result": []}

        list(self.up.iter_rpc_logs("https://rpc.test", self.up.USDC_BASE, MERCHANT, 100, 250,
                                   chunk_size=100, http_post=fake_post))
        self.assertEqual(seen_ranges, [(100, 199), (200, 250)])

    def test_pads_the_merchant_address_into_topic2(self):
        def fake_post(url, payload, *, timeout):
            topics = payload["params"][0]["topics"]
            self.assertEqual(topics[0], self.up.TRANSFER_TOPIC)
            self.assertIsNone(topics[1])
            self.assertEqual(topics[2], "0x" + "0" * 24 + MERCHANT[2:].lower())
            return {"result": []}

        list(self.up.iter_rpc_logs("https://rpc.test", self.up.USDC_BASE, MERCHANT, 1, 1, http_post=fake_post))

    def test_normalize_rpc_log_decodes_from_and_amount(self):
        log = {
            "topics": [self.up.TRANSFER_TOPIC, "0x" + "0" * 24 + PAYER_A[2:].lower(),
                      "0x" + "0" * 24 + MERCHANT[2:].lower()],
            "data": "0x" + format(2_500_000, "064x"),
            "blockNumber": "0x64",
            "transactionHash": "0xdeadbeef",
        }
        normalized = self.up.normalize_rpc_log(log, rpc_url="https://rpc.test", timeout=5, http_post=None,
                                               block_ts_cache={}, need_timestamp=False)
        self.assertEqual(normalized["from"], PAYER_A.lower())
        self.assertEqual(normalized["amount"], Decimal("2.5"))
        self.assertIsNone(normalized["timestamp"])

    def test_normalize_rpc_log_fetches_and_caches_block_timestamp(self):
        calls = []

        def fake_post(url, payload, *, timeout):
            calls.append(payload["method"])
            return {"result": {"timestamp": hex(1_700_000_000)}}

        log = {
            "topics": [self.up.TRANSFER_TOPIC, "0x" + "0" * 24 + PAYER_A[2:].lower(),
                      "0x" + "0" * 24 + MERCHANT[2:].lower()],
            "data": "0x" + format(1, "064x"),
            "blockNumber": "0x64",
            "transactionHash": "0x1",
        }
        cache = {}
        first = self.up.normalize_rpc_log(log, rpc_url="https://rpc.test", timeout=5, http_post=fake_post,
                                          block_ts_cache=cache, need_timestamp=True)
        second = self.up.normalize_rpc_log(log, rpc_url="https://rpc.test", timeout=5, http_post=fake_post,
                                           block_ts_cache=cache, need_timestamp=True)
        self.assertEqual(first["timestamp"], second["timestamp"])
        self.assertEqual(calls, ["eth_getBlockByNumber"])  # second call hit the cache


class AggregateTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def _transfer(self, *, from_addr, amount="1", day="2026-01-10"):
        return {
            "from": from_addr.lower(),
            "amount": Decimal(amount),
            "timestamp": datetime.datetime.fromisoformat(f"{day}T00:00:00+00:00"),
            "tx_hash": "0x1",
        }

    def test_unique_payers_and_totals(self):
        transfers = [
            self._transfer(from_addr=PAYER_A, amount="1"),
            self._transfer(from_addr=PAYER_A, amount="2"),
            self._transfer(from_addr=PAYER_B, amount="3"),
        ]
        report = self.up.aggregate({MERCHANT: transfers}, exclude=frozenset())
        self.assertEqual(report["unique_external_payers"], 2)
        self.assertEqual(report["payments"], 3)
        self.assertEqual(report["total_usdc"], "6.000000")
        self.assertEqual(report["excluded_own_payments"], 0)
        self.assertEqual(report["zero_value_skipped"], 0)
        self.assertEqual(report["_payers"], {PAYER_A.lower(), PAYER_B.lower()})

    def test_zero_value_transfer_is_skipped_and_counted(self):
        transfers = [
            self._transfer(from_addr=PAYER_A, amount="0"),
            self._transfer(from_addr=PAYER_A, amount="1"),
            self._transfer(from_addr=PAYER_B, amount="0"),
        ]
        report = self.up.aggregate({MERCHANT: transfers}, exclude=frozenset())
        # PAYER_B only ever sent a 0-value (spam) transfer, so it must not count as a payer.
        self.assertEqual(report["unique_external_payers"], 1)
        self.assertEqual(report["payments"], 1)
        self.assertEqual(report["total_usdc"], "1.000000")
        self.assertEqual(report["zero_value_skipped"], 2)
        self.assertEqual(report["per_merchant"][MERCHANT]["zero_value_skipped"], 2)
        self.assertEqual(report["_payers"], {PAYER_A.lower()})

    def test_zero_value_transfer_from_an_excluded_address_is_not_double_counted(self):
        transfers = [self._transfer(from_addr=PAYER_A, amount="0")]
        report = self.up.aggregate({MERCHANT: transfers}, exclude=frozenset({PAYER_A.lower()}))
        self.assertEqual(report["zero_value_skipped"], 1)
        self.assertEqual(report["excluded_own_payments"], 0)
        self.assertEqual(report["payments"], 0)

    def test_excluded_payer_is_not_counted_as_external(self):
        transfers = [self._transfer(from_addr=PAYER_A), self._transfer(from_addr=PAYER_B)]
        report = self.up.aggregate({MERCHANT: transfers}, exclude=frozenset({PAYER_A.lower()}))
        self.assertEqual(report["unique_external_payers"], 1)
        self.assertEqual(report["payments"], 1)
        self.assertEqual(report["excluded_own_payments"], 1)

    def test_exclusion_is_case_insensitive(self):
        transfers = [self._transfer(from_addr=PAYER_A)]
        report = self.up.aggregate({MERCHANT: transfers}, exclude=frozenset({PAYER_A.lower()}))
        self.assertEqual(report["unique_external_payers"], 0)
        self.assertEqual(report["excluded_own_payments"], 1)

    def test_since_filters_out_earlier_payments(self):
        transfers = [self._transfer(from_addr=PAYER_A, day="2026-01-01"),
                     self._transfer(from_addr=PAYER_B, day="2026-02-01")]
        report = self.up.aggregate({MERCHANT: transfers}, exclude=frozenset(),
                                   since=datetime.date(2026, 1, 15))
        self.assertEqual(report["payments"], 1)
        self.assertEqual(report["date_range"], {"from": "2026-02-01", "to": "2026-02-01"})

    def test_per_merchant_breakdown(self):
        other = "0x" + "9" * 40
        report = self.up.aggregate(
            {MERCHANT: [self._transfer(from_addr=PAYER_A)], other: [self._transfer(from_addr=PAYER_B, amount="5")]},
            exclude=frozenset())
        self.assertEqual(report["per_merchant"][MERCHANT]["unique_payers"], 1)
        self.assertEqual(report["per_merchant"][other]["total_usdc"], "5.000000")
        self.assertEqual(report["unique_external_payers"], 2)  # the two merchants' payers don't collide


class MainCliTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def _run(self, argv, *, http_get, env=None, chain="base"):
        # Pinned to --chain base unless the test overrides it: these tests only mock the Blockscout
        # HTTP path, and the default --chain is "all", which would otherwise also try a real
        # Solana RPC call.
        argv = (["--chain", chain] if chain else []) + list(argv)
        with patch.object(self.up, "_http_get_json", http_get):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = self.up.main(argv, env=env or {})
        return code, out.getvalue(), err.getvalue()

    def _fake_get(self, items):
        def fake_get(url, *, timeout):
            return {"items": items, "next_page_params": None}
        return fake_get

    def test_list_is_off_by_default_no_addresses_and_no_warning(self):
        items = [blockscout_item(from_addr=PAYER_A), blockscout_item(from_addr=PAYER_B)]
        code, out, err = self._run(["--json"], http_get=self._fake_get(items))
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        report = json.loads(out)
        self.assertNotIn("payer_addresses", report)
        self.assertNotIn(PAYER_A.lower(), out.lower())
        self.assertEqual(report["unique_external_payers"], 2)

    def test_list_prints_addresses_and_a_stderr_warning(self):
        items = [blockscout_item(from_addr=PAYER_A), blockscout_item(from_addr=PAYER_B)]
        code, out, err = self._run(["--json", "--list"], http_get=self._fake_get(items))
        self.assertEqual(code, 0)
        self.assertIn("WARNING", err)
        self.assertIn("do not publish", err.lower())
        report = json.loads(out)
        self.assertEqual(sorted(report["payer_addresses"]), sorted([PAYER_A.lower(), PAYER_B.lower()]))

    def test_own_wallet_env_excludes_a_payer(self):
        items = [blockscout_item(from_addr=PAYER_A), blockscout_item(from_addr=PAYER_B)]
        code, out, _ = self._run(["--json"], http_get=self._fake_get(items),
                                 env={self.up.EXCLUDE_ENV: PAYER_A})
        report = json.loads(out)
        self.assertEqual(report["unique_external_payers"], 1)
        self.assertEqual(report["excluded_own_payments"], 1)

    def test_merchant_self_transfer_is_excluded_automatically(self):
        items = [blockscout_item(from_addr=MERCHANT), blockscout_item(from_addr=PAYER_A)]
        code, out, _ = self._run(["--json"], http_get=self._fake_get(items))
        report = json.loads(out)
        self.assertEqual(report["unique_external_payers"], 1)
        self.assertEqual(report["excluded_own_payments"], 1)

    def test_rpc_without_block_range_is_a_usage_error(self):
        with self.assertRaises(SystemExit):
            self.up.main(["--rpc", "https://rpc.test"], env={})

    def test_blockscout_http_error_is_reported_not_raised(self):
        def fake_get(url, *, timeout):
            raise urllib.error.HTTPError(url, 403, "forbidden", {}, io.BytesIO(b""))

        code, out, _ = self._run(["--json"], http_get=fake_get)
        self.assertEqual(code, 0)
        report = json.loads(out)
        self.assertIn(MERCHANT, report["errors"])
        self.assertIn("403", report["errors"][MERCHANT])
        self.assertEqual(report["unique_external_payers"], 0)

    def test_text_summary_is_the_default_and_has_no_addresses(self):
        items = [blockscout_item(from_addr=PAYER_A)]
        code, out, _ = self._run([], http_get=self._fake_get(items))
        self.assertIn("Unique external payers: 1", out)
        self.assertNotIn(PAYER_A.lower(), out.lower())

    def test_zero_value_transfer_is_excluded_from_count_and_reported(self):
        items = [blockscout_item(from_addr=PAYER_A, value="0"), blockscout_item(from_addr=PAYER_B, value="5000000")]
        code, out, _ = self._run(["--json"], http_get=self._fake_get(items))
        report = json.loads(out)
        self.assertEqual(report["unique_external_payers"], 1)
        self.assertEqual(report["zero_value_skipped"], 1)

    def test_merchant_duplicating_default_case_insensitively_is_scanned_once(self):
        calls = []

        def fake_get(url, *, timeout):
            calls.append(url)
            return {"items": [blockscout_item(from_addr=PAYER_A)], "next_page_params": None}

        code, out, _ = self._run(["--json", "--merchant", MERCHANT.upper()], http_get=fake_get)
        report = json.loads(out)
        self.assertEqual(len(calls), 1)  # not scanned twice under the two different casings
        self.assertEqual(list(report["merchants"]), [MERCHANT])


class ChunkSizeTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_nonpositive_chunk_size_is_rejected(self):
        for bad in (0, -5):
            with self.assertRaises(ValueError):
                list(self.up.iter_rpc_logs("https://rpc.test", self.up.USDC_BASE, MERCHANT, 1, 10, chunk_size=bad,
                                           http_post=lambda *a, **k: {"result": []}))

    def test_cli_rejects_zero_chunk_size(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.up._build_parser().parse_args(["--chunk-size", "0"])

    def test_cli_rejects_reversed_block_range(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as cm:
            self.up.main(["--rpc", "https://rpc.test", "--from-block", "200", "--to-block", "100"], env={})
        self.assertIn("--from-block", str(cm.exception.code))


def solana_tx(*, pre, post, err=None, block_time=1_700_000_000, signature="sig"):
    def balances(entries):
        return [{"accountIndex": i, "mint": SOLANA_USDC, "owner": owner,
                  "uiTokenAmount": {"amount": str(amount), "decimals": 6}}
                for i, (owner, amount) in enumerate(entries)]
    return {
        "blockTime": block_time,
        "meta": {"err": err, "preTokenBalances": balances(pre), "postTokenBalances": balances(post)},
        "transaction": {"message": {"accountKeys": []}, "signatures": [signature]},
    }


class SolanaTransactionParsingTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_payer_is_the_owner_whose_balance_decreased(self):
        tx = solana_tx(pre=[(SOLANA_PAYER_A, 5_000_000), (SOLANA_MERCHANT, 0)],
                       post=[(SOLANA_PAYER_A, 2_500_000), (SOLANA_MERCHANT, 2_500_000)])
        t = self.up.normalize_solana_transaction(tx, merchant=SOLANA_MERCHANT, signature="sig")
        self.assertEqual(t["from"], SOLANA_PAYER_A)
        self.assertEqual(t["amount"], Decimal("2.5"))
        self.assertEqual(t["tx_hash"], "sig")
        self.assertIsInstance(t["timestamp"], datetime.datetime)

    def test_facilitator_fee_payer_is_not_attributed_even_if_present_in_other_mint_balances(self):
        tx = solana_tx(pre=[(SOLANA_PAYER_A, 5_000_000)], post=[(SOLANA_PAYER_A, 2_500_000),
                       (SOLANA_MERCHANT, 2_500_000)])
        # The fee payer only ever shows up holding SOL / another mint, never this mint -- simulate by
        # adding an other-mint balance for it, which normalize_solana_transaction must ignore.
        tx["meta"]["preTokenBalances"].append({"accountIndex": 9, "mint": "SomeOtherMint111111111111111111111111111",
                                               "owner": SOLANA_FEE_PAYER, "uiTokenAmount": {"amount": "1", "decimals": 6}})
        t = self.up.normalize_solana_transaction(tx, merchant=SOLANA_MERCHANT, signature="sig")
        self.assertEqual(t["from"], SOLANA_PAYER_A)
        self.assertNotEqual(t["from"], SOLANA_FEE_PAYER)

    def test_failed_transaction_is_skipped(self):
        tx = solana_tx(pre=[(SOLANA_PAYER_A, 5_000_000)],
                       post=[(SOLANA_PAYER_A, 2_500_000), (SOLANA_MERCHANT, 2_500_000)],
                       err={"InstructionError": [0, "Custom"]})
        self.assertIsNone(self.up.normalize_solana_transaction(tx, merchant=SOLANA_MERCHANT, signature="sig"))

    def test_zero_value_is_skipped(self):
        tx = solana_tx(pre=[(SOLANA_PAYER_A, 5_000_000), (SOLANA_MERCHANT, 1_000_000)],
                       post=[(SOLANA_PAYER_A, 5_000_000), (SOLANA_MERCHANT, 1_000_000)])
        self.assertIsNone(self.up.normalize_solana_transaction(tx, merchant=SOLANA_MERCHANT, signature="sig"))

    def test_merchant_not_receiving_usdc_is_skipped(self):
        tx = solana_tx(pre=[(SOLANA_MERCHANT, 1_000_000)], post=[(SOLANA_MERCHANT, 0)])
        self.assertIsNone(self.up.normalize_solana_transaction(tx, merchant=SOLANA_MERCHANT, signature="sig"))

    def test_multiple_decreasing_owners_attributes_unique_exact_match(self):
        tx = solana_tx(pre=[(SOLANA_PAYER_A, 10_000_000), (SOLANA_PAYER_B, 10_000_000)],
                       post=[(SOLANA_PAYER_A, 7_000_000), (SOLANA_PAYER_B, 3_000_000), (SOLANA_MERCHANT, 7_000_000)])
        t = self.up.normalize_solana_transaction(tx, merchant=SOLANA_MERCHANT, signature="sig")
        self.assertEqual(t["from"], SOLANA_PAYER_B)  # -7 USDC, bigger than payer A's -3 USDC

    def test_null_transaction_is_unavailable(self):
        self.assertEqual(self.up.normalize_solana_transaction(None, merchant=SOLANA_MERCHANT, signature="sig")["status"], "unavailable")


class SolanaTokenAccountsTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_queries_by_owner_and_mint_and_returns_pubkeys(self):
        def fake_post(url, payload, *, timeout):
            self.assertEqual(payload["method"], "getTokenAccountsByOwner")
            self.assertEqual(payload["params"][:2], [SOLANA_MERCHANT, {"mint": SOLANA_USDC}])
            return {"result": {"value": [{"pubkey": "ACC1"}, {"pubkey": "ACC2"}]}}
        accounts = self.up.iter_solana_token_accounts("https://rpc.test", SOLANA_MERCHANT, SOLANA_USDC,
                                                       http_post=fake_post)
        self.assertEqual(accounts, ["ACC1", "ACC2"])


class SolanaSignaturePaginationTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_paginates_with_before_until_an_empty_page(self):
        pages = [[{"signature": "s1", "blockTime": 2000, "err": None},
                 {"signature": "s2", "blockTime": 1900, "err": None}], []]
        calls = []

        def fake_post(url, payload, *, timeout):
            calls.append(payload["params"][1])
            return {"result": pages[len(calls) - 1]}

        sigs = list(self.up.iter_solana_signatures("https://rpc.test", SOLANA_MERCHANT, http_post=fake_post,
                                                    limit=2, delay=0, sleep=lambda s: None))
        self.assertEqual([s["signature"] for s in sigs], ["s1", "s2"])
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1]["before"], "s2")

    def test_stops_once_a_page_reaches_the_since_cutoff_without_fetching_more(self):
        new_day = int(datetime.datetime(2026, 3, 1, tzinfo=datetime.timezone.utc).timestamp())
        old_day = int(datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc).timestamp())
        pages = [[{"signature": "new1", "blockTime": new_day, "err": None}],
                 [{"signature": "old1", "blockTime": old_day, "err": None}]]
        calls = []

        def fake_post(url, payload, *, timeout):
            calls.append(payload)
            if len(calls) > 2:
                raise AssertionError("must not paginate past the --since cutoff")
            return {"result": pages[len(calls) - 1]}

        sigs = list(self.up.iter_solana_signatures("https://rpc.test", SOLANA_MERCHANT,
                                                    since=datetime.date(2026, 2, 1), http_post=fake_post,
                                                    limit=1, delay=0, sleep=lambda s: None))
        self.assertEqual([s["signature"] for s in sigs], ["new1"])
        self.assertEqual(len(calls), 2)

    def test_runaway_pagination_raises_instead_of_looping_forever(self):
        def fake_post(url, payload, *, timeout):
            return {"result": [{"signature": "s", "blockTime": None, "err": None}]}

        with self.assertRaises(RuntimeError):
            list(self.up.iter_solana_signatures("https://rpc.test", SOLANA_MERCHANT, http_post=fake_post,
                                                 limit=1, max_pages=3, delay=0, sleep=lambda s: None))


class SolanaTransfersIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_same_signature_seen_via_two_token_accounts_is_not_double_counted(self):
        def fake_post(url, payload, *, timeout):
            method = payload["method"]
            if method == "getTokenAccountsByOwner":
                return {"result": {"value": [{"pubkey": "ACC1"}, {"pubkey": "ACC2"}]}}
            if method == "getSignaturesForAddress":
                if "before" in payload["params"][1]:
                    return {"result": []}
                return {"result": [{"signature": "sig1", "blockTime": 1_700_000_000, "err": None}]}
            if method == "getTransaction":
                return {"result": solana_tx(pre=[(SOLANA_PAYER_A, 5_000_000)],
                                            post=[(SOLANA_PAYER_A, 2_500_000), (SOLANA_MERCHANT, 2_500_000)])}
            raise AssertionError(method)

        transfers = list(self.up.iter_solana_transfers("https://rpc.test", SOLANA_MERCHANT, http_post=fake_post,
                                                        delay=0, sleep=lambda s: None))
        self.assertEqual(len(transfers), 1)

    def test_failed_signature_skips_the_getTransaction_call(self):
        get_tx_calls = []

        def fake_post(url, payload, *, timeout):
            method = payload["method"]
            if method == "getTokenAccountsByOwner":
                return {"result": {"value": [{"pubkey": "ACC1"}]}}
            if method == "getSignaturesForAddress":
                if "before" in payload["params"][1]:
                    return {"result": []}
                return {"result": [{"signature": "sig1", "blockTime": 1_700_000_000, "err": {"x": 1}}]}
            if method == "getTransaction":
                get_tx_calls.append(payload)
                return {"result": None}
            raise AssertionError(method)

        transfers = list(self.up.iter_solana_transfers("https://rpc.test", SOLANA_MERCHANT, http_post=fake_post,
                                                        delay=0, sleep=lambda s: None))
        self.assertEqual(transfers, [])
        self.assertEqual(get_tx_calls, [])


class ExcludeDbTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def _make_db(self, directory, name, script):
        path = Path(directory) / name
        conn = sqlite3.connect(path)
        try:
            conn.executescript(script)
            conn.commit()
        finally:
            conn.close()
        return path

    def test_loads_non_empty_values_from_one_column_case_preserving(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._make_db(tmp, "allowance.db",
                "CREATE TABLE agents (agent_address TEXT);"
                f"INSERT INTO agents VALUES ('{PAYER_A}'), (''), (NULL), ('{SOLANA_PAYER_A}');")
            addrs, label = self.up.load_exclude_db(f"{path}:agents.agent_address")
        self.assertEqual(addrs, frozenset({PAYER_A.lower(), SOLANA_PAYER_A}))
        self.assertEqual(label, "allowance.db:agents.agent_address")

    def test_opens_the_database_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._make_db(tmp, "allowance.db",
                "CREATE TABLE agents (agent_address TEXT); INSERT INTO agents VALUES ('x');")
            self.up.load_exclude_db(f"{path}:agents.agent_address")
            conn = sqlite3.connect(path)
            try:
                rows = conn.execute("SELECT agent_address FROM agents").fetchall()
            finally:
                conn.close()
            self.assertEqual(rows, [("x",)])  # untouched by the read-only open

    def test_rejects_invalid_table_identifier(self):
        with self.assertRaises(ValueError):
            self.up.load_exclude_db("/tmp/x.db:bad-table.col")

    def test_rejects_invalid_column_identifier(self):
        with self.assertRaises(ValueError):
            self.up.load_exclude_db("/tmp/x.db:table.bad-col")

    def test_spec_without_colon_is_rejected(self):
        with self.assertRaises(ValueError):
            self.up.load_exclude_db("no-colon-here")

    def test_spec_without_dot_is_rejected(self):
        with self.assertRaises(ValueError):
            self.up.load_exclude_db("/tmp/x.db:justtable")

    def test_missing_file_is_a_clear_error_without_addresses(self):
        with self.assertRaises(ValueError) as cm:
            self.up.load_exclude_db("/no/such/path/allowance.db:agents.agent_address")
        self.assertIn("not found", str(cm.exception))
        self.assertNotIn(PAYER_A.lower(), str(cm.exception).lower())

    def test_missing_table_is_a_clear_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._make_db(tmp, "allowance.db", "CREATE TABLE other (x TEXT);")
            with self.assertRaises(ValueError) as cm:
                self.up.load_exclude_db(f"{path}:agents.agent_address")
        self.assertIn("agents.agent_address", str(cm.exception))


class SolanaCaseSensitivityTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_normalize_address_only_lowercases_0x_addresses(self):
        self.assertEqual(self.up.normalize_address(PAYER_A), PAYER_A.lower())
        self.assertEqual(self.up.normalize_address(SOLANA_PAYER_A), SOLANA_PAYER_A)
        self.assertEqual(self.up.normalize_address(SOLANA_PAYER_A.lower()), SOLANA_PAYER_A.lower())

    def test_default_merchants_of_both_chains_are_always_excluded(self):
        exclude = self.up.load_exclusions(None, None)
        self.assertIn(MERCHANT.lower(), exclude)
        self.assertIn(SOLANA_MERCHANT, exclude)

    def test_solana_exclusion_via_env_is_case_sensitive(self):
        exclude = self.up.load_exclusions(SOLANA_PAYER_A, None)
        self.assertIn(SOLANA_PAYER_A, exclude)
        self.assertNotIn(SOLANA_PAYER_A.lower(), exclude)
        self.assertNotIn(SOLANA_PAYER_A.upper(), exclude)

    def test_aggregate_does_not_match_a_differently_cased_solana_exclusion(self):
        transfer = {"from": SOLANA_PAYER_A, "amount": Decimal("1"), "timestamp": None, "tx_hash": "x"}
        report = self.up.aggregate({SOLANA_MERCHANT: [transfer]}, exclude=frozenset({SOLANA_PAYER_A.lower()}))
        self.assertEqual(report["unique_external_payers"], 1)
        self.assertEqual(report["excluded_own_payments"], 0)


class VpsOwnWalletsTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_specs_expand_under_home_sign402(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"HOME": tmp}):
                specs = self.up.vps_own_wallet_specs()
        expected_dir = str(Path(tmp) / ".sign402")
        self.assertEqual(specs, [
            f"{expected_dir}/allowance.db:agents.agent_address",
            f"{expected_dir}/solana-allowance.db:agents.agent_address",
        ])

    def test_vps_own_wallets_flag_excludes_agents_but_keeps_limiters(self):
        with tempfile.TemporaryDirectory() as tmp:
            sign402_dir = Path(tmp) / ".sign402"
            sign402_dir.mkdir()
            conn = sqlite3.connect(sign402_dir / "allowance.db")
            conn.executescript(
                "CREATE TABLE agents (agent_address TEXT);"
                f"INSERT INTO agents VALUES ('{PAYER_A}');"
                "CREATE TABLE limiters (limiter_address TEXT, agent_address TEXT);"
                f"INSERT INTO limiters VALUES ('{PAYER_B}', '{PAYER_A}');")
            conn.commit()
            conn.close()
            conn = sqlite3.connect(sign402_dir / "solana-allowance.db")
            conn.executescript("CREATE TABLE agents (agent_address TEXT); "
                               f"INSERT INTO agents VALUES ('{SOLANA_PAYER_A}');")
            conn.commit()
            conn.close()

            items = [blockscout_item(from_addr=PAYER_A), blockscout_item(from_addr=PAYER_B)]

            def fake_get(url, *, timeout):
                return {"items": items, "next_page_params": None}

            with patch.dict(os.environ, {"HOME": tmp}), patch.object(self.up, "_http_get_json", fake_get):
                out, err = io.StringIO(), io.StringIO()
                with redirect_stdout(out), redirect_stderr(err):
                    self.up.main(["--chain", "base", "--vps-own-wallets", "--json"], env={})
            report = json.loads(out.getvalue())
            self.assertEqual(report["unique_external_payers"], 1)
            self.assertEqual(report["excluded_own_payments"], 1)
            self.assertIn("loaded 1 exclusion address(es)", err.getvalue())

    def test_vps_own_wallets_does_not_include_custodial_user_wallets(self):
        specs = self.up.vps_own_wallet_specs()
        self.assertTrue(all("user-wallets" not in s and "user_wallets" not in s for s in specs))


class ChainSelectionTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_chain_solana_does_not_call_blockscout(self):
        get_calls = []

        def fake_get(url, *, timeout):
            get_calls.append(url)
            return {"items": [], "next_page_params": None}

        def fake_post(url, payload, *, timeout):
            if payload["method"] == "getTokenAccountsByOwner":
                return {"result": {"value": []}}
            raise AssertionError(payload["method"])

        with patch.object(self.up, "_http_get_json", fake_get), patch.object(self.up, "_http_post_json", fake_post):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                self.up.main(["--chain", "solana", "--json", "--solana-delay", "0"], env={})
        self.assertEqual(get_calls, [])
        report = json.loads(out.getvalue())
        self.assertEqual(list(report["chains"]), ["solana"])
        self.assertEqual(report["chains"]["solana"]["rpc_host"], "api.mainnet-beta.solana.com")

    def test_chain_base_does_not_call_solana_rpc(self):
        post_calls = []

        def fake_get(url, *, timeout):
            return {"items": [], "next_page_params": None}

        def fake_post(url, payload, *, timeout):
            post_calls.append(payload)
            return {"result": {"value": []}}

        with patch.object(self.up, "_http_get_json", fake_get), patch.object(self.up, "_http_post_json", fake_post):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                self.up.main(["--chain", "base", "--json"], env={})
        self.assertEqual(post_calls, [])

    def test_solana_rpc_url_is_never_printed_only_its_host(self):
        def fake_post(url, payload, *, timeout):
            if payload["method"] == "getTokenAccountsByOwner":
                return {"result": {"value": []}}
            raise AssertionError(payload["method"])

        secret_rpc = "https://rpc.example/secret-api-key-123"
        with patch.object(self.up, "_http_post_json", fake_post):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                self.up.main(["--chain", "solana", "--solana-rpc", secret_rpc, "--json", "--solana-delay", "0"],
                            env={})
        self.assertNotIn("secret-api-key-123", out.getvalue())
        self.assertNotIn("secret-api-key-123", err.getvalue())
        report = json.loads(out.getvalue())
        self.assertEqual(report["chains"]["solana"]["rpc_host"], "rpc.example")


class CombinedReportTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_combined_sums_across_chains_and_breaks_down_per_chain(self):
        def fake_get(url, *, timeout):
            return {"items": [blockscout_item(from_addr=PAYER_A), blockscout_item(from_addr=PAYER_B)],
                    "next_page_params": None}

        def fake_post(url, payload, *, timeout):
            method = payload["method"]
            if method == "getTokenAccountsByOwner":
                return {"result": {"value": [{"pubkey": "ACC1"}]}}
            if method == "getSignaturesForAddress":
                if "before" in payload["params"][1]:
                    return {"result": []}
                return {"result": [{"signature": "sig1", "blockTime": 1_700_000_000, "err": None}]}
            if method == "getTransaction":
                return {"result": solana_tx(pre=[(SOLANA_PAYER_A, 5_000_000)],
                                            post=[(SOLANA_PAYER_A, 2_500_000), (SOLANA_MERCHANT, 2_500_000)])}
            raise AssertionError(method)

        with patch.object(self.up, "_http_get_json", fake_get), patch.object(self.up, "_http_post_json", fake_post):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                self.up.main(["--chain", "all", "--json", "--solana-delay", "0"], env={})
        report = json.loads(out.getvalue())
        self.assertEqual(report["chains"]["base"]["unique_external_payers"], 2)
        self.assertEqual(report["chains"]["solana"]["unique_external_payers"], 1)
        self.assertEqual(report["unique_external_payers"], 3)  # SUM, not deduplicated across address spaces
        self.assertIn("SUM", report["combined_note"])
        self.assertEqual(report["merchants"][MERCHANT], "singit-ask metered chat (Base)")
        self.assertEqual(report["merchants"][SOLANA_MERCHANT], "singit-ask metered chat (Solana)")

    def test_single_chain_report_has_no_combined_note(self):
        def fake_get(url, *, timeout):
            return {"items": [blockscout_item(from_addr=PAYER_A)], "next_page_params": None}

        with patch.object(self.up, "_http_get_json", fake_get):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                self.up.main(["--chain", "base", "--json"], env={})
        report = json.loads(out.getvalue())
        self.assertNotIn("combined_note", report)


class AmountFilterTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def test_exact_atomic_matching_all_metrics_and_since(self):
        def transfer(payer, amount, day):
            return dict(from_display=payer, amount=Decimal(amount), timestamp=
                        datetime.datetime(2026, 1, day, tzinfo=datetime.timezone.utc),
                        **{"from": payer, "tx_hash": "test"})
        transfers = {MERCHANT: [
            transfer(PAYER_A, "0.010100", 15),
            transfer(PAYER_B, "0.006200", 16),
            transfer(PAYER_B, "0.0101001", 17),
            transfer(MERCHANT.lower(), "0.010100", 18),
            transfer(MERCHANT.lower(), "2", 19),
            transfer(PAYER_A, "0", 20),
            transfer(PAYER_B, "0.006200", 1),
        ]}
        kwargs = dict(exclude=frozenset({MERCHANT.lower()}), since=datetime.date(2026, 1, 10))
        raw = self.up.aggregate(transfers, **kwargs)
        filtered = self.up.aggregate(transfers, amount_filter_atomic=frozenset({10100}), **kwargs)
        self.assertEqual((raw['payments'], raw['excluded_own_payments'], raw['zero_value_skipped']), (3, 2, 1))
        self.assertEqual(filtered['unique_external_payers'], 1)
        self.assertEqual(filtered['payments'], 1)
        self.assertEqual(filtered['total_usdc'], '0.010100')
        self.assertEqual(filtered['excluded_own_payments'], 1)
        self.assertEqual(filtered['zero_value_skipped'], 0)
        self.assertEqual(filtered['date_range'], {'from': '2026-01-15', 'to': '2026-01-15'})
        self.assertEqual(filtered['per_merchant'][MERCHANT]['payments'], 1)
        zeros = self.up.aggregate(transfers, amount_filter_atomic=frozenset({0}), **kwargs)
        self.assertEqual(zeros['zero_value_skipped'], 1)
        self.assertEqual(zeros['payments'], 0)

    def test_cli_preset_custom_override_and_both_chains(self):
        for flags, expected in [(['--exa-search-amounts'], 2),
                                (['--amount-filter-atomic', '6200'], 1),
                                (['--exa-search-amounts', '--amount-filter-atomic', '6200'], 1)]:
            with self.subTest(flags=flags):
                transfers = {MERCHANT: [dict(amount=Decimal(a), timestamp=None,
                             **{'from': PAYER_A, 'tx_hash': 'test'})
                             for a in ('0.010100', '0.006200', '1')]}
                sol = {SOLANA_MERCHANT: [dict(amount=Decimal('0.006200'), timestamp=None,
                                       **{'from': SOLANA_PAYER_A, 'tx_hash': 'test'})]}
                out = io.StringIO()
                with patch.object(self.up, '_scan_base', return_value=(transfers, {})), \
                     patch.object(self.up, '_scan_solana', return_value=(sol, {})), redirect_stdout(out):
                    self.up.main(flags + ['--json'], env={})
                report = json.loads(out.getvalue())
                self.assertEqual(report['payments'], 4)
                self.assertEqual(report['filtered']['payments'], expected + 1)
                self.assertEqual(report['chains']['base']['filtered']['payments'], expected)
                self.assertEqual(report['chains']['solana']['filtered']['payments'], 1)
                self.assertEqual(report['filtered']['unique_external_payers'], 2)
                text = self.up.text_summary(report)
                self.assertIn('Unfiltered metrics:', text)
                self.assertIn('Filtered metrics', text)
                self.assertIn('Chain solana metrics:', text)
                self.assertIn('Excluded own payments:', text)
                self.assertIn('Date range:', text)

    def test_invalid_amount_lists_rejected(self):
        for value in ('', '1,', '-1', '1.0', '1e4', 'abc', '1,,2'):
            with self.subTest(value=value), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.up._build_parser().parse_args(['--amount-filter-atomic', value])
        self.assertEqual(self.up._build_parser().parse_args(
            ['--amount-filter-atomic', ' 6200,10100,6200,0 ']).amount_filter_atomic,
            frozenset({6200, 10100, 0}))

    def test_missing_database_column_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'wallets.db'
            with sqlite3.connect(path) as conn:
                conn.execute('CREATE TABLE agents (other TEXT)')
            with self.assertRaisesRegex(ValueError, 'cannot read'):
                self.up.load_exclude_db(f'{path}:agents.agent_address')


class ReviewRegressionTests(unittest.TestCase):
    def setUp(self):
        self.up = load_unique_payers()

    def normalize(self, tx):
        return self.up.normalize_solana_transaction(tx, merchant=SOLANA_MERCHANT, signature="sig")

    def test_exact_match_wins_over_larger_decrease_and_order(self):
        for owners in ([SOLANA_PAYER_A, SOLANA_PAYER_B], [SOLANA_PAYER_B, SOLANA_PAYER_A]):
            tx = solana_tx(pre=[(o, 10_000_000) for o in owners],
                           post=[(SOLANA_PAYER_A, 8_000_000), (SOLANA_PAYER_B, 3_000_000),
                                 (SOLANA_MERCHANT, 2_000_000)])
            self.assertEqual(self.normalize(tx)["from"], SOLANA_PAYER_A)

    def test_ambiguous_and_no_decreasing_owner_are_counts_not_payers(self):
        records = []
        for pre in ([(SOLANA_PAYER_A, 2), (SOLANA_PAYER_B, 2)],
                    [(SOLANA_PAYER_A, 3), (SOLANA_PAYER_B, 4)], []):
            record = self.normalize(solana_tx(pre=pre, post=[(SOLANA_MERCHANT, 2)]))
            self.assertEqual(record["status"], "unattributed")
            self.assertNotIn("from", record)
            records.append(record)
        records += [self.normalize(None), self.normalize({"meta": None})]
        report = self.up.aggregate({SOLANA_MERCHANT: records}, exclude=frozenset())
        self.assertEqual((report["payments"], report["unique_external_payers"]), (0, 0))
        self.assertEqual(report["unattributed"], 4)
        self.assertEqual(report["unavailable"], 1)
        self.assertEqual(report["per_merchant"][SOLANA_MERCHANT]["unattributed"], 4)
        combined = self.up.combine_chain_reports({"solana": report})
        self.assertEqual(json.loads(json.dumps(combined))["unavailable"], 1)
        text = self.up.text_summary(combined)
        self.assertIn("4 unattributed, 1 unavailable", text)

    def test_rpc_unresolved_records_survive_scan_and_cli(self):
        def post(url, payload, **kwargs):
            method = payload["method"]
            if method == "getTokenAccountsByOwner":
                return {"result": {"value": [{"pubkey": "account"}]}}
            if method == "getSignaturesForAddress":
                return {"result": [] if "before" in payload["params"][1] else
                        [{"signature": sig} for sig in ("null", "meta", "owner")]}
            if method == "getTransaction":
                return {"result": {"null": None, "meta": {}, "owner":
                        solana_tx(pre=[], post=[(SOLANA_MERCHANT, 1)])}[payload["params"][0]]}
            raise AssertionError(method)
        out = io.StringIO()
        with patch.object(self.up, "_http_post_json", post), redirect_stdout(out):
            self.up.main(["--chain", "solana", "--solana-delay", "0", "--json"], env={})
        report = json.loads(out.getvalue())
        self.assertEqual(report["per_merchant"][SOLANA_MERCHANT]["unattributed"], 2)
        self.assertEqual(report["per_merchant"][SOLANA_MERCHANT]["unavailable"], 1)
        self.assertEqual(report["unique_external_payers"], 0)

    def test_short_signature_pages_continue(self):
        pages = [[{"signature": "a"}], [{"signature": "b"}], []]
        calls = []
        def post(url, payload, **kwargs):
            calls.append(payload)
            return {"result": pages.pop(0)}
        result = list(self.up.iter_solana_signatures("unused", "account", http_post=post, delay=0))
        self.assertEqual([r["signature"] for r in result], ["a", "b"])
        self.assertEqual(calls[2]["params"][1]["before"], "b")

    def test_corrupt_db_and_connect_errors_are_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "broken.db"
            path.write_text("not sqlite")
            with self.assertRaisesRegex(ValueError, "cannot read"):
                self.up.load_exclude_db(f"{path}:agents.agent_address")
            with patch.object(self.up.sqlite3, "connect", side_effect=sqlite3.DatabaseError("broken")):
                with self.assertRaisesRegex(ValueError, "cannot read"):
                    self.up.load_exclude_db(f"{path}:agents.agent_address")

    def test_identifier_trailing_newlines_rejected(self):
        for suffix in ("agents\n.agent_address", "agents.agent_address\n"):
            with self.assertRaisesRegex(ValueError, "invalid table/column"):
                self.up._parse_exclude_db_spec("/tmp/x:" + suffix)

    def test_missing_defaults_skip_but_explicit_db_is_strict(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"HOME": tmp}), \
             patch.object(self.up, "_scan_base", return_value=({}, {})):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                self.up.main(["--chain", "base", "--vps-own-wallets", "--json"], env={})
            self.assertEqual(err.getvalue().count("loaded 0 exclusion address(es)"), 2)
            with self.assertRaisesRegex(SystemExit, "database file not found"):
                self.up.main(["--chain", "base", "--exclude-db", f"{tmp}/missing.db:agents.agent_address"], env={})

    def test_filtered_errors_propagate_and_text_details_appear_once_per_report(self):
        transfers = {MERCHANT: [{"from": PAYER_A, "amount": Decimal("1"), "timestamp": None}]}
        with patch.object(self.up, "_scan_base", return_value=(transfers, {MERCHANT: "HTTP 403"})):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                self.up.main(["--chain", "base", "--amount-filter-atomic", "1000000", "--json", "--list"], env={})
        report = json.loads(out.getvalue())
        self.assertEqual(report["filtered"]["errors"], {MERCHANT: "HTTP 403"})
        self.assertEqual(report["chains"]["base"]["filtered"]["errors"], {MERCHANT: "HTTP 403"})
        text = self.up.text_summary(report)
        self.assertEqual(text.count("HTTP 403"), 2)  # once in each filtered/unfiltered report
        self.assertEqual(text.count(PAYER_A), 2)


if __name__ == "__main__":
    unittest.main()

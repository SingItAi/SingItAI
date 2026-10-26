import datetime
import importlib.util
import io
import json
import sys
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
        self.assertEqual(exclude, frozenset({MERCHANT.lower(), PAYER_A.lower(), PAYER_B.lower()}))


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

    def _run(self, argv, *, http_get, env=None):
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



if __name__ == "__main__":
    unittest.main()

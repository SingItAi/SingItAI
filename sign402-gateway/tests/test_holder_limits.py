"""SINGIT-holder daily limits: fail-closed effective balance and the raised caps (fake RPC, no network)."""
import os
import unittest
from unittest.mock import patch

from sign402_gateway import holder_limits
from sign402_gateway.base_balances import (
    DEFAULT_HOLDER_TIERS,
    BaseBalanceError,
    HolderBalanceReader,
    parse_holder_tiers,
)
from sign402_gateway.web_api_keys import MAX_DAILY_ATOMIC, ApiKeys
from test_api_keys import Fixture

HOLDER = "0x" + "a1" * 20
OTHER = "0x" + "b2" * 20
WEI = 10**18
NOW = 1_800_000_000
LATEST = 30_000_000


class FakeRpc:
    """current/past: lowercase address -> whole tokens."""

    def __init__(self, current=None, past=None, fail=False, no_history=False):
        self.current, self.past = current or {}, past or {}
        self.fail, self.no_history = fail, no_history
        self.calls = []

    def call(self, method, params):
        self.calls.append(method)
        if self.fail:
            raise BaseBalanceError("Base RPC is unavailable")
        if method == "eth_blockNumber":
            return hex(LATEST)
        if method == "eth_getBlockByNumber":
            return {"timestamp": hex(NOW - (LATEST - int(params[0], 16)) * 2)}
        assert method == "eth_call"
        address = "0x" + params[0]["data"][-40:]
        if params[1] != "latest" and self.no_history:
            raise BaseBalanceError("Base RPC request failed")
        table = self.current if params[1] == "latest" else self.past
        return hex(table.get(address.lower(), 0) * WEI)


def reader(rpc, **kwargs):
    return HolderBalanceReader(rpc=rpc, clock=lambda: NOW, **kwargs)


class ReaderTests(unittest.TestCase):
    def test_effective_balance_is_the_lower_of_now_and_a_day_ago(self):
        for current, past, expected in [(200, 200, 200), (200, 5, 5), (5, 200, 5)]:
            rpc = FakeRpc({HOLDER: current}, {HOLDER: past})
            self.assertEqual(reader(rpc).effective_balance(HOLDER), expected * WEI)

    def test_the_old_block_is_about_a_day_back_and_not_younger(self):
        blocks = []
        rpc = FakeRpc({HOLDER: 1}, {HOLDER: 1})
        original = rpc.call

        def spy(method, params):
            if method == "eth_call" and params[1] != "latest":
                blocks.append(int(params[1], 16))
            return original(method, params)

        rpc.call = spy
        reader(rpc).effective_balance(HOLDER)
        age = (LATEST - blocks[0]) * 2
        self.assertTrue(86_400 <= age < 86_400 + 600, age)

    def test_failures_mean_unknown_never_an_exception(self):
        self.assertIsNone(reader(FakeRpc({HOLDER: 9}, {HOLDER: 9}, fail=True)).effective_balance(HOLDER))
        self.assertIsNone(reader(FakeRpc({HOLDER: 9}, {HOLDER: 9}, no_history=True)).effective_balance(HOLDER))
        for bad in ["", "0x12", None, "not an address", 7]:
            self.assertIsNone(reader(FakeRpc()).effective_balance(bad))

    def test_results_and_failures_are_cached_and_the_cache_is_bounded(self):
        now = [NOW]
        rpc = FakeRpc({HOLDER: 9}, {HOLDER: 9})
        r = HolderBalanceReader(rpc=rpc, clock=lambda: now[0], max_entries=2)
        r.effective_balance(HOLDER), r.effective_balance(HOLDER)
        self.assertEqual(rpc.calls.count("eth_blockNumber"), 1)
        self.assertEqual(rpc.calls.count("eth_call"), 2)
        for i in range(5):
            r.effective_balance("0x" + str(i) * 40)
        self.assertLessEqual(len(r._cache), 2)
        down = FakeRpc(fail=True)
        r2 = HolderBalanceReader(rpc=down, clock=lambda: now[0])
        for _ in range(4):
            r2.effective_balance(HOLDER)
        self.assertEqual(len(down.calls), 1, "a failure is not retried at once")

    def test_holds_at_least_whole_tokens(self):
        r = reader(FakeRpc({HOLDER: 150_000_000}, {HOLDER: 150_000_000}))
        self.assertTrue(r.holds_at_least(HOLDER, 150_000_000))
        self.assertFalse(r.holds_at_least(HOLDER, 150_000_001))
        self.assertFalse(r.holds_at_least(OTHER, 1))


class TierTests(unittest.TestCase):
    def test_defaults_and_the_daily_flag(self):
        self.assertEqual(parse_holder_tiers(DEFAULT_HOLDER_TIERS),
                         [(20_000_000, 500, False), (50_000_000, 1000, False), (150_000_000, 1500, True)])
        self.assertEqual(holder_limits.top_tier_min_tokens({}), 150_000_000)
        self.assertEqual(holder_limits.top_tier_min_tokens({"SINGIT_ASK_HOLDER_TIERS": "10:100,90:900+daily"}), 90)
        self.assertEqual(holder_limits.top_tier_min_tokens({"SIGN402_HOLDER_TIERS": "10:100,90:900+daily",
                                                           "SINGIT_ASK_HOLDER_TIERS": "5:50+daily"}), 90)
        self.assertIsNone(holder_limits.top_tier_min_tokens({"SINGIT_ASK_HOLDER_TIERS": "10:100"}))

    def test_bad_tiers_fall_back_to_the_defaults(self):
        for bad in ["abc", "10:0", "10:10000", "10:5,10:6", "10:900,20:100"]:
            with self.assertRaises(ValueError):
                parse_holder_tiers(bad)
            self.assertEqual(holder_limits.top_tier_min_tokens({"SINGIT_ASK_HOLDER_TIERS": bad}), 150_000_000)


class LimitTests(unittest.TestCase):
    def tearDown(self):
        holder_limits.set_holder_reader(None)

    def install(self, **rpc):
        holder_limits.set_holder_reader(reader(FakeRpc(**rpc)))

    def test_a_top_tier_holder_gets_twice_the_cap_by_default_and_env_overrides(self):
        self.install(current={HOLDER: 150_000_000}, past={HOLDER: 150_000_000})
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SIGN402_HOLDER_TOP_MAX_DAILY_ATOMIC", None)
            self.assertEqual(holder_limits.raised_max_daily_atomic(HOLDER, 1_000), 2_000)
            os.environ["SIGN402_HOLDER_TOP_MAX_DAILY_ATOMIC"] = "7000"
            self.assertEqual(holder_limits.raised_max_daily_atomic(HOLDER, 1_000), 7_000)
            os.environ["SIGN402_HOLDER_TOP_MAX_DAILY_ATOMIC"] = "10"
            self.assertEqual(holder_limits.raised_max_daily_atomic(HOLDER, 1_000), 1_000, "never lower than standard")
            os.environ["SIGN402_HOLDER_TOP_MAX_DAILY_ATOMIC"] = "junk"
            self.assertEqual(holder_limits.raised_max_daily_atomic(HOLDER, 1_000), 2_000)

    def test_not_a_holder_or_not_the_top_tier_or_unknown_keeps_the_standard_cap(self):
        self.install(current={HOLDER: 100_000_000}, past={HOLDER: 100_000_000})
        self.assertEqual(holder_limits.raised_max_daily_atomic(HOLDER, 1_000), 1_000)
        self.install(current={HOLDER: 200_000_000}, past={HOLDER: 1})
        self.assertEqual(holder_limits.raised_max_daily_atomic(HOLDER, 1_000), 1_000, "a day-old balance counts")
        self.install(current={HOLDER: 200_000_000}, past={HOLDER: 200_000_000}, fail=True)
        self.assertEqual(holder_limits.raised_max_daily_atomic(HOLDER, 1_000), 1_000)
        holder_limits.set_holder_reader(None)
        self.assertEqual(holder_limits.raised_max_daily_atomic(HOLDER, 1_000), 1_000)

    def test_the_operator_ceiling_is_raised_only_when_there_is_one(self):
        self.install(current={HOLDER: 150_000_000}, past={HOLDER: 150_000_000})
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SIGN402_HOLDER_TOP_CEILING_DAILY_ATOMIC", None)
            self.assertEqual(holder_limits.raised_ceiling_daily_atomic(HOLDER, 5_000), 10_000)
            self.assertIsNone(holder_limits.raised_ceiling_daily_atomic(HOLDER, None))
            self.assertEqual(holder_limits.raised_ceiling_daily_atomic(OTHER, 5_000), 5_000)
            os.environ["SIGN402_HOLDER_TOP_CEILING_DAILY_ATOMIC"] = "8000"
            self.assertEqual(holder_limits.raised_ceiling_daily_atomic(HOLDER, 5_000), 8_000)

    def test_no_tier_marked_daily_means_nothing_is_raised(self):
        holder_limits.set_holder_reader(reader(FakeRpc({HOLDER: 10**9}, {HOLDER: 10**9})), top_min_tokens=None)
        self.assertEqual(holder_limits.raised_max_daily_atomic(HOLDER, 1_000), 1_000)

    def test_api_keys_use_the_raised_cap_for_the_owner(self):
        self.install(current={HOLDER: 150_000_000}, past={HOLDER: 150_000_000})
        self.assertEqual(ApiKeys._max_daily_atomic(HOLDER), MAX_DAILY_ATOMIC * 2)
        self.assertEqual(ApiKeys._max_daily_atomic(OTHER), MAX_DAILY_ATOMIC)

    def test_a_spending_limit_key_resolves_to_a_base_address(self):
        class Store:
            def get_wallet_by_telegram_user_id(self, user_id, chain="base"):
                return {"wallet_address": HOLDER} if user_id == "42" else None

        server = type("S", (), {"user_wallet_service": type("W", (), {"store": Store()})()})()
        self.assertEqual(holder_limits.base_address_of(server, "wallet:" + HOLDER), HOLDER)
        self.assertEqual(holder_limits.base_address_of(server, HOLDER), HOLDER)
        self.assertEqual(holder_limits.base_address_of(server, "42"), HOLDER)
        self.assertIsNone(holder_limits.base_address_of(server, "7"))
        self.assertIsNone(holder_limits.base_address_of(object(), "7"))


class GatewayWiringTests(unittest.TestCase):
    def tearDown(self):
        holder_limits.set_holder_reader(None)

    def test_the_wallet_ceiling_for_a_user_is_raised_for_a_top_holder_only(self):
        from sign402_gateway import server as gw

        class Store:
            def get_wallet_by_telegram_user_id(self, user_id, chain="base"):
                return {"wallet_address": {"1": HOLDER, "2": OTHER}.get(user_id)}

        server = type("S", (), {"user_wallet_service": type("W", (), {"store": Store()})()})()
        holder_limits.set_holder_reader(reader(FakeRpc({HOLDER: 150_000_000}, {HOLDER: 150_000_000})))
        env = {"SIGN402_USER_WALLET_CEILING_DAILY_ATOMIC": "5000000000"}
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("SIGN402_HOLDER_TOP_CEILING_DAILY_ATOMIC", None)
            self.assertEqual(gw._operator_user_wallet_ceilings_for(server, "1")["ceilingDailyAtomic"], 10_000_000_000)
            self.assertEqual(gw._operator_user_wallet_ceilings_for(server, "2")["ceilingDailyAtomic"], 5_000_000_000)
            self.assertEqual(gw._operator_user_wallet_ceilings_for(server, "wallet:" + HOLDER)["ceilingDailyAtomic"], 10_000_000_000)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SIGN402_USER_WALLET_CEILING_DAILY_ATOMIC", None)
            self.assertIsNone(gw._operator_user_wallet_ceilings_for(server, "1")["ceilingDailyAtomic"], "no ceiling stays none")


class KeyCapTests(Fixture):
    def tearDown(self):
        holder_limits.set_holder_reader(None)

    def test_a_key_may_exceed_the_standard_cap_only_for_a_top_holder(self):
        terms = {"dailyUsd": 1500, "perRequestUsd": 1}
        with self.assertRaises(ValueError):
            self.call("POST", "/api-keys/prepare", {"name": "my bot", **terms})
        owner = self.user.address.lower()
        holder_limits.set_holder_reader(reader(FakeRpc({owner: 150_000_000}, {owner: 150_000_000})))
        status, prepared, _ = self.call("POST", "/api-keys/prepare", {"name": "my bot", **terms})
        self.assertEqual(status, 200)
        self.assertIn("1500", prepared["message"])
        with self.assertRaises(ValueError):
            self.call("POST", "/api-keys/prepare", {"name": "my bot", "dailyUsd": 2500, "perRequestUsd": 1})


if __name__ == "__main__":
    unittest.main()

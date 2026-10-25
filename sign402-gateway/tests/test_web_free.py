"""Free models on the API-key /v1 (web_free.py): "free/<id>" answered at no charge within account, network and
daily limits that are separate from the paid ones. Offline: a fake upstream stands for Surplus."""
import io
import json
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock

from eth_account import Account

from sign402_gateway import web_api as wa
from sign402_gateway import web_free
from sign402_gateway.web_api_keys import ApiError
from tests.test_api_keys import URI, Fixture, sign

FREE_BODY = {"model": "free/deepseek-v4.1-flash", "messages": [{"role": "user", "content": "Hello!"}], "max_tokens": 1000}
UPSTREAM_ANSWER = {"choices": [{"message": {"role": "assistant", "content": "Hi there"}, "finish_reason": "stop"}],
                   "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7, "buyer_cost_micro": 3}}


class Response(io.BytesIO):
    def __init__(self, status, data):
        super().__init__(json.dumps(data).encode())
        self.status = status


class Upstream:
    def __init__(self, *replies):
        self.sent, self.replies = [], list(replies) or [(200, UPSTREAM_ANSWER)]

    def send(self, path, body, headers):
        self.sent.append((path, body, headers))
        status, data = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        return Response(status, data)


class NetworkTests(unittest.TestCase):
    def test_an_ipv4_24_and_an_ipv6_64_are_one_network(self):
        self.assertEqual(web_free.network_of("203.0.113.7"), "203.0.113.0/24")
        self.assertEqual(web_free.network_of("203.0.113.250"), web_free.network_of("203.0.113.7"))
        self.assertNotEqual(web_free.network_of("203.0.114.7"), web_free.network_of("203.0.113.7"))
        self.assertEqual(web_free.network_of("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64")
        self.assertEqual(web_free.network_of("2001:db8:1:2::1"), web_free.network_of("2001:DB8:1:2:ffff::9"))
        self.assertNotEqual(web_free.network_of("2001:db8:1:3::1"), web_free.network_of("2001:db8:1:2::1"))
        self.assertEqual(web_free.network_of("2001:db8::1"), "2001:db8:0:0::/64")

    def test_an_ipv4_mapped_ipv6_address_is_its_ipv4_network(self):
        self.assertEqual(web_free.network_of("::ffff:203.0.113.7"), "203.0.113.0/24")
        self.assertEqual(web_free.network_of("::ffff:cb00:7107"), "203.0.113.0/24")

    def test_odd_input_stays_in_one_bucket_each(self):
        self.assertEqual(web_free.network_of(""), "unknown")
        self.assertEqual(web_free.network_of(None), "unknown")
        self.assertEqual(web_free.network_of("not-an-ip"), "not-an-ip")
        self.assertEqual(web_free.network_of("[2001:db8:1:2::5]"), "2001:db8:1:2::/64")


class FreeFixture(Fixture):
    def setUp(self):
        super().setUp()
        self.upstream = Upstream()
        self.free = web_free.FreeModels(["deepseek-v4.1-flash"], self.upstream, per_account=3, per_network=4, per_day=5,
                                        now=lambda: self.clock[0])
        self.api.keys.free = self.free
        self.made = self.make_key(dailyUsd=1, perRequestUsd=0.2)
        self.key = self.made["key"]

    def free_ask(self, body=None, client="203.0.113.7", key=None):
        return self.api.keys.public("POST", "/chat/completions", authorization=f"Bearer {key or self.key}", origin=None,
                                    body=body or FREE_BODY, client=client)


class FreeAnswerTests(FreeFixture):
    def test_a_free_answer_costs_nothing_and_touches_no_paid_limit(self):
        status, out, headers = self.free_ask()
        self.assertEqual(status, 200)
        self.assertEqual(out["choices"][0]["message"], {"role": "assistant", "content": "Hi there"})
        self.assertEqual(out["model"], "free/deepseek-v4.1-flash")
        self.assertEqual(out["billing"], {"free": True, "chargedAtomic": 0, "paidFrom": "nothing: free answer"})
        self.assertEqual((headers["X-SingIt-Free"], headers["X-SingIt-Free-Remaining"]), ("true", "2"))
        self.assertEqual(self.shop.calls, [], "no purchase, no balance, no limiter is asked")
        _, listed, _ = self.call("GET", "/api-keys")
        self.assertEqual((listed["keys"][0]["spentTodayUsd"], listed["keys"][0]["answersToday"]), (0.0, 0))
        self.assertEqual(dict(self.api.keys._reserved), {})

    def test_free_answers_do_not_use_up_the_keys_requests_per_minute(self):
        free = web_free.FreeModels(["deepseek-v4.1-flash"], self.upstream, per_account=500, per_network=500,
                                   per_day=500, now=lambda: self.clock[0])
        self.api.keys.free = free
        for _ in range(100):
            self.free_ask()
        self.assertEqual(self.ask(self.key)[0], 200, "a paid answer still has all 60 of its minute")
        for _ in range(59):
            self.ask(self.key)
        with self.assertRaises(ApiError) as caught:
            self.ask(self.key)
        self.assertEqual(caught.exception.status, 429, "the paid ones are counted as before")

    def test_the_question_goes_on_unchanged_with_the_answer_clamped(self):
        self.free_ask()
        path, sent, _ = self.upstream.sent[0]
        self.assertEqual(path, "/v1/chat/completions")
        self.assertEqual(sent["model"], "deepseek-v4.1-flash")
        self.assertEqual(sent["messages"], [{"role": "user", "content": "Hello!"}])
        self.assertEqual(sent["max_tokens"], 400)
        self.free_ask({**FREE_BODY, "max_tokens": 50})
        self.assertEqual(self.upstream.sent[1][1]["max_tokens"], 50)

    def test_streaming_clients_get_the_whole_answer_as_chunks(self):
        status, out, headers = self.free_ask({**FREE_BODY, "stream": True})
        self.assertEqual((status, type(out).__name__, headers["X-SingIt-Free"]), (200, "Stream", "true"))
        self.assertTrue(out.decode().endswith("data: [DONE]\n\n"))

    def test_other_models_tools_and_long_questions_are_refused_before_asking(self):
        cases = {
            "another model": ({**FREE_BODY, "model": "free/claude-opus-5.5"}, 404),
            "tools": ({**FREE_BODY, "tools": [{}]}, 400),
            "no messages": ({"model": FREE_BODY["model"]}, 400),
            "too long": ({**FREE_BODY, "messages": [{"role": "user", "content": "x" * 4_001}]}, 400),
        }
        for name, (body, status) in cases.items():
            with self.subTest(name), self.assertRaises(ApiError) as caught:
                self.free_ask(body)
            self.assertEqual(caught.exception.status, status)
        self.assertEqual(self.upstream.sent, [])
        self.assertEqual(self.free._total, 0, "a refusal is not counted")


class FreeLimitTests(FreeFixture):
    def test_an_account_gets_a_few_a_day_whatever_key_or_network(self):
        for n in range(3):
            self.free_ask(client=f"198.51.{n}.1")
        with self.assertRaises(ApiError) as caught:
            self.free_ask(client="192.0.2.1")
        error = caught.exception
        self.assertEqual((error.status, error.type, error.code), (429, "rate_limit_error", "free_limit_reached"))
        self.assertIn("this account", error.message)
        self.assertGreater(error.retry_after, 0)
        other_key = self.make_key()["key"]
        with self.assertRaises(ApiError):
            self.free_ask(key=other_key, client="192.0.2.9")
        self.clock[0] += 86400
        self.assertEqual(self.free_ask()[0], 200, "a new UTC day")

    def test_a_network_gets_a_few_a_day_across_accounts_and_rotating_addresses(self):
        keys = [self.key, self.make_key(signer=self._signer())["key"]]
        # two accounts, one network: each is under its own limit (3) but together they reach the network's (4)
        for n, key in enumerate([keys[0], keys[0], keys[1], keys[1]]):
            self.free_ask(key=key, client=f"198.51.100.{10 + n}")
        with self.assertRaises(ApiError) as caught:
            self.free_ask(key=keys[1], client="198.51.100.200")
        self.assertIn("this network", caught.exception.message)
        self.assertEqual(self.free_ask(key=keys[1], client="198.51.101.1")[0], 200, "the next /24")
        with self.assertRaises(ApiError):
            self.free_ask(key=keys[1], client="::ffff:198.51.100.7")

    def _signer(self):
        # a second wallet: make_key calls the account API with self.session, so switch to the new one
        signer = Account.create()
        issued = self.auth.nonce(signer.address)
        self.session = self.auth.verify(issued["message"], sign(signer, issued["message"]))
        return signer

    def test_everyone_together_has_a_daily_ceiling(self):
        free = web_free.FreeModels(["deepseek-v4.1-flash"], self.upstream, per_account=50, per_network=50, per_day=2,
                                   now=lambda: self.clock[0])
        self.api.keys.free = free
        self.free_ask(client="198.51.1.1")
        self.free_ask(client="198.51.2.1")
        with self.assertRaises(ApiError) as caught:
            self.free_ask(client="198.51.3.1")
        self.assertIn("used up", caught.exception.message)

    def test_an_answer_that_does_not_come_back_is_not_counted(self):
        self.upstream.replies = [(500, {"error": "down"}), (200, UPSTREAM_ANSWER)]
        with self.assertRaises(ApiError) as caught:
            self.free_ask()
        self.assertEqual(caught.exception.status, 502)
        status, _, headers = self.free_ask()
        self.assertEqual((status, headers["X-SingIt-Free-Remaining"]), (200, "2"))

    def test_a_seller_that_insists_on_thinking_is_asked_once_more_with_less(self):
        self.upstream.replies = [(400, {"error": {"code": "request_rejected", "message": "Reasoning is mandatory"}}),
                                 (200, UPSTREAM_ANSWER)]
        self.assertEqual(self.free_ask()[0], 200)
        self.assertEqual([s[1]["reasoning_effort"] for s in self.upstream.sent], ["none", "low"])


class FreeListingTests(FreeFixture):
    def test_models_lists_the_free_ones_beside_the_paid_ones(self):
        _, out, _ = self.api.keys.public("GET", "/models", authorization=f"Bearer {self.key}", origin=None, body={})
        self.assertEqual(out["data"][0], {"id": "free/deepseek-v4.1-flash", "object": "model", "owned_by": "singit",
                                          "free": True, "limits": {"perAccountPerDay": 3, "perNetworkPerDay": 4,
                                                                   "maxTokens": 400, "maxChars": 4000}})
        self.assertEqual(out["data"][1]["id"], "claude-opus-5.5")
        self.assertNotIn("free", out["data"][1])


class OffByDefaultTests(Fixture):
    def test_nothing_is_free_unless_configured(self):
        self.assertIsNone(self.api.keys.free)
        key = self.make_key()["key"]
        self.ask(key, {"model": "free/deepseek-v4.1-flash", "messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual(self.shop.calls[-1][0], "api-chat", "a free/ model is just an unknown paid model: bought, not free")
        _, out, _ = self.api.keys.public("GET", "/models", authorization=f"Bearer {key}", origin=None, body={})
        self.assertEqual([m["id"] for m in out["data"]], ["claude-opus-5.5"])

    def _build(self, env):
        base = {"SIGN402_WEB_DOMAIN": "app.singit.test", "SIGN402_WEB_URI": URI, "SIGN402_WEB_ALLOWED_ADDRESSES": "*",
                "SIGN402_WEB_DB": str(self.store.path), "SIGN402_WEB_INTERNAL_TOKEN": "t" * 40,
                "SIGN402_WEB_SURPLUS_API_KEY": "inf_test", "SIGN402_WEB_CHAT_ENABLED": "0", **env}
        api, _ = wa.build_web_api_from_env(Mock(), env=base)
        return api

    def test_the_environment_turns_it_on_with_its_defaults(self):
        self.assertIsNone(self._build({}).keys.free)
        self.assertIsNone(self._build({"SIGN402_WEB_FREE_MODELS": " "}).keys.free)
        free = self._build({"SIGN402_WEB_FREE_MODELS": "deepseek-v4.1-flash, qwen3.7-flash"}).keys.free
        self.assertEqual(free.models, ["deepseek-v4.1-flash", "qwen3.7-flash"])
        self.assertEqual((free.per_account, free.per_network, free.per_day, free.max_tokens), (20, 40, 1000, 400))
        tuned = self._build({"SIGN402_WEB_FREE_MODELS": "m", "SIGN402_WEB_FREE_PER_ACCOUNT_PER_DAY": "5",
                             "SIGN402_WEB_FREE_PER_NETWORK_PER_DAY": "6", "SIGN402_WEB_FREE_PER_DAY": "7",
                             "SIGN402_WEB_FREE_MAX_TOKENS": "100"}).keys.free
        self.assertEqual((tuned.per_account, tuned.per_network, tuned.per_day, tuned.max_tokens), (5, 6, 7, 100))
        with self.assertRaises(ValueError):
            self._build({"SIGN402_WEB_FREE_MODELS": "m", "SIGN402_WEB_FREE_PER_DAY": "0"})

    def test_without_a_surplus_key_free_models_stay_off(self):
        api = self._build({"SIGN402_WEB_FREE_MODELS": "m", "SIGN402_WEB_SURPLUS_API_KEY": ""})
        self.assertIsNone(api.keys.free)


class FreeHttpTests(FreeFixture):
    def setUp(self):
        super().setUp()
        self.server = wa.WebServer(("127.0.0.1", 0), self.api, URI)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def post(self, body, headers=None):
        request = urllib.request.Request(self.base + "/chat/completions", data=json.dumps(body).encode(), headers={
            "Authorization": f"Bearer {self.key}", "Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.headers, json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.headers, json.loads(error.read())

    def test_the_limit_answers_429_with_retry_after_and_the_client_is_the_cloudflare_address(self):
        for _ in range(3):
            status, headers, _ = self.post(FREE_BODY, {"Cf-Connecting-Ip": "203.0.113.5"})
            self.assertEqual((status, headers["X-SingIt-Free"]), (200, "true"))
        status, headers, out = self.post(FREE_BODY, {"Cf-Connecting-Ip": "203.0.113.5"})
        self.assertEqual((status, out["error"]["code"]), (429, "free_limit_reached"))
        self.assertGreater(int(headers["Retry-After"]), 0)

    def test_the_network_limit_follows_the_client_address_not_the_proxy(self):
        other = self.make_key()["key"]
        self.free.per_account = 50
        for n in range(4):  # one /24, addresses rotating, two keys of two accounts' worth
            self.post(FREE_BODY, {"Cf-Connecting-Ip": f"203.0.113.{n + 1}"})
        status, _, out = self.post(FREE_BODY, {"Cf-Connecting-Ip": "203.0.113.99"})
        self.assertEqual((status, out["error"]["code"]), (429, "free_limit_reached"))
        self.assertEqual(self.post(FREE_BODY, {"Cf-Connecting-Ip": "203.0.114.1"})[0], 200)
        self.assertTrue(other)


if __name__ == "__main__":
    unittest.main()

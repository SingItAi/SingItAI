"""The SingIt balance: topped up from the owner's limits, spent by API keys at actual cost + 30%, never past the hold.

Offline: a fake Surplus answers, a fake shop stands for the gateway's top-up, and the gateway side runs with its
payer mocked.
"""
import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from eth_account import Account

from sign402_gateway import web_api as wa
from sign402_gateway import web_api_proxy, web_balance, web_internal
from sign402_gateway import web_api_keys as web_api_keys_module
from sign402_gateway.agent_allowance import AllowanceError, AllowanceUnavailable
from sign402_gateway.web_api_proxy import Proxy, charge_for, surplus_model
from sign402_gateway.web_balance import Balances, TopupBusy, new_topup_id
from sign402_gateway.web_api_keys import ApiError

from test_api_keys import NOW, URI, Fixture

ACCOUNT = "wallet:0x1111111111111111111111111111111111111111"
OPUS = {"id": "claude-opus-5.5", "label": "Opus", "provider": "anthropic", "input": 5.0, "output": 25.0}


class Headers(dict):
    def get(self, name, default=None):
        return super().get(name.lower(), default)


class Response:
    def __init__(self, status, body, headers=None):
        self.status = status
        self.headers = Headers({k.lower(): v for k, v in (headers or {}).items()})
        self._body = io.BytesIO(body if isinstance(body, bytes) else json.dumps(body).encode())
        self.closed = False

    def read(self, limit=-1):
        return self._body.read(limit)

    def readline(self):
        return self._body.readline()

    def close(self):
        self.closed = True


def sse(*events):
    return b"".join(b"data: " + (e if isinstance(e, bytes) else json.dumps(e).encode()) + b"\n\n" for e in events)


class Surplus:
    """Records each request; answers with what the test queued."""

    def __init__(self):
        self.sent, self.replies = [], []

    def send_raw(self, path, data, content_type):
        self.sent.append((path, data, {"Content-Type": content_type}))
        reply = self.replies.pop(0)
        return reply() if callable(reply) else reply

    def send(self, path, body, headers):
        self.sent.append((path, json.loads(json.dumps(body)), dict(headers)))
        reply = self.replies.pop(0) if self.replies else Response(200, {
            "id": "c1", "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant",
                                                                                         "content": "Hi"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 2, "buyer_cost_micro": 1000}}, {"x-request-id": "req_1"})
        return reply() if callable(reply) else reply


class BalanceStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.balances = Balances(Path(self.tmp.name) / "web.db")

    def credit(self, amount, account=ACCOUNT):
        topup = new_topup_id()
        self.balances.claim_topup(topup, account, amount, NOW)
        return self.balances.credit_topup(topup, amount + 1000, amount, "0xtx", "base", NOW)

    def test_a_hold_takes_only_what_is_free_and_a_charge_lets_it_go(self):
        self.assertEqual(self.credit(5_000_000), 5_000_000)
        self.assertTrue(self.balances.hold(ACCOUNT, "h1", 3_000_000, NOW))
        self.assertFalse(self.balances.hold(ACCOUNT, "h2", 3_000_000, NOW))
        self.assertEqual(self.balances.state(ACCOUNT)["availableAtomic"], 2_000_000)
        self.assertEqual(self.balances.charge(ACCOUNT, "h1", 1300, NOW, key_id="key_1", model="m", cost=1000), 4_998_700)
        state = self.balances.state(ACCOUNT)
        self.assertEqual((state["balanceAtomic"], state["heldAtomic"]), (4_998_700, 0))
        self.balances.hold(ACCOUNT, "h3", 1_000, NOW)
        self.balances.release("h3")
        self.assertEqual(self.balances.state(ACCOUNT)["heldAtomic"], 0)

    def test_a_charge_cannot_pass_its_hold_or_bill_without_one(self):
        self.credit(1_000_000)
        self.balances.hold(ACCOUNT, "h1", 1_000, NOW)
        with self.assertLogs("sign402_gateway.web_balance", "WARNING"):
            self.assertEqual(self.balances.charge(ACCOUNT, "h1", 1_500_000, NOW, cost=1_500_000), 999_000)
        state = self.balances.state(ACCOUNT)
        self.assertEqual((state["balanceAtomic"], state["heldAtomic"]), (999_000, 0))
        self.assertEqual(self.balances.ledger(ACCOUNT)[0]["amount_atomic"], -1_000)
        self.assertEqual(self.balances.charge(ACCOUNT, "h1", 1_500_000, NOW), 999_000)
        self.assertEqual(len(self.balances.ledger(ACCOUNT)), 2)  # the missed hold adds no second charge

    def test_a_new_account_tops_up_a_dollar_at_a_time_below_thirty_cents_when_turned_on(self):
        state = self.balances.state(ACCOUNT)
        self.assertEqual((state["topupAtomic"], state["thresholdAtomic"], state["autoTopup"]), (1_000_000, 300_000, False))

    def test_a_forgotten_hold_is_let_go(self):
        self.credit(1_000_000)
        self.balances.hold(ACCOUNT, "h1", 1_000_000, NOW)
        self.assertTrue(self.balances.hold(ACCOUNT, "h2", 1_000_000, NOW + web_balance.HOLD_SECONDS + 1))

    def test_a_hold_still_being_read_is_not_let_go(self):
        self.credit(1_000_000)
        self.balances.hold(ACCOUNT, "h1", 1_000_000, NOW)
        self.assertTrue(self.balances.touch("h1", NOW + web_balance.HOLD_SECONDS))
        self.assertFalse(self.balances.hold(ACCOUNT, "h2", 1, NOW + web_balance.HOLD_SECONDS + 1))
        self.assertEqual(self.balances.state(ACCOUNT)["heldAtomic"], 1_000_000)

    def test_a_watch_stops_when_the_answer_outlives_its_deadline(self):
        self.credit(1)
        self.balances.hold(ACCOUNT, "h1", 1, NOW)
        clock = [0.0]
        watch = web_api_proxy.HoldWatch(self.balances, "h1", lambda: NOW + 10, deadline=100, clock=lambda: clock[0])
        watch.keep()
        self.assertFalse(watch.stopped)
        clock[0] = 100
        watch.keep()
        self.assertTrue(watch.stopped)
        self.assertFalse(self.balances.hold(ACCOUNT, "h2", 1, NOW + 10 + web_balance.HOLD_SECONDS))

    def test_one_top_up_at_a_time_credited_once_and_an_unclear_one_stops_more(self):
        self.balances.claim_topup("top_" + "a" * 24, ACCOUNT, 5_000_000, NOW)
        with self.assertRaises(TopupBusy):
            self.balances.claim_topup("top_" + "b" * 24, ACCOUNT, 5_000_000, NOW)
        self.balances.credit_topup("top_" + "a" * 24, 5_001_000, 5_000_000, "0xtx", "base", NOW)
        with self.assertRaises(AllowanceError):
            self.balances.credit_topup("top_" + "a" * 24, 5_001_000, 5_000_000, "0xtx", "base", NOW)
        with self.assertRaises(TopupBusy):
            self.balances.claim_topup("top_" + "a" * 24, ACCOUNT, 5_000_000, NOW)
        self.balances.claim_topup("top_" + "c" * 24, ACCOUNT, 5_000_000, NOW)
        self.balances.end_topup("top_" + "c" * 24, "uncertain", "TimeoutError", NOW)
        with self.assertRaises(TopupBusy) as caught:
            self.balances.claim_topup("top_" + "d" * 24, ACCOUNT, 5_000_000, NOW)
        self.assertIn("unclear", str(caught.exception))
        self.assertEqual(self.balances.state(ACCOUNT)["balanceAtomic"], 5_000_000)

    def test_a_refund_request_freezes_the_balance_until_it_is_recorded(self):
        self.credit(5_000_000)
        self.assertTrue(self.balances.request_refund(ACCOUNT, NOW))
        self.assertFalse(self.balances.hold(ACCOUNT, "h1", 1, NOW))
        with self.assertRaises(AllowanceError):
            self.balances.claim_topup(new_topup_id(), ACCOUNT, 1_000_000, NOW)
        self.assertEqual(self.balances.record_refund(ACCOUNT, 5_000_000, "0xback", NOW), 0)
        self.assertEqual([r["kind"] for r in self.balances.ledger(ACCOUNT)], ["refund", "topup"])
        self.assertTrue(self.balances.hold(ACCOUNT, "h1", 0, NOW))

    def test_usage_adds_up_per_day_key_and_model(self):
        self.credit(5_000_000)
        for hold, model in (("h1", "a"), ("h2", "a"), ("h3", "b")):
            self.balances.hold(ACCOUNT, hold, 200, NOW)
            self.balances.charge(ACCOUNT, hold, 130, NOW, key_id="key_1", model=model, cost=100, input_tokens=5,
                                 output_tokens=1)
        rows = {r["model"]: (r["calls"], r["charged_atomic"], r["input_tokens"]) for r in self.balances.usage(ACCOUNT, 0)}
        self.assertEqual(rows, {"a": (2, 260, 10), "b": (1, 130, 5)})


class GatewayTopupTests(unittest.TestCase):
    """The gateway's credit-topup: SingIt credit bought from the account's limits, once."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "web.db"
        self.server = SimpleNamespace(web_accounts=SimpleNamespace(path=self.path),
                                      allowance=SimpleNamespace(lane_for=lambda a: {"per_purchase_cap": 10_000_000},
                                                                owner_lookup=lambda a: "0x1111"))
        self.gw = SimpleNamespace(_purchases_paused=lambda: False)
        self.pay = Mock(side_effect=lambda server, gw, account, tool, method, url, body, **_:
                        (int(body["amountAtomic"]) + 1000, {"object": "credit"}, "0x" + "c" * 64))
        p = patch.object(web_balance.web_data if hasattr(web_balance, "web_data") else __import__(
            "sign402_gateway.web_data", fromlist=["pay_once"]), "pay_once", self.pay)
        p.start()
        self.addCleanup(p.stop)

    def topup(self, account=ACCOUNT, **payload):
        return web_balance.topup(self.server, self.gw, account,
                                 {"topupId": new_topup_id(), "amountAtomic": 5_000_000, **payload}, now=lambda: NOW)

    def test_credit_is_bought_from_the_limits_to_the_revenue_address_and_credited(self):
        from sign402_gateway import ask_metered
        out = self.topup()
        self.assertEqual((out["creditedAtomic"], out["paidAtomic"], out["feeAtomic"], out["network"]),
                         (5_000_000, 5_001_000, 1000, "base"))
        tool, method, url, body = self.pay.call_args.args[3:7]
        self.assertEqual((method, url, body), ("POST", web_balance.CREDIT_URL, {"amountAtomic": "5000000"}))
        self.assertEqual((tool.pay_to["eip155:8453"], tool.cap_atomic), (ask_metered.PAY_TO, 5_001_000))
        self.assertEqual(Balances(self.path).state(ACCOUNT)["balanceAtomic"], 5_000_000)

    def test_the_portion_shrinks_to_the_per_purchase_limit_but_not_below_what_is_needed(self):
        self.server.allowance.lane_for = lambda a: {"per_purchase_cap": 2_000_000}
        self.assertEqual(self.topup()["creditedAtomic"], 1_990_000)
        with self.assertRaises(AllowanceError) as caught:
            self.topup(minAtomic=3_000_000)
        self.assertIn("per-purchase limit", str(caught.exception))
        self.server.allowance.lane_for = lambda a: None
        with self.assertRaises(AllowanceUnavailable):
            self.topup()
        self.assertEqual(self.pay.call_count, 1)

    def test_a_refusal_ends_the_top_up_and_an_unclear_end_stops_the_next(self):
        self.pay.side_effect = AllowanceError("The seller asks more than its usual price. Nothing was paid.")
        with self.assertRaises(AllowanceError):
            self.topup()
        self.pay.side_effect = TimeoutError()
        with self.assertRaises(AllowanceError) as caught:
            self.topup()
        self.assertIn("unclear", str(caught.exception))
        self.pay.side_effect = None
        self.pay.return_value = (5_001_000, {}, "0x")
        with self.assertRaises(TopupBusy):
            self.topup()
        self.assertEqual(Balances(self.path).state(ACCOUNT)["balanceAtomic"], 0)

    def test_what_is_refused_before_paying(self):
        from sign402_gateway import ask_solana
        for payload in ({"topupId": "x"}, {"amountAtomic": 999_999}, {"amountAtomic": 60_000_000},
                        {"amountAtomic": "5000000"}):
            with self.subTest(payload=payload), self.assertRaises(AllowanceError):
                self.topup(**payload)
        with self.assertRaises(AllowanceError) as caught:
            self.topup(account="solana:" + ask_solana.PAY_TO)
        self.assertIn("cannot pay itself", str(caught.exception))
        self.pay.assert_not_called()

    def test_the_internal_action_is_a_paying_one(self):
        self.assertIn("credit-topup", web_internal.PAYING_ACTIONS)
        with patch.object(web_internal, "_limits_from_limiter") as limits, \
             patch.object(web_balance, "topup", return_value={"ok": True}) as topup:
            status, _ = web_internal.handle(self.server, "credit-topup", {"account": ACCOUNT, "amountAtomic": 1})
        self.assertEqual(status, 200)
        limits.assert_called_once()
        self.assertEqual(topup.call_args.args[2], ACCOUNT)


class ProxyFixture(Fixture):
    def setUp(self):
        super().setUp()
        self.surplus = Surplus()
        self.balances = Balances(Path(self.tmp.name) / "web.db")
        self.api.keys.proxy = Proxy(self.api.keys, self.surplus, self.balances)
        self.topups = []
        real_shop = self.shop

        def shop(action, account, body=None):
            if action != "credit-topup":
                return real_shop(action, account, body)
            self.topups.append(dict(body))
            if getattr(self, "refuse_topup", None):
                return 400, {"ok": False, "error": "refused", "text": self.refuse_topup}
            self.balances.claim_topup(body["topupId"], account, body["amountAtomic"], NOW)
            after = self.balances.credit_topup(body["topupId"], body["amountAtomic"] + 1000, body["amountAtomic"],
                                               "0xtx", "base", NOW)
            return 200, {"ok": True, "creditedAtomic": body["amountAtomic"], "balanceAtomic": after}

        self.api.shop = shop
        for p in (patch.object(web_api_proxy.ask_catalogue, "default_id", return_value="deepseek-v4.1-flash"),
                  patch.object(web_api_proxy.ask_catalogue, "resolve",
                               side_effect=lambda i: OPUS if i == OPUS["id"] else None),
                  patch.object(web_api_proxy, "background", lambda work: work())):
            p.start()
            self.addCleanup(p.stop)
        self.key = self.make_key(dailyUsd=10, perRequestUsd=1)["key"]
        self.balances.set_terms(self.account, 5_000_000, 1_000_000, True, NOW)  # these tests top up on their own

    def send(self, path, body, headers=None):
        status, out, _ = self.api.keys.public("POST", path, authorization=f"Bearer {self.key}", origin=None,
                                              body=body, headers=Headers({k.lower(): v for k, v in (headers or {}).items()}))
        return status, out

    def body_of(self, relay):
        return b"".join(relay)


class ProxyTests(ProxyFixture):
    def test_an_openai_request_is_relayed_and_charged_cost_plus_30_from_a_balance_topped_up_first(self):
        _, relay = self.send("/chat/completions", {"model": "deepseek-v4.1-flash", "tools": [{"type": "function"}],
                                                   "messages": [{"role": "user", "content": "Hi"}]})
        out = json.loads(self.body_of(relay))
        self.assertEqual((relay.status, out["choices"][0]["message"]["content"]), (200, "Hi"))
        self.assertEqual(out["billing"]["chargedAtomic"], 1300)
        self.assertEqual(relay.headers["X-SingIt-Charged-Atomic"], "1300")
        path, sent, _ = self.surplus.sent[0]
        self.assertEqual(path, "/v1/chat/completions")
        self.assertEqual((sent["tools"], sent["si_route"]), ([{"type": "function"}], {"objective": "price"}))
        self.assertEqual([t["amountAtomic"] for t in self.topups], [5_000_000])
        state = self.balances.state(self.account)
        self.assertEqual((state["balanceAtomic"], state["heldAtomic"]), (5_000_000 - 1300, 0))
        line = self.balances.ledger(self.account)[0]
        self.assertEqual((line["kind"], line["model"], line["ref"], line["cost_atomic"]),
                         ("charge", "deepseek-v4.1-flash", "req_1", 1000))
        _, keys, _ = self.call("GET", "/api-keys")
        self.assertEqual(keys["keys"][0]["spentTodayUsd"], 0.0013)
        self.send("/chat/completions", {"messages": [{"role": "user", "content": "Again"}]})
        self.assertEqual(len(self.topups), 1, "a balance that covers the request is not topped up again")
        self.assertEqual(self.surplus.sent[1][1]["model"], "deepseek-v4.1-flash")

    def _credit_one_hold(self):
        self.balances.set_terms(self.account, 5_000_000, 1_000_000, False, NOW)
        topup = new_topup_id()
        self.balances.claim_topup(topup, self.account, 1_000_000, NOW)
        self.balances.credit_topup(topup, 1_001_000, 1_000_000, "0xtx", "base", NOW)

    def test_a_long_answer_keeps_its_hold_past_the_moment_it_would_have_expired(self):
        self._credit_one_hold()
        payload = json.dumps({
            "id": "c1", "object": "chat.completion",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hi"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 2, "buyer_cost_micro": 1000},
        }).encode()
        mono = [1_000.0]

        class Trickle(Response):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.n = 0

            def read(self_, limit=-1):
                self_.n += 1
                if self_.n == 1:
                    # This chunk took almost the hold's whole life. Another spend tries the deposit now.
                    self.clock[0] = NOW + web_balance.HOLD_SECONDS - 1
                    self.early = self.balances.hold(self.account, "other", 1, self.clock[0])
                    mono[0] += web_api_proxy.HOLD_TOUCH_SECONDS  # the next check refreshes the hold
                    return payload[:8]
                if self_.n == 2:
                    # The original hold would be gone by now. The refresh between chunks keeps it.
                    self.clock[0] = NOW + web_balance.HOLD_SECONDS + 30
                    self.late = self.balances.hold(self.account, "other2", 1, self.clock[0])
                    return payload[8:]
                return b""

        self.surplus.replies.append(Trickle(200, b"", {"x-request-id": "req_1"}))
        with patch.object(web_api_proxy.time, "monotonic", lambda: mono[0]):
            _, relay = self.send("/chat/completions", {"messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual(json.loads(self.body_of(relay))["choices"][0]["message"]["content"], "Hi")
        self.assertFalse(self.early)
        self.assertFalse(self.late)
        self.assertEqual(self.balances.ledger(self.account)[0]["amount_atomic"], -1300)
        self.assertEqual(self.balances.state(self.account)["heldAtomic"], 0)

    def test_an_answer_past_its_deadline_stops_instead_of_reading_forever(self):
        self._credit_one_hold()
        clock = [1_000.0]
        reads = []

        class Endless(Response):
            def read(self_, limit=-1):
                reads.append(1)
                clock[0] += web_api_proxy.ANSWER_DEADLINE_SECONDS
                return b"x" * 32

        self.surplus.replies.append(Endless(200, b""))
        with patch.object(web_api_proxy.time, "monotonic", lambda: clock[0]), \
                self.assertLogs("sign402_gateway.web_api_proxy", "WARNING"):
            _, relay = self.send("/chat/completions", {"messages": [{"role": "user", "content": "Hi"}]})
        self.assertLess(len(reads), 5)
        self.assertEqual(self.body_of(relay), b"x" * 32)
        self.assertEqual(self.balances.ledger(self.account)[0]["amount_atomic"], -1_000_000)

    def test_claude_code_speaks_anthropic_with_x_api_key_and_streams_as_it_comes(self):
        events = sse({"type": "message_start", "message": {"usage": {"input_tokens": 12}}},
                     {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hel"}},
                     {"type": "message_delta", "usage": {"output_tokens": 3, "buyer_cost_micro": 20_000}},
                     {"type": "message_stop"})
        self.surplus.replies.append(Response(200, events, {"Content-Type": "text/event-stream"}))
        status, relay, _ = self.api.keys.public(
            "POST", "/messages", authorization=None, origin=None, headers=Headers(
                {"x-api-key": self.key, "anthropic-version": "2023-06-01", "anthropic-beta": "tools-2024"}),
            body={"model": "claude-opus-5-5-20260101", "max_tokens": 1000, "stream": True,
                  "messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual(relay.headers["Content-Type"], "text/event-stream")
        self.assertEqual(self.body_of(relay), events.replace(b', "buyer_cost_micro": 20000', b""))
        path, sent, headers = self.surplus.sent[0]
        self.assertEqual((path, sent["model"]), ("/anthropic/v1/messages", "claude-opus-5.5"))
        self.assertNotIn("si_route", sent)
        self.assertEqual(headers, {"anthropic-version": "2023-06-01", "anthropic-beta": "tools-2024"})
        line = self.balances.ledger(self.account)[0]
        self.assertEqual((-line["amount_atomic"], line["input_tokens"], line["output_tokens"]), (26_000, 12, 3))

    def anthropic_stream_without_cost(self):
        """What Surplus's Anthropic skin streams: usage 0/0 and no cost, with its request id in the headers."""
        events = sse({"type": "message_start", "message": {"usage": {"input_tokens": 0, "output_tokens": 0}}},
                     {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hi"}},
                     {"type": "message_delta", "usage": {"input_tokens": 0, "output_tokens": 0}},
                     {"type": "message_stop"})
        self.surplus.replies.append(Response(200, events, {"Content-Type": "text/event-stream",
                                                           "x-request-id": "req_stream"}))
        _, relay = self.send("/messages", {"model": "claude-opus-5-5", "max_tokens": 1000, "stream": True,
                                           "messages": [{"role": "user", "content": "Hi"}]})
        return relay

    def test_a_stream_without_its_cost_is_charged_what_the_request_log_says(self):
        self.surplus.request_record = Mock(side_effect=[
            None,  # not in the log yet
            {"id": "req_stream", "status": "succeeded",
             "usage": {"input_tokens": 1200, "output_tokens": 40, "buyer_cost_micro": 2_000}}])
        with patch.object(web_api_proxy.time, "sleep") as sleep:
            relay = self.anthropic_stream_without_cost()
            self.assertGreater(self.balances.state(self.account)["heldAtomic"], 0)  # held until the cost is known
            self.body_of(relay)
        self.assertEqual([c.args for c in self.surplus.request_record.call_args_list], [("req_stream",), ("req_stream",)])
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [1, 2])
        line = self.balances.ledger(self.account)[0]
        self.assertEqual((-line["amount_atomic"], line["cost_atomic"], line["input_tokens"], line["output_tokens"]),
                         (charge_for(2_000), 2_000, 1200, 40))
        self.assertEqual(self.balances.state(self.account)["heldAtomic"], 0)

    def test_a_cost_deeper_in_the_record_is_found_and_nothing_else_is_taken_for_one(self):
        self.surplus.request_record = Mock(return_value={"data": {"settlement": {"buyer_cost_micro": "700"},
                                                                  "cost_usd": 5, "price_micro": 9_000}})
        with patch.object(web_api_proxy.time, "sleep"):
            self.body_of(self.anthropic_stream_without_cost())
        self.assertEqual(self.balances.ledger(self.account)[0]["amount_atomic"], -charge_for(700))
        self.assertEqual(self.surplus.request_record.call_count, 1)

    def test_a_stream_whose_cost_never_shows_is_charged_its_hold_and_the_record_shape_is_logged(self):
        self.surplus.request_record = Mock(return_value={"id": "req_stream", "total_usd": 0.002,
                                                         "usage": {"input_tokens": 9}})
        hold = web_api_proxy.estimate("claude-opus-5.5", {"model": "claude-opus-5.5", "max_tokens": 1000,
                                                          "messages": [{"role": "user", "content": "Hi"}]})
        with patch.object(web_api_proxy.time, "sleep"), \
                self.assertLogs("sign402_gateway.web_api_proxy", "WARNING") as logs:
            self.body_of(self.anthropic_stream_without_cost())
        self.assertEqual(self.surplus.request_record.call_count, len(web_api_proxy.COST_LOOKUP_DELAYS))
        self.assertEqual(self.balances.ledger(self.account)[0]["amount_atomic"], -hold)
        shown = "\n".join(logs.output)
        self.assertIn('"total_usd": "float"', shown)
        self.assertNotIn("0.002", shown)

    def test_the_request_log_is_read_with_singits_key(self):
        seen = []

        class Reply(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def opener(request, timeout):
            seen.append((request.full_url, request.get_method(), request.headers.get("Authorization"), timeout))
            return Reply(json.dumps({"buyer_cost_micro": 5}).encode())

        upstream = web_api_proxy.Upstream("inf_test", "https://surplus.example/", opener)
        self.assertEqual(upstream.request_record("req/1 2"), {"buyer_cost_micro": 5})
        self.assertEqual(seen, [("https://surplus.example/v1/requests/req%2F1%202", "GET", "Bearer inf_test",
                                 web_api_proxy.COST_LOOKUP_SECONDS)])

        def down(request, timeout):
            raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, None)

        self.assertIsNone(web_api_proxy.Upstream("inf_test", opener=down).request_record("req_1"))

    def test_an_openai_stream_gets_its_usage_chunk_only_when_it_asked(self):
        chunk = {"choices": [{"index": 0, "delta": {"content": "Hi"}}]}
        usage = {"choices": [], "usage": {"prompt_tokens": 3, "completion_tokens": 1, "buyer_cost_micro": 500}}
        for asked in (False, True):
            with self.subTest(asked=asked):
                self.surplus.replies.append(Response(200, sse(chunk, usage, b"[DONE]"),
                                                     {"Content-Type": "text/event-stream"}))
                body = {"stream": True, "messages": [{"role": "user", "content": "Hi"}]}
                if asked:
                    body["stream_options"] = {"include_usage": True}
                _, relay = self.send("/chat/completions", body)
                text = self.body_of(relay)
                self.assertEqual(self.surplus.sent[-1][1]["stream_options"], {"include_usage": True})
                self.assertEqual(b'"usage"' in text, asked)
                self.assertNotIn(b"buyer_cost_micro", text)
                self.assertTrue(text.endswith(b"data: [DONE]\n\n"))
                self.assertEqual(self.balances.ledger(self.account)[0]["amount_atomic"], -650)

    def test_a_streamed_chat_loses_the_sellers_own_price_and_unit(self):
        usage = {"choices": [], "usage": {"prompt_tokens": 3, "completion_tokens": 1, "buyer_cost_micro": 500},
                 "cost": {"usd": 0, "diem": 7.6e-06}}
        self.surplus.replies.append(Response(200, sse({"choices": [{"index": 0, "delta": {"content": "Hi"}}]}, usage,
                                                      b"[DONE]"), {"Content-Type": "text/event-stream"}))
        _, relay = self.send("/chat/completions", {"stream": True, "stream_options": {"include_usage": True},
                                                   "messages": [{"role": "user", "content": "Hi"}]})
        text = self.body_of(relay)
        self.assertIn(b'"prompt_tokens": 3', text)
        self.assertNotIn(b"diem", text)
        self.assertNotIn(b'"cost"', text)

    def test_responses_api_is_relayed_and_charged(self):
        self.surplus.replies.append(Response(200, {"object": "response", "output": [],
                                                   "usage": {"input_tokens": 4, "output_tokens": 2,
                                                             "buyer_cost_micro": 100}}))
        _, relay = self.send("/responses", {"model": "gpt-5.5", "input": "Hi"})
        self.assertEqual(json.loads(self.body_of(relay))["billing"]["chargedAtomic"], 130)
        self.assertEqual(self.surplus.sent[0][0], "/v1/responses")

    def test_a_failed_request_costs_nothing(self):
        self.surplus.replies.append(Response(400, {"error": {"message": "bad tool schema"}}))
        _, relay = self.send("/chat/completions", {"messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual((relay.status, json.loads(self.body_of(relay))), (400, {"error": {"message": "bad tool schema"}}))
        state = self.balances.state(self.account)
        self.assertEqual((state["balanceAtomic"], state["heldAtomic"]), (5_000_000, 0))
        _, keys, _ = self.call("GET", "/api-keys")
        self.assertEqual(keys["keys"][0]["spentTodayUsd"], 0)

    def test_singits_own_upstream_trouble_is_not_shown_as_the_callers(self):
        for status in (401, 402):
            self.surplus.replies.append(Response(status, {"error": "no balance"}))
            with self.subTest(status=status), self.assertRaises(ApiError) as caught, \
                 self.assertLogs("sign402_gateway.web_api_proxy", "ERROR"):
                self.send("/chat/completions", {"messages": [{"role": "user", "content": "Hi"}]})
            self.assertEqual((caught.exception.status, caught.exception.code), (503, "upstream_unavailable"))
        self.assertEqual(self.balances.state(self.account)["heldAtomic"], 0)

    def test_a_request_that_may_cost_more_than_the_key_allows_is_refused_before_any_top_up(self):
        with self.assertRaises(ApiError) as caught:  # the question alone, held at the list price, passes $1
            self.send("/chat/completions", {"model": "claude-opus-5.5", "max_tokens": 10,
                                            "messages": [{"role": "user", "content": "x" * 500_000}]})
        self.assertEqual(caught.exception.code, "over_request_limit")
        self.assertEqual((self.topups, self.surplus.sent), ([], []))

    def test_an_answer_dearer_than_its_hold_is_charged_the_hold(self):
        body = {"model": "claude-opus-5.5", "max_tokens": 1, "messages": [{"role": "user", "content": "Hi"}]}
        request = {**body, "si_route": {"objective": "price"}}
        hold = web_api_proxy.estimate("claude-opus-5.5", request)
        self.surplus.replies.append(Response(200, {"usage": {"buyer_cost_micro": 500_000}}, {"x-request-id": "req_dear"}))
        with self.assertLogs("sign402_gateway.web_api_proxy", "WARNING") as logs:
            _, relay = self.send("/chat/completions", body)
        out = json.loads(self.body_of(relay))
        self.assertLess(hold, charge_for(500_000))
        self.assertEqual(out["billing"]["chargedAtomic"], hold)
        self.assertEqual(out["billing"]["costAtomic"], 500_000)
        state = self.balances.state(self.account)
        self.assertEqual((state["balanceAtomic"], state["heldAtomic"]), (5_000_000 - hold, 0))
        line = self.balances.ledger(self.account)[0]
        self.assertEqual((line["amount_atomic"], line["cost_atomic"]), (-hold, 500_000))
        _, keys, _ = self.call("GET", "/api-keys")
        self.assertEqual(keys["keys"][0]["spentTodayUsd"], hold / 1e6)
        self.assertTrue(any("cost 500000" in line for line in logs.output))

    def claude_code_request(self, cost):
        """A Claude Code turn: it asks for up to 128k tokens of answer and gets far fewer."""
        body = {"model": "claude-opus-5-5", "max_tokens": 128_000, "messages": [{"role": "user", "content": "Hi"}]}
        sent = {**body, "model": "claude-opus-5.5"}
        self.surplus.replies.append(Response(200, {"usage": {"buyer_cost_micro": cost}}, {"x-request-id": "req_cc"}))
        held = []
        real_hold = self.balances.hold
        with patch.object(self.balances, "hold", side_effect=lambda *a: held.append(a[2]) or real_hold(*a)):
            _, relay = self.send("/messages", body)
        return json.loads(self.body_of(relay)), held[-1], web_api_proxy.estimate("claude-opus-5.5", sent)

    def test_a_claude_code_turn_holds_a_capped_answer_and_is_charged_what_it_cost(self):
        out, hold, most = self.claude_code_request(20_000)
        self.assertEqual(hold, web_api_proxy.estimate("claude-opus-5.5", {"max_tokens": 128_000, "messages": [
            {"role": "user", "content": "Hi"}]}, web_api_proxy.HOLD_OUTPUT_TOKENS))
        self.assertLess(hold * 7, most)  # 16k of 128k tokens of answer
        self.assertLess(hold, 1_000_000)  # fits under the key's $1 a request, where the whole 128k would not
        self.assertEqual(out["billing"]["chargedAtomic"], charge_for(20_000))

    def test_an_answer_longer_than_its_hold_is_paid_from_the_free_balance_up_to_the_key_limit(self):
        out, hold, _ = self.claude_code_request(600_000)  # 780,000 charged: past the hold, under the $1 limit
        self.assertLess(hold, charge_for(600_000))
        self.assertEqual(out["billing"]["chargedAtomic"], charge_for(600_000))
        self.assertEqual(self.balances.state(self.account)["balanceAtomic"], 5_000_000 - charge_for(600_000))
        _, keys, _ = self.call("GET", "/api-keys")
        self.assertEqual(keys["keys"][0]["spentTodayUsd"], charge_for(600_000) / 1e6)
        with self.assertLogs("sign402_gateway.web_api_proxy", "WARNING"):
            out, _, _ = self.claude_code_request(2_000_000)  # 2.6M: the key allows $1 a request
        self.assertEqual(out["billing"]["chargedAtomic"], 1_000_000)

    def test_an_answer_longer_than_its_hold_never_takes_another_requests_hold(self):
        self.balances.set_terms(self.account, 5_000_000, 1_000_000, False, NOW)  # no refill after it
        self.balances.claim_topup("top_" + "e" * 24, self.account, 5_000_000, NOW)
        self.balances.credit_topup("top_" + "e" * 24, 5_001_000, 5_000_000, "0xtx", "base", NOW)
        hold = web_api_proxy.estimate("claude-opus-5.5", {"max_tokens": 128_000, "messages": [
            {"role": "user", "content": "Hi"}]}, web_api_proxy.HOLD_OUTPUT_TOKENS)
        self.assertTrue(self.balances.hold(self.account, "h_other", 5_000_000 - hold - 100_000, NOW))
        with self.assertLogs("sign402_gateway.web_api_proxy", "WARNING"):
            out, held, _ = self.claude_code_request(600_000)
        self.assertEqual(held, hold)
        self.assertEqual(out["billing"]["chargedAtomic"], hold + 100_000)  # its hold and what was still free
        state = self.balances.state(self.account)
        self.assertEqual((state["balanceAtomic"], state["heldAtomic"]),
                         (5_000_000 - hold - 100_000, 5_000_000 - hold - 100_000))

    def test_a_token_limit_that_is_not_an_integer_is_refused_before_anything_is_paid(self):
        for limit in ("100000", 1000.5, True, 0, -1):
            with self.subTest(limit=limit), self.assertRaises(ApiError) as caught:
                self.send("/chat/completions", {"model": "claude-opus-5.5", "max_tokens": limit,
                                                "messages": [{"role": "user", "content": "Hi"}]})
            self.assertEqual(caught.exception.code, "invalid_max_tokens")
        self.assertEqual((self.topups, self.surplus.sent), ([], []))

    def test_a_top_up_the_limits_refuse_says_why_in_the_callers_dialect(self):
        self.refuse_topup = "Your per-purchase limit allows $0.50. Raise the limit in Settings."
        with self.assertRaises(ApiError) as caught:
            self.send("/messages", {"model": "claude-opus-5.5", "max_tokens": 10,
                                    "messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual(caught.exception.status, 402)
        self.assertEqual(caught.exception.body()["error"]["type"], "billing_error")
        self.assertIn("per-purchase limit", caught.exception.body()["error"]["message"])
        self.assertEqual(self.surplus.sent, [])

    def test_answers_carry_no_sign_of_who_sold_them(self):
        """A real answer's shape (15 October): Surplus's seller, its cost fields and its own id are not passed on."""
        self.surplus.replies.append(Response(200, {
            "provider": "Morph", "service_tier": None, "id": "gen-1792027712-11J0cWlpBomOJcBCHht7",
            "object": "chat.completion", "model": "deepseek-v4.1-flash",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hi"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 33, "completion_tokens": 47, "total_tokens": 80, "cost": 0, "is_byok": True,
                      "cost_details": {"upstream_inference_cost": 2.8926e-05}, "buyer_cost_micro": 3,
                      "prompt_tokens_details": {"cached_tokens": 0}}}))
        _, relay = self.send("/chat/completions", {"messages": [{"role": "user", "content": "Hi"}]})
        out = json.loads(self.body_of(relay))
        self.assertNotIn("provider", out)
        self.assertTrue(out["id"].startswith("chatcmpl-singit-"))
        self.assertEqual(out["usage"], {"prompt_tokens": 33, "completion_tokens": 47, "total_tokens": 80,
                                        "prompt_tokens_details": {"cached_tokens": 0}})
        self.assertEqual((out["billing"]["chargedAtomic"], out["billing"]["costAtomic"]), (4, 3))
        self.assertEqual(self.balances.ledger(self.account)[0]["amount_atomic"], -4)

    def test_a_stream_keeps_one_id_of_our_own_and_no_seller(self):
        events = sse({"id": "gen-1", "provider": "Morph", "choices": [{"index": 0, "delta": {"content": "Hi"}}]},
                     {"id": "gen-1", "provider": "Morph", "choices": [],
                      "usage": {"prompt_tokens": 3, "completion_tokens": 1, "is_byok": True, "buyer_cost_micro": 500}},
                     b"[DONE]")
        self.surplus.replies.append(Response(200, events, {"Content-Type": "text/event-stream"}))
        _, relay = self.send("/chat/completions", {"stream": True, "stream_options": {"include_usage": True},
                                                   "messages": [{"role": "user", "content": "Hi"}]})
        text = self.body_of(relay)
        chunks = [json.loads(line[6:]) for line in text.split(b"\n") if line.startswith(b"data: {")]
        self.assertEqual(len({c["id"] for c in chunks}), 1)
        self.assertTrue(chunks[0]["id"].startswith("chatcmpl-singit-"))
        for word in (b"Morph", b"gen-1", b"is_byok", b"buyer_cost_micro"):
            self.assertNotIn(word, text)
        self.assertEqual(chunks[1]["usage"], {"prompt_tokens": 3, "completion_tokens": 1})
        self.assertEqual(self.balances.ledger(self.account)[0]["amount_atomic"], -650)

    def test_a_refusal_names_no_seller(self):
        self.surplus.replies.append(Response(400, {"error": {"message": "Bad request", "code": 400,
                                                             "metadata": {"provider_name": "Morph", "raw": "x"}}}))
        _, relay = self.send("/chat/completions", {"messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual(json.loads(self.body_of(relay)), {"error": {"message": "Bad request", "code": 400}})

    def test_counting_tokens_is_free(self):
        self.surplus.replies.append(Response(200, {"input_tokens": 7}))
        _, relay = self.send("/messages/count_tokens", {"model": "claude-opus-5.5", "messages": []})
        self.assertEqual(json.loads(self.body_of(relay)), {"input_tokens": 7})
        self.assertEqual((self.topups, self.balances.ledger(self.account)), ([], []))

    def test_the_balance_refills_in_the_background_under_its_threshold(self):
        self.balances.claim_topup(new_topup_id(), self.account, 1_100_000, NOW)
        topup = self.balances.state(self.account)["pending"][0]["id"]
        self.balances.credit_topup(topup, 1_101_000, 1_100_000, "0xtx", "base", NOW)
        self.surplus.replies.append(Response(200, {"usage": {"buyer_cost_micro": 100_000}}))
        self.send("/chat/completions", {"messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual([t["amountAtomic"] for t in self.topups], [5_000_000])
        self.assertEqual(self.balances.state(self.account)["balanceAtomic"], 1_100_000 - 130_000 + 5_000_000)

    def test_balance_and_usage_for_the_key_and_the_app(self):
        self.send("/chat/completions", {"messages": [{"role": "user", "content": "Hi"}]})
        _, balance, _ = self.api.keys.public("GET", "/balance", authorization=f"Bearer {self.key}", origin=None, body={})
        self.assertEqual((balance["balanceUsd"], balance["topupUsd"], balance["thresholdUsd"]), (4.9987, 5, 1))
        _, usage, _ = self.api.keys.public("GET", "/usage", authorization=f"Bearer {self.key}", origin=None, body={},
                                           query={"days": "7"})
        self.assertEqual((usage["totalUsd"], usage["data"][0]["keyName"], usage["data"][0]["requests"]),
                         (0.0013, "my bot", 1))
        _, page, _ = self.call("GET", "/balance")
        self.assertEqual([line["kind"] for line in page["ledger"]], ["charge", "topup"])
        _, settings, _ = self.call("POST", "/balance/settings", {"topupUsd": 10, "thresholdUsd": 2})
        self.assertEqual((settings["topupUsd"], settings["thresholdUsd"]), (10, 2))
        with self.assertRaises(ValueError):
            self.call("POST", "/balance/settings", {"topupUsd": 2, "thresholdUsd": 2})
        with self.assertLogs("sign402_gateway.web_api_keys", "WARNING"):
            _, frozen, _ = self.call("POST", "/balance/refund")
        self.assertTrue(frozen["refundRequested"])
        with self.assertRaises(ApiError) as caught:
            self.send("/chat/completions", {"messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual(caught.exception.code, "balance_frozen")

    def test_a_manual_top_up_from_the_app(self):
        _, out, _ = self.call("POST", "/balance/topup", {"amountUsd": 20})
        self.assertEqual((out["balanceUsd"], self.topups[0]["minAtomic"]), (20, 20_000_000))

    def test_model_names(self):
        self.assertEqual(surplus_model(None), "deepseek-v4.1-flash")
        self.assertEqual(surplus_model("singit-ask"), "deepseek-v4.1-flash")
        self.assertEqual(surplus_model("claude-sonnet-5-5"), "claude-sonnet-5.5")
        self.assertEqual(surplus_model("claude-haiku-5-5-20260301"), "claude-haiku-5.5")
        self.assertEqual(surplus_model("claude-fable-5-1"), "claude-fable-5.1")
        self.assertEqual(surplus_model("claude-fable-5-1-20260801"), "claude-fable-5.1")
        self.assertEqual(surplus_model("gpt-5.5"), "gpt-5.5")
        self.assertEqual(charge_for(1), 2)
        self.assertEqual(charge_for(1000), 1300)


class ImageTests(ProxyFixture):
    """Images for an API key: OpenAI's images request, paid from the balance at what Surplus charged + 30%."""

    def setUp(self):
        super().setUp()
        p = patch.object(web_api_proxy.ask_catalogue, "image_list_usd",
                         side_effect=lambda m: {"venice-seedream-v5-lite": 0.01, "venice-gpt-image-2": 0.27}.get(m))
        p.start()
        self.addCleanup(p.stop)

    def test_an_image_is_relayed_and_charged_what_surplus_charged_plus_30(self):
        self.surplus.replies.append(Response(200, {"created": 1, "data": [{"b64_json": "aW1hZ2U="}]},
                                             {"x-si-buyer-cost-micro": "3960", "x-request-id": "req_img"}))
        _, relay = self.send("/images/generations", {"model": "venice-seedream-v5-lite", "prompt": "a robot", "n": 1})
        out = json.loads(self.body_of(relay))
        self.assertEqual(out["data"], [{"b64_json": "aW1hZ2U="}])
        self.assertEqual((out["billing"]["chargedAtomic"], out["billing"]["costAtomic"]), (5148, 3960))  # 3960 + 30%
        path, sent, _ = self.surplus.sent[0]
        self.assertEqual((path, sent), ("/v1/images/generations", {"model": "venice-seedream-v5-lite", "prompt": "a robot", "n": 1}))
        line = self.balances.ledger(self.account)[0]
        self.assertEqual((line["model"], line["amount_atomic"], line["ref"]), ("venice-seedream-v5-lite", -5148, "req_img"))

    def test_what_is_refused_before_anything_is_paid(self):
        for body, code in (({"prompt": "x"}, "model_required"), ({"model": "dall-e-9", "prompt": "x"}, "model_not_found"),
                           ({"model": "venice-seedream-v5-lite", "prompt": "x", "n": 9}, "invalid_n"),
                           ({"model": "venice-gpt-image-2", "prompt": "x", "n": 4}, "over_request_limit")):
            with self.subTest(code=code), self.assertRaises(ApiError) as caught:
                self.send("/images/generations", body)
            self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.surplus.sent, [])


class VoiceTests(ProxyFixture):
    """Speech and transcription for an API key, paid from the balance at Surplus's cost + 30%, up to the list-price hold."""

    def setUp(self):
        super().setUp()
        for name, prices in (("speech_list_usd", {"venice-kokoro-tts": 0.0035}),
                             ("transcription_list_usd", {"venice-whisper-1": 0.006})):
            p = patch.object(web_api_proxy.ask_catalogue, name, side_effect=lambda m, prices=prices: prices.get(m))
            p.start()
            self.addCleanup(p.stop)

    def test_speech_comes_back_as_audio_and_is_charged_what_it_cost(self):
        self.surplus.replies.append(Response(200, b"ID3\x04audio", {"Content-Type": "audio/mpeg", "x-si-buyer-cost-micro": "80"}))
        _, relay = self.send("/audio/speech", {"model": "venice-kokoro-tts", "input": "Hello from SingIt.", "voice": "af_heart"})
        self.assertEqual((relay.status, relay.headers["Content-Type"]), (200, "audio/mpeg"))
        self.assertEqual(self.body_of(relay), b"ID3\x04audio")
        self.assertEqual(relay.headers["X-SingIt-Charged-Atomic"], "82")  # list-price hold; 80 + 30% would be 104
        self.assertEqual(self.surplus.sent[0][:2], ("/v1/audio/speech", {"model": "venice-kokoro-tts",
                                                                        "input": "Hello from SingIt.", "voice": "af_heart"}))
        line = self.balances.ledger(self.account)[0]
        self.assertEqual((line["model"], line["amount_atomic"], line["cost_atomic"]), ("venice-kokoro-tts", -82, 80))

    def test_a_transcription_upload_goes_on_as_it_came(self):
        upload = (b'--b\r\nContent-Disposition: form-data; name="model"\r\n\r\nvenice-whisper-1\r\n'
                  b'--b\r\nContent-Disposition: form-data; name="file"; filename="a.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n'
                  + b"x" * 1000 + b"\r\n--b--\r\n")
        self.surplus.replies.append(Response(200, {"text": "hi", "duration": 4.1}, {"x-si-buyer-cost-micro": "40"}))
        status, relay, _ = self.api.keys.public("POST", "/audio/transcriptions", authorization=f"Bearer {self.key}",
                                                origin=None, body={"model": "venice-whisper-1"},
                                                raw=(upload, "multipart/form-data; boundary=b"))
        out = json.loads(self.body_of(relay))
        self.assertEqual((out["text"], out["billing"]["chargedAtomic"], out["billing"]["costAtomic"]), ("hi", 39, 40))
        self.assertEqual(self.surplus.sent[0], ("/v1/audio/transcriptions", upload,
                                                {"Content-Type": "multipart/form-data; boundary=b"}))

    def test_what_is_refused_before_anything_is_paid(self):
        for path, body, code in (("/audio/speech", {"input": "x"}, "model_required"),
                                 ("/audio/speech", {"model": "tts-9", "input": "x"}, "model_not_found"),
                                 ("/audio/speech", {"model": "venice-kokoro-tts", "input": ""}, "invalid_input"),
                                 ("/audio/speech", {"model": "venice-kokoro-tts", "input": "x" * 5000}, "invalid_input"),
                                 ("/audio/transcriptions", {"model": "venice-whisper-1"}, "invalid_file")):
            with self.subTest(code=code), self.assertRaises(ApiError) as caught:
                self.send(path, body)
            self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.surplus.sent, [])


class BoughtBalanceTests(ProxyFixture):
    """The default: a key spends only what its owner bought; nothing is bought for them."""

    def setUp(self):
        super().setUp()
        self.balances.set_terms(self.account, 5_000_000, 1_000_000, False, NOW)

    def test_an_empty_balance_refuses_and_buys_nothing(self):
        with self.assertRaises(ApiError) as caught:
            self.send("/chat/completions", {"messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual((caught.exception.status, caught.exception.code), (402, "balance_low"))
        self.assertIn("Top it up in the SingIt app", caught.exception.message)
        self.assertEqual((self.topups, self.surplus.sent), ([], []))

    def test_what_the_owner_bought_is_spent_and_never_refilled_by_itself(self):
        _, out, _ = self.call("POST", "/balance/topup", {"amountUsd": 1.2})
        self.assertEqual(out["balanceUsd"], 1.2)
        self.surplus.replies.append(Response(200, {"usage": {"buyer_cost_micro": 200_000}}))
        self.send("/chat/completions", {"messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual(len(self.topups), 1, "under the threshold, but automatic top-ups are off")
        state = self.balances.state(self.account)
        self.assertEqual((state["balanceAtomic"], state["autoTopup"]), (1_200_000 - 260_000, False))

    def test_the_owner_can_turn_automatic_top_ups_on(self):
        _, out, _ = self.call("POST", "/balance/settings", {"topupUsd": 5, "thresholdUsd": 1, "autoTopup": True})
        self.assertTrue(out["autoTopup"])
        self.send("/chat/completions", {"messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual([t["amountAtomic"] for t in self.topups], [5_000_000])


class SearchTests(Fixture):
    """Web search for an API key: bought per request from the owner's limits through the gateway, no balance."""

    def setUp(self):
        super().setUp()
        self.key = self.make_key(dailyUsd=1, perRequestUsd=0.05)["key"]
        self.shop.reply = (200, {"ok": True, "costAtomic": 10100, "txId": "0x" + "c" * 64, "network": "base",
                                 "data": {"results": [{"url": "https://x402.org"}],
                                          "billing": {"exaAtomic": "7000", "totalAtomic": "10100"}}})

    def search(self, path="/exa/search", body=None, key=None):
        return self.api.keys.public("POST", path, authorization=f"Bearer {key or self.key}", origin=None,
                                    body=body or {"query": "x402"})

    def test_a_search_is_paid_from_the_owners_limits_and_counted_against_the_key(self):
        status, out, headers = self.search(body={"query": "x402", "numResults": 5})
        self.assertEqual((status, out["results"][0]["url"]), (200, "https://x402.org"))
        self.assertEqual((out["billing"]["chargedAtomic"], out["billing"]["exaAtomic"]), (10100, "7000"))
        self.assertEqual(headers["X-SingIt-Charged-Atomic"], "10100")
        action, account, body = self.shop.calls[-1]
        self.assertEqual((action, account), ("api-search", self.account))
        self.assertEqual(body, {"path": "/v1/exa/search", "body": {"query": "x402", "numResults": 5}, "limitAtomic": 50_000})
        _, keys, _ = self.call("GET", "/api-keys")
        self.assertEqual(keys["keys"][0]["spentTodayUsd"], 0.0101)

    def test_page_contents_and_answers_too_and_nothing_else(self):
        self.search("/exa/contents", {"urls": ["https://x402.org"], "text": True})
        self.assertEqual(self.shop.calls[-1][2]["path"], "/v1/exa/contents")
        self.search("/exa/answer", {"query": "What is x402?"})
        self.assertEqual(self.shop.calls[-1][2]["path"], "/v1/exa/answer")
        with self.assertRaises(ApiError) as caught:
            self.search("/exa/research")
        self.assertEqual(caught.exception.status, 404)

    def test_a_key_signed_for_answers_only_cannot_search(self):
        with self.store._db() as db:
            db.execute("UPDATE api_keys SET scopes = 'answers'")
        with self.assertRaises(ApiError) as caught:
            self.search()
        self.assertEqual((caught.exception.status, caught.exception.code), (403, "scope_missing"))
        self.assertNotIn("api-search", [c[0] for c in self.shop.calls])

    def test_the_gateways_refusal_keeps_its_words_and_costs_nothing(self):
        self.shop.reply = (400, {"ok": False, "error": "refused", "text": "Web search costs more than your per-purchase limit."})
        with self.assertRaises(ApiError) as caught:
            self.search()
        self.assertIn("per-purchase limit", caught.exception.message)
        _, keys, _ = self.call("GET", "/api-keys")
        self.assertEqual(keys["keys"][0]["spentTodayUsd"], 0)

    def test_new_keys_may_search_and_say_so(self):
        _, keys, _ = self.call("GET", "/api-keys")
        self.assertEqual(keys["keys"][0]["scopes"], ["answers", "search"])


class VideoKeyTests(Fixture):
    """Video for an API key: the job bought at SingIt Ask's x402 price from the owner's wallet, polled with its token."""

    def setUp(self):
        super().setUp()
        self.key = self.make_key(dailyUsd=5, perRequestUsd=1)["key"]
        with self.store._db() as db:
            db.execute("UPDATE api_keys SET scopes = 'answers'")  # video is a model's answer: no search scope needed
        self.shop.reply = (200, {"ok": True, "costAtomic": 105000, "txId": "0x" + "e" * 64, "network": "base",
                                 "data": {"id": "vj_123456", "object": "video.generation", "status": "queued", "job_token": "tok",
                                          "results": [], "billing": {"totalAtomic": "105000"}}})

    def test_a_video_job_is_bought_from_the_owners_limits_and_polled_here(self):
        status, out, _ = self.api.keys.public("POST", "/video/generations", authorization=f"Bearer {self.key}", origin=None,
                                              body={"model": "venice-seedance-2-fast-t2v", "prompt": "a robot waves"})
        self.assertEqual((status, out["id"], out["job_token"], out["poll"]), (200, "vj_123456", "tok", "/v1/video/generations/vj_123456"))
        self.assertEqual(out["billing"]["chargedAtomic"], 105000)
        self.assertEqual(self.shop.calls[-1][2], {"path": "/v1/video/generations", "limitAtomic": 1_000_000,
                                                  "body": {"model": "venice-seedance-2-fast-t2v", "prompt": "a robot waves"}})

    def test_polling_passes_the_token_and_points_files_here(self):
        sent = []

        class Answer:
            status, headers = 200, {"Content-Type": "application/json"}
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n): return json.dumps({"id": "vj_123456", "status": "succeeded", "results": [
                {"index": 0, "url": "https://ask.singitai.app/v1/video/generations/vj_123456/content?index=0"}]}).encode()

        def opener(request, timeout):
            sent.append((request.full_url, request.get_header("X-job-token")))
            return Answer()

        with patch.object(web_api_keys_module.urllib.request, "urlopen", opener):
            status, relay, _ = self.api.keys.public("GET", "/video/generations/vj_123456", authorization=f"Bearer {self.key}",
                                                    origin=None, body={}, headers={"x-job-token": "tok"})
        job = json.loads(b"".join(relay))
        self.assertEqual((status, job["results"][0]["url"]), (200, "/v1/video/generations/vj_123456/content?index=0"))
        self.assertEqual(sent, [("https://ask.singitai.app/v1/video/generations/vj_123456", "tok")])
        with self.assertRaises(ApiError) as caught:
            self.api.keys.public("GET", "/video/generations/vj_123456", authorization=f"Bearer {self.key}", origin=None, body={})
        self.assertEqual(caught.exception.code, "token_missing")


class GatewaySearchTests(unittest.TestCase):
    """web_data.search and the internal "api-search" action, with the payer mocked."""

    def setUp(self):
        from sign402_gateway import web_data
        self.web_data = web_data
        self.server = SimpleNamespace(allowance=SimpleNamespace(owner_lookup=lambda a: "0x1111"))
        self.gw = SimpleNamespace(_purchases_paused=lambda: False)
        self.pay = Mock(return_value=(10100, {"results": []}, "0x" + "d" * 64))
        p = patch.object(web_data, "pay_once", self.pay)
        p.start()
        self.addCleanup(p.stop)

    def test_singits_search_is_bought_at_its_revenue_address_within_the_key_cap(self):
        from sign402_gateway import ask_metered, ask_solana
        out = self.web_data.search(self.server, self.gw, ACCOUNT, "/v1/exa/search", {"query": "x"}, limit=50_000)
        self.assertEqual((out["costAtomic"], out["network"]), (10100, "base"))
        tool, method, url, body = self.pay.call_args.args[3:7]
        self.assertEqual((method, url, body), ("POST", "https://ask.singitai.app/v1/exa/search", {"query": "x"}))
        self.assertEqual(tool.pay_to, {"eip155:8453": ask_metered.PAY_TO,
                                       "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": ask_solana.PAY_TO})
        self.assertEqual(tool.cap_atomic, 50_000)
        self.web_data.search(self.server, self.gw, ACCOUNT, "/v1/exa/contents", {"urls": ["https://a.test"]})
        self.assertEqual(self.pay.call_args.args[3].cap_atomic, 67_000)

    def test_a_video_job_has_its_own_ceiling(self):
        self.web_data.search(self.server, self.gw, ACCOUNT, "/v1/video/generations", {"model": "m", "prompt": "x"})
        tool, method, url = self.pay.call_args.args[3:6]
        self.assertEqual((tool.cap_atomic, tool.name, url), (1_302_000, "Video", "https://ask.singitai.app/v1/video/generations"))

    def test_what_is_refused_before_paying(self):
        from sign402_gateway import ask_solana
        for path, body, account in (("/v1/exa/research", {}, ACCOUNT), ("/v1/exa/search", "x", ACCOUNT),
                                    ("/v1/exa/search", {"query": "x"}, "solana:" + ask_solana.PAY_TO)):
            with self.subTest(path=path, account=account), self.assertRaises(AllowanceError):
                self.web_data.search(self.server, self.gw, account, path, body)
        self.gw._purchases_paused = lambda: True
        with self.assertRaises(AllowanceError):
            self.web_data.search(self.server, self.gw, ACCOUNT, "/v1/exa/search", {"query": "x"})
        self.pay.assert_not_called()

    def test_the_internal_action_is_a_paying_one(self):
        self.assertIn("api-search", web_internal.PAYING_ACTIONS)
        with patch.object(web_internal, "_limits_from_limiter") as limits:
            status, out = web_internal.handle(self.server, "api-search", {
                "account": ACCOUNT, "path": "/v1/exa/search", "body": {"query": "x"}, "limitAtomic": 30_000})
        self.assertEqual((status, out["costAtomic"]), (200, 10100))
        limits.assert_called_once()
        self.assertEqual(self.pay.call_args.args[3].cap_atomic, 30_000)


class ProxyHttpTests(ProxyFixture):
    """Over HTTP, the way the SDKs and Claude Code call it: chunks reach the client as Surplus sends them."""

    def setUp(self):
        super().setUp()
        self.server = wa.WebServer(("127.0.0.1", 0), self.api, URI)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def test_a_stream_arrives_in_pieces_and_is_charged_at_its_end(self):
        gate = threading.Event()

        class Slow(Response):
            def readline(self_):
                line = Response.readline(self_)
                if b"second" in line:
                    gate.wait(5)
                return line

        events = sse({"type": "content_block_delta", "delta": {"text": "first"}},
                     {"type": "content_block_delta", "delta": {"text": "second"}},
                     {"type": "message_delta", "usage": {"output_tokens": 2, "buyer_cost_micro": 1000}})
        self.surplus.replies.append(Slow(200, events, {"Content-Type": "text/event-stream"}))
        request = urllib.request.Request(self.base + "/messages", data=json.dumps({
            "model": "claude-opus-5.5", "max_tokens": 50, "stream": True,
            "messages": [{"role": "user", "content": "Hi"}]}).encode(),
            headers={"x-api-key": self.key, "Content-Type": "application/json", "anthropic-version": "2023-06-01"})
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertEqual(response.headers.get_content_type(), "text/event-stream")
            first = response.readline()
            self.assertIn(b"first", first, "the first event came before the second was produced")
            gate.set()
            rest = response.read()
        self.assertEqual(first + rest, events.replace(b', "buyer_cost_micro": 1000', b""))
        self.assertEqual(self.balances.ledger(self.account)[0]["amount_atomic"], -1300)

    def test_an_audio_file_is_uploaded_and_transcribed(self):
        p = patch.object(web_api_proxy.ask_catalogue, "transcription_list_usd", return_value=0.006)
        p.start()
        self.addCleanup(p.stop)
        self.surplus.replies.append(Response(200, {"text": "hello"}, {"x-si-buyer-cost-micro": "40"}))
        upload = (b'--XyZ\r\nContent-Disposition: form-data; name="file"; filename="a.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n'
                  + b"\x00\x01" * 500 + b'\r\n--XyZ\r\nContent-Disposition: form-data; name="model"\r\n\r\nvenice-whisper-1\r\n--XyZ--\r\n')
        request = urllib.request.Request(self.base + "/audio/transcriptions", data=upload, headers={
            "Authorization": f"Bearer {self.key}", "Content-Type": "multipart/form-data; boundary=XyZ"})
        with urllib.request.urlopen(request, timeout=10) as response:
            out = json.loads(response.read())
        self.assertEqual((out["text"], out["billing"]["chargedAtomic"]), ("hello", 39))
        self.assertEqual(self.surplus.sent[0][1], upload)
        request = urllib.request.Request(self.base + "/audio/transcriptions", data=b"{}", headers={
            "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=10)
        with caught.exception as error:
            self.assertEqual((error.code, json.loads(error.read())["error"]["code"]), (415, "multipart_only"))

    def test_anthropic_errors_keep_anthropics_shape(self):
        request = urllib.request.Request(self.base + "/messages", data=b"{}", headers={
            "x-api-key": "sk_singit_wrong", "Content-Type": "application/json"})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=10)
        with caught.exception as error:
            self.assertEqual((error.code, json.loads(error.read())["error"]["type"]), (401, "authentication_error"))


def tearDownModule():
    import gc
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", ResourceWarning)
        gc.collect()


if __name__ == "__main__":
    unittest.main()

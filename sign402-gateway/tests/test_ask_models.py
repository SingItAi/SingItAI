"""Choosing any Surplus model for SingIt Ask: the list, the ceiling, and what the gateway refuses to pay."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from sign402_gateway import ask_catalogue, ask_metered, ask_solana, web_ask, web_internal
from sign402_gateway.agent_allowance import AllowanceError, AllowanceUnavailable
from sign402_gateway.chat_store import ChatStore

ACCOUNT = "wallet:0x1111111111111111111111111111111111111111"
CHEAP = {"id": "cheap", "label": "Cheap", "provider": "P", "input": 0.1, "output": 0.3}
PRO = {"id": "pro", "label": "Pro", "provider": "P", "input": 30.0, "output": 180.0}


def listed(*items):
    return patch.object(ask_catalogue, "models", return_value=list(items))


class CatalogueTests(unittest.TestCase):
    def setUp(self):
        ask_catalogue._cache.update(at=0.0, models=None)
        self.addCleanup(ask_catalogue._cache.update, at=0.0, models=None)

    def test_the_list_is_cached_cheapest_first_and_survives_a_failed_refresh(self):
        calls, clock = [], [0.0]
        def fetch():
            calls.append(1)
            if len(calls) > 1:
                raise OSError("down")
            return [PRO, CHEAP]
        now = lambda: clock[0]
        self.assertEqual([m["id"] for m in ask_catalogue.models(now=now, fetch=fetch)], ["cheap", "pro"])
        ask_catalogue.models(now=now, fetch=fetch)
        self.assertEqual(len(calls), 1)
        clock[0] = ask_catalogue.TTL_SECONDS + 1
        self.assertEqual([m["id"] for m in ask_catalogue.models(now=now, fetch=fetch)], ["cheap", "pro"])
        self.assertEqual(len(calls), 2)
        self.assertIsNone(ask_catalogue.resolve("nope", now=now, fetch=fetch))

    def test_ceiling_never_drops_below_the_standing_one_and_grows_with_the_model(self):
        args = dict(markup_bps=3000, fee=1000)
        self.assertEqual(ask_catalogue.ceiling(CHEAP, 1000, 1200, **args), 3000)
        free = {"input": 0.0, "output": 0.0}
        self.assertEqual(ask_catalogue.ceiling(free, 1000, 1200, **args), 3000)
        # Same arithmetic as the merchant's ceilingAtomic: (1000*30 + 2200*180) micro-USD + 1% margin, +30%, +fee.
        worst = -(-(1000 * 30 + 2200 * 180) * 101 // 100)
        self.assertEqual(ask_catalogue.ceiling(PRO, 1000, 1200, **args), worst + (worst * 3000 + 9999) // 10000 + 1000)
        self.assertGreater(ask_catalogue.ceiling(PRO, 1000, 1200, **args), 400_000)


class InvoiceTests(unittest.TestCase):
    def bill(self, cap, cost=100):
        markup = (cost * 3000 + 9999) // 10000
        return {"providerCostAtomic": str(cost), "markupAtomic": str(markup), "totalAtomic": str(cost + markup + 1000),
                "settlementFeeAtomic": "1000", "maxChargeAtomic": str(cap), "markupBps": 3000,
                "mode": "actual_usage", "version": 1, "currency": "USDC"}

    def result(self, cap, cost=100):
        bill = self.bill(cap, cost)
        return {"ok": True, "payer": "agent", "amountAtomic": bill["totalAtomic"],
                "body": {"usage": {"buyer_cost_micro": cost}, "billing": bill}}

    def test_solana_invoice_under_a_raised_ceiling_is_accepted_and_one_above_the_gateways_is_not(self):
        amount, _ = ask_solana._invoice(self.result(400_000), "agent", 400_000)
        self.assertEqual(amount, 1130)
        amount, _ = ask_solana._invoice(self.result(3000), "agent")
        self.assertEqual(amount, 1130)
        with self.assertRaises(AllowanceError):  # the merchant offered more than the gateway allowed
            ask_solana._invoice(self.result(400_001), "agent", 400_000)
        with self.assertRaises(AllowanceError):  # a ceiling the answer's cost exceeds
            ask_solana._invoice(self.result(1100, cost=5000), "agent", 400_000)
        for bad in ("0", "-1", "1e5", None, 3000):
            result = self.result(3000)
            result["body"]["billing"]["maxChargeAtomic"] = bad
            with self.assertRaises(AllowanceError):
                ask_solana._invoice(result, "agent")

    def test_base_invoice_has_the_same_rule(self):
        service = SimpleNamespace(evm=Mock(), store=Mock())
        with self.assertRaises(AllowanceError):
            ask_metered._validate_result(service, self.result(400_001), "agent", ACCOUNT, 400_000)
        with self.assertRaises(AllowanceError):
            ask_metered._validate_result(service, self.result(3001), "agent", ACCOUNT)


class ChooseAndChatTests(unittest.TestCase):
    def setUp(self):
        store = ChatStore(":memory:")
        self.addCleanup(store.close)
        self.server = SimpleNamespace(chat_service=SimpleNamespace(store=store), user_event_store=Mock())
        self.gw = SimpleNamespace(_purchases_paused=lambda: False, _enforce_user_purchase_rate=Mock())
        self.pay = Mock(return_value=(1130, {"choices": [{"message": {"content": "Hello"}}], "usage": {}}, "0x" + "a" * 64))
        for p in [patch.object(web_ask.ask_metered, "pay", self.pay), patch.object(web_internal, "_limits_from_limiter")]:
            p.start()
            self.addCleanup(p.stop)

    def chat(self):
        return web_ask.chat(self.server, self.gw, ACCOUNT, [{"role": "user", "content": "Hi"}])

    def test_the_default_is_asked_exactly_as_before(self):
        self.chat()
        self.assertEqual(self.pay.call_args.args[3]["model"], web_ask.MODEL)
        self.assertEqual(self.pay.call_args.kwargs, {})

    def test_a_chosen_model_is_asked_for_by_its_id_under_its_own_ceiling(self):
        with listed(CHEAP, PRO):
            self.assertEqual(web_ask.choose(self.server, ACCOUNT, "ask:pro")[1]["chosen"], "ask:pro")
            self.assertTrue(web_ask.selected(self.server, ACCOUNT))
            status, answer = self.chat()
        self.assertEqual(status, 200)
        self.assertEqual(self.pay.call_args.args[3]["model"], "pro")
        self.assertEqual(answer["model"], "ask:pro")
        self.assertEqual(answer["modelLabel"], "Pro · SingIt Ask")
        self.assertGreater(self.pay.call_args.kwargs["cap"], 400_000)

    def test_an_unknown_model_is_refused_before_anything_is_recorded(self):
        with listed(CHEAP):
            with self.assertRaises(AllowanceUnavailable):
                web_ask.choose(self.server, ACCOUNT, "ask:nope")
            with self.assertRaises(AllowanceUnavailable):
                web_ask.choose(self.server, ACCOUNT, "venice-x")
        self.assertEqual(web_ask.current(self.server, ACCOUNT), web_ask.MODEL)

    def test_a_model_that_left_the_list_stops_the_chat_before_any_payment(self):
        with listed(PRO):
            web_ask.choose(self.server, ACCOUNT, "ask:pro")
        with listed(CHEAP), self.assertRaises(AllowanceUnavailable):
            self.chat()
        self.pay.assert_not_called()

    def test_the_picker_lists_every_surplus_model_with_its_prices(self):
        with listed(CHEAP, PRO):
            result = web_ask.listing({"chosen": "ask:pro", "models": [{"id": "venice-1"}], "categories": []}, ACCOUNT)
        self.assertEqual([m["id"] for m in result["models"]], ["singit-ask", "ask:cheap", "ask:pro", "venice-1"])
        self.assertEqual(result["models"][2]["outputUsdPerMTok"], 180.0)
        self.assertEqual((result["provider"], result["chosenLabel"]), ("SingIt Ask", "Pro"))


if __name__ == "__main__":
    unittest.main()

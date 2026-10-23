"""API keys: made with a wallet signature, spending only from the owner's limits, within their own caps.

Offline: a fake shop stands for the gateway, and the gateway side runs with its payer mocked.
"""
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
from eth_account.messages import encode_defunct

from sign402_gateway import web_api as wa
from sign402_gateway import web_ask, web_internal
from sign402_gateway.agent_allowance import AllowanceError
from sign402_gateway.web_accounts import WebAccountStore, WebAuth, WebAuthError, account_id_for
from sign402_gateway.web_api_keys import ApiError

NOW = 1_800_000_000
DOMAIN, URI = "app.singit.test", "https://app.singit.test"
ANSWER = {"ok": True, "text": "Hello!", "costAtomic": 7100, "promptTokens": 9, "completionTokens": 3,
          "finishReason": "stop", "txId": "0x" + "ab" * 32, "billing": {"totalAtomic": "7100"}}


def sign(account, message):
    return Account.sign_message(encode_defunct(text=message), account.key).signature.to_0x_hex()


class Shop:
    def __init__(self, reply=(200, ANSWER)):
        self.calls, self.reply = [], reply

    def __call__(self, action, account, body=None):
        self.calls.append((action, account, dict(body or {})))
        if action == "api-models":
            return 200, {"object": "list", "data": [{"id": "claude-opus-5.5", "object": "model"}]}
        return self.reply


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.user = Account.create()
        self.clock = [NOW]
        self.store = WebAccountStore(Path(self.tmp.name) / "web.db")
        self.auth = WebAuth(self.store, domain=DOMAIN, uri=URI, allowed=None, now=lambda: self.clock[0])
        self.shop = Shop()
        self.api = wa.WebApi(self.auth, Mock(), shop=self.shop, now=lambda: self.clock[0])
        issued = self.auth.nonce(self.user.address)
        self.session = self.auth.verify(issued["message"], sign(self.user, issued["message"]))
        self.account = account_id_for(self.user.address)

    def call(self, method, path, body=None, session=None):
        session = session or self.session
        return self.api.handle(method, path, token=session["token"], csrf=session["csrfToken"],
                               body=body or {}, client="127.0.0.1", expected_account=None)

    def make_key(self, signer=None, **terms):
        _, prepared, _ = self.call("POST", "/api-keys/prepare", {"name": "my bot", **terms})
        _, made, _ = self.call("POST", "/api-keys", {"message": prepared["message"],
                                                   "signature": sign(signer or self.user, prepared["message"])})
        return made

    def ask(self, key, body=None, origin=None):
        return self.api.keys.public("POST", "/chat/completions", authorization=f"Bearer {key}", origin=origin,
                                    body=body or {"model": "claude-opus-5.5",
                                                  "messages": [{"role": "user", "content": "Hello!"}]})


class MakingKeysTests(Fixture):
    def test_a_signed_request_makes_a_key_shown_once_and_stored_as_a_hash(self):
        _, prepared, _ = self.call("POST", "/api-keys/prepare", {"name": "my bot", "dailyUsd": 2, "perRequestUsd": 0.1})
        self.assertIn("Spends up to 2 USDC a day and 0.1 USDC per request", prepared["message"])
        self.assertIn("model answers, web search (Exa) and paid data lookups", prepared["message"])
        self.assertIn("cannot move your funds or change your limits", prepared["message"])
        _, made, _ = self.call("POST", "/api-keys", {"message": prepared["message"],
                                                   "signature": sign(self.user, prepared["message"])})
        self.assertTrue(made["key"].startswith("sk_singit_"))
        self.assertEqual(made["prefix"], made["key"][:14])
        self.assertEqual((made["dailyCapUsd"], made["perRequestCapUsd"], made["state"]), (2, 0.1, "active"))
        self.assertEqual(made["expiresAt"], NOW + 90 * 86400)
        self.assertNotIn(made["key"].encode(), (Path(self.tmp.name) / "web.db").read_bytes())
        _, listed, _ = self.call("GET", "/api-keys")
        self.assertEqual([k["prefix"] for k in listed["keys"]], [made["prefix"]])
        self.assertNotIn("key", listed["keys"][0])

    def test_what_must_not_make_a_key(self):
        _, prepared, _ = self.call("POST", "/api-keys/prepare", {"name": "bot"})
        message = prepared["message"]
        cases = {
            "another wallet's signature": {"message": message, "signature": sign(Account.create(), message)},
            "an edited message": {"message": message.replace("a day", "a week"),
                                  "signature": sign(self.user, message.replace("a day", "a week"))},
            "garbage": {"message": "Nonce: nope", "signature": "0x00"},
        }
        for name, body in cases.items():
            with self.subTest(name), self.assertRaises(WebAuthError):
                self.call("POST", "/api-keys", body)
        _, again, _ = self.call("POST", "/api-keys/prepare", {"name": "bot"})
        self.clock[0] += 301  # the request expires like a sign-in
        with self.assertRaises(WebAuthError):
            self.call("POST", "/api-keys", {"message": again["message"], "signature": sign(self.user, again["message"])})

    def test_a_signed_request_makes_one_key_only(self):
        _, prepared, _ = self.call("POST", "/api-keys/prepare", {"name": "bot"})
        body = {"message": prepared["message"], "signature": sign(self.user, prepared["message"])}
        self.call("POST", "/api-keys", body)
        with self.assertRaises(WebAuthError):
            self.call("POST", "/api-keys", body)

    def test_another_account_cannot_use_my_request(self):
        _, prepared, _ = self.call("POST", "/api-keys/prepare", {"name": "bot"})
        other = Account.create()
        issued = self.auth.nonce(other.address)
        theirs = self.auth.verify(issued["message"], sign(other, issued["message"]))
        with self.assertRaises(WebAuthError):
            self.call("POST", "/api-keys", {"message": prepared["message"],
                                            "signature": sign(other, prepared["message"])}, session=theirs)

    def test_terms_are_bounded(self):
        for terms in ({"name": ""}, {"name": "<script>"}, {"name": "x", "dailyUsd": 0},
                      {"name": "x", "dailyUsd": 5, "perRequestUsd": 6}, {"name": "x", "days": 400},
                      {"name": "x", "dailyUsd": "lots"}):
            with self.subTest(terms), self.assertRaises(ValueError):
                self.call("POST", "/api-keys/prepare", terms)

    def test_revoking_ends_the_key_at_once(self):
        made = self.make_key()
        self.call("POST", "/api-keys/revoke", {"id": made["id"]})
        with self.assertRaises(ApiError) as caught:
            self.ask(made["key"])
        self.assertEqual(caught.exception.status, 401)
        _, listed, _ = self.call("GET", "/api-keys")
        self.assertEqual(listed["keys"][0]["state"], "revoked")
        with self.assertRaises(ValueError):
            self.call("POST", "/api-keys/revoke", {"id": made["id"]})

    def test_the_owner_hears_about_a_new_key(self):
        self.api.push = Mock()
        self.make_key()
        self.api.push.send.assert_called_once()
        self.assertIn("my bot", self.api.push.send.call_args.args[2])


class PublicApiTests(Fixture):
    def test_an_answer_in_openai_shape_paid_from_the_owner_within_the_key_cap(self):
        made = self.make_key(dailyUsd=1, perRequestUsd=0.2)
        status, out, headers = self.ask(made["key"])
        self.assertEqual(status, 200)
        self.assertEqual(self.shop.calls[-1], ("api-chat", self.account, {
            "model": "claude-opus-5.5", "messages": [{"role": "user", "content": "Hello!"}],
            "maxTokens": None, "limitAtomic": 200_000}))
        self.assertEqual(out["object"], "chat.completion")
        self.assertEqual(out["choices"][0]["message"], {"role": "assistant", "content": "Hello!"})
        self.assertEqual(out["usage"], {"prompt_tokens": 9, "completion_tokens": 3, "total_tokens": 12})
        self.assertEqual(out["billing"]["chargedAtomic"], 7100)
        self.assertEqual(headers["X-SingIt-Charged-Atomic"], "7100")
        _, listed, _ = self.call("GET", "/api-keys")
        self.assertEqual((listed["keys"][0]["spentTodayUsd"], listed["keys"][0]["answersToday"]), (0.0071, 1))

    def test_the_daily_cap_holds_counting_the_most_the_next_answer_may_cost(self):
        made = self.make_key(dailyUsd=0.5, perRequestUsd=0.25)
        self.store.record_key_spend(made["id"], NOW // 86400, 260_000, NOW)
        with self.assertRaises(ApiError) as caught:
            self.ask(made["key"])
        self.assertEqual((caught.exception.status, caught.exception.code), (429, "insufficient_quota"))
        self.assertEqual(self.shop.calls, [])
        self.clock[0] += 86400  # a new UTC day
        self.assertEqual(self.ask(made["key"])[0], 200)

    def test_what_is_refused_before_anything_is_bought(self):
        made = self.make_key()
        cases = {
            "no key": (lambda: self.api.keys.public("POST", "/chat/completions", authorization=None, origin=None,
                                                    body={}), 401),
            "a made-up key": (lambda: self.ask("sk_singit_" + "x" * 43), 401),
            "a browser": (lambda: self.ask(made["key"], origin="https://evil.test"), 403),
            "tools": (lambda: self.ask(made["key"], {"tools": [{}], "messages": []}), 400),
            "an unknown path": (lambda: self.api.keys.public("POST", "/embeddings", authorization=f"Bearer {made['key']}",
                                                             origin=None, body={}), 404),
        }
        for name, (attempt, status) in cases.items():
            with self.subTest(name), self.assertRaises(ApiError) as caught:
                attempt()
            self.assertEqual(caught.exception.status, status)
        self.assertEqual(self.shop.calls, [])

    def test_streaming_clients_get_the_whole_answer_as_openai_chunks(self):
        made = self.make_key()
        status, out, headers = self.ask(made["key"], {"model": "claude-opus-5.5", "stream": True,
                                                     "stream_options": {"include_usage": True},
                                                     "messages": [{"role": "user", "content": "Hello!"}]})
        self.assertEqual((status, type(out).__name__), (200, "Stream"))
        events = [line[len("data: "):] for line in out.decode().split("\n\n") if line]
        self.assertEqual(events[-1], "[DONE]")
        chunks = [json.loads(e) for e in events[:-1]]
        self.assertEqual({c["object"] for c in chunks}, {"chat.completion.chunk"})
        self.assertEqual(chunks[0]["choices"][0]["delta"], {"role": "assistant", "content": "Hello!"})
        self.assertEqual(chunks[1]["choices"][0]["finish_reason"], "stop")
        self.assertEqual(chunks[2]["usage"]["total_tokens"], 12)
        self.assertEqual(headers["X-SingIt-Charged-Atomic"], "7100")
        _, plain, _ = self.ask(made["key"], {"stream": True, "messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual(len([e for e in plain.decode().split("\n\n") if e]), 3, "usage only when asked for")

    def test_an_expired_key_stops(self):
        made = self.make_key(days=1)
        self.clock[0] += 86400 + 1
        with self.assertRaises(ApiError) as caught:
            self.ask(made["key"])
        self.assertEqual(caught.exception.status, 401)

    def test_the_gateways_refusals_keep_their_words_in_openai_shape(self):
        made = self.make_key()
        for reply, (status, code) in {
            (403, "not_enabled"): (403, "payment_not_ready"),
            (404, "model_not_found"): (404, "model_not_found"),
            (400, "refused"): (400, "refused"),
            (429, "rate_limited"): (429, "rate_limit_exceeded"),
            (503, "purchases_paused"): (503, "payments_paused"),
        }.items():
            self.shop.reply = (reply[0], {"ok": False, "error": reply[1], "text": f"why {reply[1]}"})
            with self.subTest(reply), self.assertRaises(ApiError) as caught:
                self.ask(made["key"])
            self.assertEqual((caught.exception.status, caught.exception.code), (status, code))
            self.assertEqual(caught.exception.message, f"why {reply[1]}")
        _, listed, _ = self.call("GET", "/api-keys")
        self.assertEqual(listed["keys"][0]["answersToday"], 0, "a refused answer costs the key nothing")

    def test_a_key_sends_at_most_sixty_requests_a_minute(self):
        made = self.make_key(dailyUsd=100)
        for _ in range(60):
            self.ask(made["key"])
        with self.assertRaises(ApiError) as caught:
            self.ask(made["key"])
        self.assertEqual(caught.exception.status, 429)

    def test_the_model_list(self):
        made = self.make_key()
        status, out, _ = self.api.keys.public("GET", "/models", authorization=f"Bearer {made['key']}",
                                              origin=None, body={})
        self.assertEqual((status, out["object"], out["data"][0]["id"]), (200, "list", "claude-opus-5.5"))


class PublicHttpTests(Fixture):
    """Over HTTP, the way the OpenAI SDK calls it."""

    def setUp(self):
        super().setUp()
        self.server = wa.WebServer(("127.0.0.1", 0), self.api, URI)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        self.key = self.make_key()["key"]

    def request(self, path, body=None, headers=None):
        data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        request = urllib.request.Request(self.base + path, data=data, headers={
            "Authorization": f"Bearer {self.key}", "Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:  # closed here: an unclosed one warns later, inside whichever test is running
                return error.code, json.loads(error.read())

    def test_chat_completions_and_models(self):
        long_question = "x" * 20_000  # larger than the web page's own 16 KB requests
        status, out = self.request("/chat/completions", {"model": "claude-opus-5.5",
                                                         "messages": [{"role": "user", "content": long_question}]})
        self.assertEqual((status, out["choices"][0]["message"]["content"]), (200, "Hello!"))
        self.assertEqual(self.request("/models")[1]["data"][0]["id"], "claude-opus-5.5")

    def test_streaming_over_http_is_server_sent_events(self):
        request = urllib.request.Request(self.base + "/chat/completions", data=json.dumps({
            "stream": True, "messages": [{"role": "user", "content": "Hi"}]}).encode(), headers={
            "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertEqual(response.headers.get_content_type(), "text/event-stream")
            text = response.read().decode()
        self.assertTrue(text.startswith("data: {"))
        self.assertTrue(text.endswith("data: [DONE]\n\n"))

    def test_errors_keep_openai_shape(self):
        status, out = self.request("/chat/completions", {"messages": []}, {"Authorization": "Bearer nope"})
        self.assertEqual((status, out["error"]["code"]), (401, "invalid_api_key"))
        status, out = self.request("/chat/completions", b"hi", {"Content-Type": "text/plain"})
        self.assertEqual((status, out["error"]["code"]), (415, "json_only"))


class GatewaySideTests(unittest.TestCase):
    """web_ask.api_chat and the internal "api-chat" action, with the payer mocked."""

    ACCOUNT = "wallet:0x1111111111111111111111111111111111111111"

    def setUp(self):
        self.server = SimpleNamespace(user_event_store=Mock(),
                                      allowance=SimpleNamespace(owner_lookup=lambda a: "0x1111"))
        self.gw = SimpleNamespace(_purchases_paused=lambda: False, _enforce_user_purchase_rate=Mock())
        self.pay = Mock(return_value=(7100, {"choices": [{"message": {"content": "Hi"}, "finish_reason": "length"}],
                                             "usage": {"prompt_tokens": 4, "completion_tokens": 2}}, "0x" + "a" * 64))
        for p in [patch.object(web_ask.ask_metered, "pay", self.pay), patch.object(web_internal, "_limits_from_limiter")]:
            p.start()
            self.addCleanup(p.stop)

    def test_the_callers_messages_go_unchanged_with_no_web_chat_instructions(self):
        messages = [{"role": "system", "content": "Be brief."},
                    {"role": "user", "content": [{"type": "text", "text": "Hello"}, {"type": "text", "text": "there"}]}]
        answer = web_ask.api_chat(self.server, self.gw, self.ACCOUNT, messages, web_ask.MODEL, max_tokens=50)
        sent = self.pay.call_args.args[3]
        self.assertEqual(sent["messages"], [{"role": "system", "content": "Be brief."},
                                            {"role": "user", "content": "Hello\nthere"}])
        self.assertEqual(sent["max_tokens"], 50)
        self.assertEqual((answer["text"], answer["costAtomic"], answer["finishReason"]), ("Hi", 7100, "length"))

    def test_what_is_refused_before_paying(self):
        for messages in ([], [{"role": "tool", "content": "x"}],
                         [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}]}],
                         [{"role": "user", "content": "x" * 24_001}]):
            with self.subTest(messages=str(messages)[:40]), self.assertRaises(ValueError):
                web_ask.api_chat(self.server, self.gw, self.ACCOUNT, messages, web_ask.MODEL)
        self.pay.assert_not_called()

    def test_an_answer_that_cannot_fit_the_key_cap_is_refused_unsigned(self):
        with self.assertRaises(AllowanceError):
            web_ask.api_chat(self.server, self.gw, self.ACCOUNT, [{"role": "user", "content": "Hi"}],
                             web_ask.MODEL, limit=2000)  # the default model is authorized for up to 3000
        self.pay.assert_not_called()

    def test_the_wallet_singit_ask_is_paid_to_cannot_pay_itself(self):
        from sign402_gateway import ask_solana
        with self.assertRaises(AllowanceError) as caught:
            web_ask.api_chat(self.server, self.gw, "solana:" + ask_solana.PAY_TO, [{"role": "user", "content": "Hi"}],
                             web_ask.MODEL)
        self.assertIn("cannot pay itself", str(caught.exception))

    def test_model_names(self):
        with patch.object(web_ask.ask_catalogue, "default_id", return_value="deepseek-v4.1-flash"), \
             patch.object(web_ask.ask_catalogue, "resolve", side_effect=lambda i: {"id": i} if i == "claude-opus-5.5" else None):
            self.assertEqual(web_ask.api_model(None), web_ask.MODEL)
            self.assertEqual(web_ask.api_model("singit-ask"), web_ask.MODEL)
            self.assertEqual(web_ask.api_model("deepseek-v4.1-flash"), web_ask.MODEL)
            self.assertEqual(web_ask.api_model("claude-opus-5.5"), "ask:claude-opus-5.5")
            self.assertEqual(web_ask.api_model("ask:claude-opus-5.5"), "ask:claude-opus-5.5")
            self.assertIsNone(web_ask.api_model("gpt-0"))
            self.assertIsNone(web_ask.api_model(42))

    def test_the_internal_action_refuses_an_unknown_model_and_passes_the_key_cap(self):
        with patch.object(web_ask, "api_model", return_value=None):
            status, body = web_internal.handle(self.server, "api-chat", {"account": self.ACCOUNT, "model": "gpt-0"})
        self.assertEqual((status, body["error"]), (404, "model_not_found"))
        with patch.object(web_ask, "api_model", return_value=web_ask.MODEL), \
             patch.object(web_ask, "api_chat", return_value={"ok": True}) as chat:
            web_internal.handle(self.server, "api-chat", {"account": self.ACCOUNT, "messages": [], "limitAtomic": 250_000,
                                                          "maxTokens": 99})
        self.assertEqual(chat.call_args.kwargs, {"max_tokens": 99, "limit": 250_000})


def tearDownModule():
    # Collect this module's garbage here, quietly. On Python 3.13+ an unclosed SQLite connection warns when it
    # is collected, and a warning printed in the middle of a later test that captures stderr fails that test.
    import gc
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", ResourceWarning)
        gc.collect()


if __name__ == "__main__":
    unittest.main()

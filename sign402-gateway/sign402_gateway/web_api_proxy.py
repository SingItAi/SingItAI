"""The universal /v1: any request an API key sends, relayed to Surplus Intelligence and paid from the balance.

Design: docs/singit-gateway-spec.md, section 4A, and docs/singit-balance-plan.md. One key works in the OpenAI SDK
(`/v1/chat/completions`, `/v1/responses`), the Anthropic SDK and Claude Code (`/v1/messages`), with streaming, tools
and images as the model offers them: the request goes upstream as it came, apart from the model's name, and the
answer comes back as Surplus sends it, chunk by chunk.

Money: before a request, its likely cost is held on the account's balance (web_balance.Balances), which the owner
bought in the app. A balance too low refuses the request, unless the owner switched on automatic top-ups: then it
is topped up first, from the owner's limits (the gateway's `credit-topup`). Surplus reports what each answer cost
(`usage.buyer_cost_micro`, in the body or the last streamed event); that cost plus the markup is charged and the
hold let go. A failed request costs nothing.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import threading
import urllib.error
import urllib.request
from collections import defaultdict
from typing import Any, Callable, Iterable, Iterator, Mapping

from . import ask_catalogue
from .web_balance import DEFAULT_TOPUP, MAX_TOPUP, TOPUP_STEP, Balances, new_topup_id

logger = logging.getLogger(__name__)

SURPLUS_URL = "https://api.surplusintelligence.ai"
USER_AGENT = ask_catalogue.USER_AGENT
MARKUP_BPS = 3000                 # cost + 30%, as at SingIt Ask
DEFAULT_MODEL = "deepseek-v4.1-flash"
DEFAULT_OUTPUT_TOKENS = 4096      # the answer length a request that names none is held for
CHARS_PER_TOKEN = 3               # a fair guess for the hold; the charge is what Surplus reports
UPSTREAM_SECONDS = 600            # a long answer streams for minutes
MAX_ANSWER_BYTES = 64 * 1024 * 1024
# Where each public path goes upstream, and the dialect its errors speak.
ROUTES = {
    "/chat/completions": ("/v1/chat/completions", "openai"),
    "/responses": ("/v1/responses", "openai"),
    "/messages": ("/anthropic/v1/messages", "anthropic"),
    "/messages/count_tokens": ("/anthropic/v1/messages/count_tokens", "anthropic"),
}
FREE_PATHS = {"/messages/count_tokens"}
# Web search, page contents and cited answers, bought from Exa with SingIt's key, in Exa's own format, so Exa's
# SDKs work with base URL app.singitai.app/v1/exa. Its slower, dearer endpoints (research, agents) are not offered.
EXA_URL = "https://api.exa.ai"
EXA_ROUTES = {"/exa/search": "/search", "/exa/contents": "/contents", "/exa/answer": "/answer"}
# Exa's prices (exa.ai/pricing, 16 October 2026), in micro-USD: a search of up to 10 results by type, each result
# past 10, each page of contents per kind (text, highlights, summary), an answer. They only size the hold: the
# charge is the cost Exa reports for the request (costDollars.total).
EXA_SEARCH = {"instant": 4000, "fast": 7000, "auto": 7000, "deep-lite": 12000, "deep": 12000, "deep-reasoning": 15000}
EXA_RESULT, EXA_PAGE, EXA_ANSWER = 1000, 1000, 5000
EXA_ANSWER_MODELS = ("exa", "exa-fast")
FORWARDED_HEADERS = ("anthropic-version", "anthropic-beta")
# Claude Code and the Anthropic SDK name models as Anthropic does (claude-sonnet-5-5, maybe dated); Surplus as
# claude-sonnet-5.5.
ANTHROPIC_ID = re.compile(r"(claude-(?:opus|sonnet|haiku))-(\d+)-(\d+)(?:-\d{8})?")


def charge_for(cost: int) -> int:
    """What a request that cost `cost` micro-USD upstream is charged: the cost and the markup, rounded up."""
    return cost + (cost * MARKUP_BPS + 9999) // 10000


def exa_estimate(path: str, body: Mapping[str, Any]) -> int:
    """The most an Exa request should cost, with the markup, in micro-USD. ValueError for a request outside what
    is offered here."""
    def kinds(options: Any) -> int:
        options = options if isinstance(options, dict) else {}
        return sum(1 for kind in ("text", "highlights", "summary") if options.get(kind))

    if path == "/exa/search":
        if not isinstance(body.get("query"), str) or not body["query"].strip():
            raise ValueError("Send a query.")
        kind = body.get("type", "auto")
        if kind not in EXA_SEARCH:
            raise ValueError(f"type must be one of {', '.join(EXA_SEARCH)}.")
        results = body.get("numResults", 10)
        if type(results) is not int or not 1 <= results <= 100:
            raise ValueError("numResults must be 1 to 100.")
        cost = EXA_SEARCH[kind] + max(0, results - 10) * EXA_RESULT + results * kinds(body.get("contents")) * EXA_PAGE
    elif path == "/exa/contents":
        pages = body.get("urls") or body.get("ids")
        if not isinstance(pages, list) or not 1 <= len(pages) <= 100:
            raise ValueError("Send 1 to 100 urls.")
        cost = len(pages) * max(1, kinds(body)) * EXA_PAGE
    else:
        if not isinstance(body.get("query"), str) or not body["query"].strip():
            raise ValueError("Send a query.")
        if body.get("model", "exa") not in EXA_ANSWER_MODELS:
            raise ValueError(f"model must be one of {', '.join(EXA_ANSWER_MODELS)}.")
        cost = EXA_ANSWER * 2  # the answer and the pages it reads
    return charge_for(cost)


def surplus_model(name: Any) -> str:
    if name in (None, "", "singit-ask"):
        return ask_catalogue.default_id() or DEFAULT_MODEL
    name = str(name)
    match = ANTHROPIC_ID.fullmatch(name)
    return f"{match.group(1)}-{match.group(2)}.{match.group(3)}" if match else name


def estimate(model_id: str, body: Mapping[str, Any]) -> int | None:
    """A likely cost of this request in micro-USD with the markup, from the model's list price; None when the
    model is not in the list."""
    model = ask_catalogue.resolve(model_id)
    if model is None:
        return None
    tokens = body.get("max_tokens", body.get("max_completion_tokens", body.get("max_output_tokens")))
    output = tokens if type(tokens) is int and tokens > 0 else DEFAULT_OUTPUT_TOKENS
    chars = len(json.dumps(body.get("messages") or body.get("input") or "", ensure_ascii=False))
    chars += len(json.dumps(body.get("system") or body.get("instructions") or "", ensure_ascii=False))
    chars += len(json.dumps(body.get("tools") or "", ensure_ascii=False))
    worst = -int(-(chars / CHARS_PER_TOKEN * model["input"] + output * model["output"]) // 1)
    return charge_for(worst)


# What Surplus adds to a standard answer that only tells who sold it and for how much: the seller, its cost
# breakdown and its own price field. The caller sees SingIt's charge in `billing` instead.
UPSTREAM_FIELDS = ("provider", "costDollars")
UPSTREAM_USAGE_FIELDS = ("cost", "is_byok", "cost_details", "buyer_cost_micro")


def scrub(data: Any, answer_id: str | None = None) -> Any:
    """An answer or streamed event as the standard formats have it, without Surplus's own fields. A chat
    completion's id becomes SingIt's own: Surplus's names where it was bought."""
    if not isinstance(data, dict):
        return data
    for field in UPSTREAM_FIELDS:
        data.pop(field, None)
    if isinstance(data.get("error"), dict):
        data["error"].pop("metadata", None)  # the seller's name and its raw reply, on a refusal
    for holder in (data, data.get("response"), data.get("message")):
        usage = holder.get("usage") if isinstance(holder, dict) else None
        if isinstance(usage, dict):
            for field in UPSTREAM_USAGE_FIELDS:
                usage.pop(field, None)
    if answer_id and isinstance(data.get("id"), str):
        data["id"] = answer_id
    return data


def background(work: Callable[[], None]) -> None:
    threading.Thread(target=work, daemon=True, name="balance-topup").start()


class Meter:
    """What an answer cost and used, read from its body or its events as they pass."""

    def __init__(self) -> None:
        self.cost: int | None = None
        self.input_tokens = 0
        self.output_tokens = 0

    def read(self, data: Any) -> None:
        if not isinstance(data, dict):
            return
        exa = data.get("costDollars")  # Exa: an estimate in dollars, for the whole request
        if isinstance(exa, dict) and isinstance(exa.get("total"), (int, float)) and exa["total"] >= 0:
            self.cost = -int(-exa["total"] * 1_000_000 // 1)
        for usage in (data.get("usage"), (data.get("response") or {}).get("usage") if isinstance(data.get("response"), dict) else None,
                      (data.get("message") or {}).get("usage") if isinstance(data.get("message"), dict) else None):
            if not isinstance(usage, dict):
                continue
            raw = usage.get("buyer_cost_micro")
            if type(raw) is int and raw >= 0 or isinstance(raw, str) and raw.isdigit():
                self.cost = int(raw)
            for field, names in (("input_tokens", ("prompt_tokens", "input_tokens")),
                                 ("output_tokens", ("completion_tokens", "output_tokens"))):
                for name in names:
                    if type(usage.get(name)) is int:
                        setattr(self, field, max(getattr(self, field), usage[name]))

    def event(self, line: bytes) -> dict | None:
        """One SSE line: the event's JSON when it is a data line, read for cost on the way."""
        if not line.startswith(b"data:"):
            return None
        payload = line[5:].strip()
        if not payload or payload == b"[DONE]":
            return None
        try:
            data = json.loads(payload)
        except ValueError:
            return None
        self.read(data)
        return data if isinstance(data, dict) else None


class Relay:
    """An upstream answer on its way to the client: status, headers and the body in pieces. Reading it to the end
    settles the charge, so the handler reads it all even after the client went away."""

    def __init__(self, status: int, headers: Mapping[str, str], chunks: Iterable[bytes], length: int | None = None):
        self.status, self.headers, self.chunks, self.length = status, dict(headers), chunks, length

    def __iter__(self) -> Iterator[bytes]:
        return iter(self.chunks)

    def close(self) -> None:
        close = getattr(self.chunks, "close", None)
        if close is not None:
            close()


class Upstream:
    """Surplus Intelligence, with SingIt's own buyer key."""

    def __init__(self, key: str, url: str = SURPLUS_URL, opener: Callable[..., Any] = urllib.request.urlopen):
        self.key, self.url, self.opener = key, url.rstrip("/"), opener

    def send(self, path: str, body: Mapping[str, Any], headers: Mapping[str, str]) -> Any:
        """The upstream response, open for reading; an HTTP error is returned as a response too."""
        request = urllib.request.Request(
            self.url + path, data=json.dumps(body).encode(), method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                     "Authorization": f"Bearer {self.key}", "User-Agent": USER_AGENT, **headers})
        try:
            return self.opener(request, timeout=UPSTREAM_SECONDS)
        except urllib.error.HTTPError as error:
            return error


class Proxy:
    """The paid part of /v1, for ApiKeys.public."""

    def __init__(self, keys: Any, upstream: Upstream, balances: Balances, exa: Upstream | None = None):
        self.keys, self.upstream, self.balances, self.exa = keys, upstream, balances, exa
        self._funding: dict[str, threading.Lock] = defaultdict(threading.Lock)

    # -- money --

    def fund(self, account: str, need: int, error: Callable[..., Exception]) -> None:
        """Makes sure `need` is available on the balance: topped up from the owner's limits when it is short and they
        turned automatic top-ups on, refused otherwise."""
        with self._funding[account]:
            state = self.balances.state(account)
            if state["refundRequestedAt"] is not None:
                raise error(403, "A refund of this balance was requested; it is frozen until the refund is done.",
                            type_="insufficient_quota", code="balance_frozen")
            short = need - state["availableAtomic"]
            if short <= 0:
                return
            if not state["autoTopup"]:
                raise error(402, f"Your SingIt API balance is ${max(state['availableAtomic'], 0) / 1e6:.2f}, not enough "
                            f"for this request (about ${need / 1e6:.2f}). Top it up in the SingIt app: Settings → "
                            "API keys.", type_="insufficient_quota", code="balance_low")
            amount = min(MAX_TOPUP, max(state["topupAtomic"] or DEFAULT_TOPUP, -(-short // TOPUP_STEP) * TOPUP_STEP))
            status, reply = self.keys._shop("credit-topup", account, {
                "topupId": new_topup_id(), "amountAtomic": amount, "minAtomic": short})
            if status != 200:
                text = str(reply.get("text") or "The balance could not be topped up. Nothing was paid.")[:500]
                if status == 503:
                    raise error(503, text, type_="api_error", code="payments_paused")
                if status == 403:
                    raise error(403, text, type_="insufficient_quota", code="payment_not_ready")
                raise error(402, f"Your SingIt balance is too low and could not be topped up: {text}",
                            type_="insufficient_quota", code="balance_low")
            logger.info("web api: balance of %s topped up by %s", account, reply.get("creditedAtomic"))

    def refill_later(self, account: str, balance_after: int) -> None:
        """Tops up in the background once the balance runs under its threshold, so the next request need not wait."""
        state = self.balances.state(account)
        if (not state["autoTopup"] or state["availableAtomic"] >= state["thresholdAtomic"] or state["pending"]
                or state["refundRequestedAt"]):
            return
        lock = self._funding[account]
        if lock.locked():
            return

        def work() -> None:
            try:
                self.fund(account, state["thresholdAtomic"], lambda *a, **k: RuntimeError(a[1] if len(a) > 1 else ""))
            except Exception as exc:  # noqa: BLE001 - the next request tries again and says why
                logger.info("web api: background top-up of %s did not happen (%s)", account, exc)

        background(work)

    # -- relaying --

    def relay(self, row: Any, path: str, body: Mapping[str, Any], headers: Mapping[str, str | None],
              error: Callable[..., Exception], reserve: Callable[[int], Callable[[int], None]]) -> Relay:
        request = dict(body)
        if path in EXA_ROUTES:
            return self._pay_and_relay(row, path, request, {}, error, reserve, upstream=self.exa,
                                       upstream_path=EXA_ROUTES[path], label="exa" + EXA_ROUTES[path],
                                       streaming=path == "/exa/answer" and bool(request.get("stream")))
        upstream_path, _dialect = ROUTES[path]
        model_id = surplus_model(request.get("model"))
        request["model"] = model_id
        forward = {h: str(headers[h]) for h in FORWARDED_HEADERS if headers.get(h)}
        if path in FREE_PATHS:
            response = self.upstream.send(upstream_path, request, forward)
            data = response.read(MAX_ANSWER_BYTES)
            response.close()
            return Relay(response.status, {"Content-Type": response.headers.get("Content-Type", "application/json")},
                         [data], len(data))
        streaming = bool(request.get("stream"))
        asked_usage = False
        if path == "/chat/completions":
            request.setdefault("si_route", {"objective": "price"})  # the cheapest seller, as SingIt Ask asks
            if streaming:
                options = dict(request.get("stream_options") or {}) if isinstance(request.get("stream_options"), dict) else {}
                asked_usage = bool(options.get("include_usage"))
                request["stream_options"] = {**options, "include_usage": True}  # the cost comes in the usage chunk
        return self._pay_and_relay(row, path, request, forward, error, reserve, upstream=self.upstream,
                                   upstream_path=upstream_path, label=model_id, streaming=streaming,
                                   asked_usage=asked_usage)

    def _pay_and_relay(self, row: Any, path: str, request: dict[str, Any], forward: Mapping[str, str],
                       error: Callable[..., Exception], reserve: Callable[[int], Callable[[int], None]], *,
                       upstream: Upstream, upstream_path: str, label: str, streaming: bool,
                       asked_usage: bool = False) -> Relay:
        """Holds the request's likely cost on the balance, sends it upstream and charges what it cost."""
        account, key_id, per = row["account_id"], row["key_id"], int(row["per_request_cap_atomic"])
        model_id = label
        if path in EXA_ROUTES:
            try:
                likely = exa_estimate(path, request)
            except ValueError as exc:
                raise error(400, str(exc), code="invalid_request") from None
        else:
            likely = estimate(model_id, request)
        if likely is not None and likely > per:
            raise error(400, f"This request may cost up to {likely / 1e6:.4f} USDC, above this key's limit of "
                        f"{per / 1e6:g} USDC per request. Ask for fewer tokens, or make a key with a higher limit.",
                        code="over_request_limit")
        hold = likely if likely is not None else per
        done = reserve(hold)  # the key's own daily cap, counting requests in flight
        hold_id = "hold_" + secrets.token_hex(10)
        try:
            self.fund(account, hold, error)
            if not self.balances.hold(account, hold_id, hold, int(self.keys.now())):
                self.fund(account, hold, error)  # another request took what was there
                if not self.balances.hold(account, hold_id, hold, int(self.keys.now())):
                    raise error(402, "Your SingIt balance is in use by other requests. Try again in a moment.",
                                type_="insufficient_quota", code="balance_low")
        except BaseException:
            done(0)
            raise
        try:
            response = upstream.send(upstream_path, request, forward)
        except Exception:
            self.balances.release(hold_id)
            done(0)
            raise error(502, "The service could not be reached. You were not charged.", type_="api_error",
                        code="upstream_unreachable") from None
        status = int(response.status)
        if status in (401, 402, 403):  # SingIt's own key or prepaid balance upstream, not the caller's fault
            response.close()
            self.balances.release(hold_id)
            done(0)
            logger.error("web api: %s refused SingIt's key with HTTP %s; check its key and prepaid balance",
                         "Exa" if path in EXA_ROUTES else "Surplus", status)
            raise error(503, "Answers are unavailable right now. You were not charged; try again later.",
                        type_="api_error", code="upstream_unavailable")
        meter = Meter()
        request_id = str(response.headers.get("x-request-id") or "")[:80] or None
        content_type = response.headers.get("Content-Type", "application/json")

        def settle() -> int:
            if status >= 400:
                self.balances.release(hold_id)
                done(0)
                return 0
            cost = meter.cost
            if cost is None:
                header = str(response.headers.get("x-si-buyer-cost-micro") or "")
                cost = int(header) if header.isdigit() else None
            if cost is None:  # an answer that came back without its cost is charged its hold, and logged
                logger.warning("web api: %s answered %s with no cost; charged the hold", model_id, request_id)
                charged = hold
            else:
                charged = charge_for(cost)
            after = self.balances.charge(account, hold_id, charged, int(self.keys.now()), key_id=key_id,
                                         model=model_id, ref=request_id, cost=cost, input_tokens=meter.input_tokens,
                                         output_tokens=meter.output_tokens)
            done(charged)
            self.refill_later(account, after)
            return charged

        answer_id = "chatcmpl-singit-" + secrets.token_hex(12) if path == "/chat/completions" else None
        if streaming and status < 400 and "event-stream" in content_type:
            def chunks() -> Iterator[bytes]:
                try:
                    for line in iter(response.readline, b""):
                        data = meter.event(line)
                        # A usage-only chunk the client did not ask for is dropped: some read choices[0] blindly.
                        if (data is not None and not asked_usage and path == "/chat/completions"
                                and data.get("choices") == [] and "usage" in data):
                            response.readline()  # the blank line that ends the event
                            continue
                        if data is not None:  # read for its cost above; sent on without Surplus's own fields
                            ending = b"\r\n" if line.endswith(b"\r\n") else b"\n"
                            line = b"data: " + json.dumps(scrub(data, answer_id)).encode() + ending
                        yield line
                except OSError:
                    logger.warning("web api: %s stream from upstream broke off", model_id)
                finally:
                    response.close()
                    settle()

            return Relay(status, {"Content-Type": content_type, "Cache-Control": "no-store"}, chunks())

        try:
            raw = response.read(MAX_ANSWER_BYTES)
        finally:
            response.close()
        try:
            data = json.loads(raw)
        except ValueError:
            data = None
        meter.read(data)
        charged = settle()
        if isinstance(data, dict):
            scrub(data, answer_id if status < 400 else None)
            raw = json.dumps(data).encode()
        if isinstance(data, dict) and status < 400:
            data["billing"] = {"chargedAtomic": charged, "costAtomic": meter.cost, "markupBps": MARKUP_BPS,
                               "currency": "USDC", "paidFrom": "your SingIt balance"}
            raw = json.dumps(data).encode()
        return Relay(status, {"Content-Type": "application/json" if data is not None else content_type,
                              "X-SingIt-Charged-Atomic": str(charged)}, [raw], len(raw))

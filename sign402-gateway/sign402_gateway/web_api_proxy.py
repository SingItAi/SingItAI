"""The universal /v1: any request an API key sends, relayed to Surplus Intelligence and paid from the balance.

Design: docs/singit-gateway-spec.md, section 4A, and docs/singit-balance-plan.md. One key works in the OpenAI SDK
(`/v1/chat/completions`, `/v1/responses`), the Anthropic SDK and Claude Code (`/v1/messages`), with streaming, tools
and images as the model offers them: the request goes upstream as it came, apart from the model's name, and the
answer comes back as Surplus sends it, chunk by chunk.

Money: before a request, its likely cost is held on the account's balance (web_balance.Balances), which the owner
bought in the app. A balance too low refuses the request, unless the owner switched on automatic top-ups: then it
is topped up first, from the owner's limits (the gateway's `credit-topup`). The hold counts the whole question at
the list price but at most HOLD_OUTPUT_TOKENS of answer: Claude Code asks for answers of up to 128k tokens and
rarely gets a tenth of that, and holding them all would ask a dollar or more before every request.

Surplus reports what each answer cost (`usage.buyer_cost_micro`, in the body or the last streamed event); that cost
plus the markup is charged. An answer dearer than its hold takes the rest from what is free on the balance, up to
the most the request could have cost and never past the key's limit for one request; the key's daily cap counts
that most while the request runs. What still is not covered is SingIt's loss, logged, and not a debt on the
balance. A stream that ends without its cost (Surplus's Anthropic skin reports none) is charged once the cost is
read back from Surplus's request log by the answer's `x-request-id`; the hold waits for it. A failed request costs
nothing. While the answer is being read the hold is refreshed, and the read stops after twelve minutes, so a slow
stream cannot outlive the hold and let another request spend the same deposit.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
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
HOLD_OUTPUT_TOKENS = 16_000       # the most answer a hold counts; a longer one is paid from the free balance
CHARS_PER_TOKEN = 3               # a fair guess for the hold; the charge is the reported cost
TOKEN_LIMITS = ("max_tokens", "max_completion_tokens", "max_output_tokens")
UPSTREAM_SECONDS = 600            # one socket read; idle, not the whole request
ANSWER_DEADLINE_SECONDS = 12 * 60  # the whole request, shorter than a hold's life
HOLD_TOUCH_SECONDS = 60
# A streamed answer's cost is read back from Surplus's request log after the stream; the log may lag the stream.
COST_LOOKUP_DELAYS = (1, 2, 4, 8)
COST_LOOKUP_SECONDS = 10
MAX_ANSWER_BYTES = 64 * 1024 * 1024
# Where each public path goes upstream, and the dialect its errors speak.
ROUTES = {
    "/chat/completions": ("/v1/chat/completions", "openai"),
    "/responses": ("/v1/responses", "openai"),
    "/messages": ("/anthropic/v1/messages", "anthropic"),
    "/messages/count_tokens": ("/anthropic/v1/messages/count_tokens", "anthropic"),
    "/images/generations": ("/v1/images/generations", "openai"),
    "/audio/speech": ("/v1/audio/speech", "openai"),
    "/audio/transcriptions": ("/v1/audio/transcriptions", "openai"),
}
MAX_IMAGES = 4
MEDIA_PATHS = {"/images/generations": "https://ask.singitai.app/v1/images/models",
               "/audio/speech": "https://ask.singitai.app/v1/audio/models",
               "/audio/transcriptions": "https://ask.singitai.app/v1/audio/models"}
MAX_SPEECH_CHARS = 4096
MAX_AUDIO_BYTES = 25 * 1024 * 1024  # OpenAI's own limit for a transcription
AUDIO_BITS_PER_SECOND = 32_000      # the hold counts an audio file as speech this compact; the charge is what was used
FREE_PATHS = {"/messages/count_tokens"}
FORWARDED_HEADERS = ("anthropic-version", "anthropic-beta")
# Claude Code and the Anthropic SDK name models as Anthropic does (claude-sonnet-5-5, claude-fable-5-1, maybe dated);
# Surplus as claude-sonnet-5.5.
ANTHROPIC_ID = re.compile(r"(claude-(?:opus|sonnet|haiku|fable))-(\d+)-(\d+)(?:-\d{8})?")


def charge_for(cost: int) -> int:
    """What a request that cost `cost` micro-USD upstream is charged: the cost and the markup, rounded up."""
    return cost + (cost * MARKUP_BPS + 9999) // 10000


def surplus_model(name: Any) -> str:
    if name in (None, "", "singit-ask"):
        return ask_catalogue.default_id() or DEFAULT_MODEL
    name = str(name)
    match = ANTHROPIC_ID.fullmatch(name)
    return f"{match.group(1)}-{match.group(2)}.{match.group(3)}" if match else name


class UnpricedRequest(ValueError):
    """A token limit this estimate cannot price, so it must not be forwarded."""

    def __init__(self, field: str):
        super().__init__(field)
        self.field = field


def output_tokens(body: Mapping[str, Any]) -> int:
    """The answer length the hold is built from. Every limit that is present has to be a positive integer:
    a string or a float would be forwarded as-is and billed for more than the 4096 this used to assume."""
    chosen: int | None = None
    for key in TOKEN_LIMITS:
        if key not in body or body[key] is None:
            continue
        value = body[key]
        if type(value) is not int or value <= 0:
            raise UnpricedRequest(key)
        if chosen is None:
            chosen = value
    return DEFAULT_OUTPUT_TOKENS if chosen is None else chosen


def estimate(model_id: str, body: Mapping[str, Any], answer_cap: int | None = None) -> int | None:
    """The most this request may cost in micro-USD with the markup, from the model's list price, counting at most
    `answer_cap` tokens of answer when one is given; None when the model is not in the list."""
    model = ask_catalogue.resolve(model_id)
    if model is None:
        output_tokens(body)  # still refuse a limit we would otherwise forward unpriced
        return None
    output = output_tokens(body) if answer_cap is None else min(output_tokens(body), answer_cap)
    chars = len(json.dumps(body.get("messages") or body.get("input") or "", ensure_ascii=False))
    chars += len(json.dumps(body.get("system") or body.get("instructions") or "", ensure_ascii=False))
    chars += len(json.dumps(body.get("tools") or "", ensure_ascii=False))
    worst = -int(-(chars / CHARS_PER_TOKEN * model["input"] + output * model["output"]) // 1)
    return charge_for(worst)


# What Surplus adds to a standard answer that only tells who sold it and for how much: the seller, its cost
# breakdown and its own price fields (a streamed chat's last chunk carries `cost` with the seller's own unit).
# The caller sees SingIt's charge in `billing` instead.
UPSTREAM_FIELDS = ("provider", "cost")
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


class HoldWatch:
    """Keeps one request's hold alive while its answer is still being read, and stops that read before the hold
    can be treated as forgotten."""

    def __init__(self, balances: Balances, hold_id: str, now: Callable[[], int], *, deadline: float,
                 touch_every: float = HOLD_TOUCH_SECONDS, clock: Callable[[], float] | None = None):
        self.balances = balances
        self.hold_id = hold_id
        self.now = now
        self.deadline = deadline
        self.touch_every = touch_every
        self.clock = time.monotonic if clock is None else clock
        self.stopped = False
        self.balances.touch(self.hold_id, int(self.now()))
        self._touched = self.clock()

    def keep(self) -> None:
        moment = self.clock()
        if moment >= self.deadline:
            self.stopped = True
            return
        if moment - self._touched >= self.touch_every:
            self.balances.touch(self.hold_id, int(self.now()))
            self._touched = moment


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

    def send_raw(self, path: str, data: bytes, content_type: str) -> Any:
        """A request whose body goes on as the client sent it (a file upload)."""
        request = urllib.request.Request(
            self.url + path, data=data, method="POST",
            headers={"Content-Type": content_type, "Accept": "application/json",
                     "Authorization": f"Bearer {self.key}", "User-Agent": USER_AGENT})
        try:
            return self.opener(request, timeout=UPSTREAM_SECONDS)
        except urllib.error.HTTPError as error:
            return error

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

    def request_record(self, request_id: str) -> Any:
        """One request from Surplus's request log (`GET /v1/requests/{id}`, needs `usage.read` on the key): its
        cost and token counts. None while it is not there yet or cannot be read."""
        request = urllib.request.Request(
            self.url + "/v1/requests/" + urllib.parse.quote(request_id, safe=""), method="GET",
            headers={"Accept": "application/json", "Authorization": f"Bearer {self.key}", "User-Agent": USER_AGENT})
        try:
            with self.opener(request, timeout=COST_LOOKUP_SECONDS) as response:
                return json.loads(response.read(1_000_000))
        except urllib.error.HTTPError as error:
            error.close()
            return None
        except (OSError, ValueError):
            return None


def logged_cost(record: Any, meter: Meter, depth: int = 0) -> None:
    """Reads a request-log record into `meter`: `buyer_cost_micro` and token counts, wherever in the record they
    sit (at its top, in `usage`, or one or two objects down). Nothing else is taken for a cost."""
    if not isinstance(record, dict) or depth > 2:
        return
    meter.read({"usage": record})
    for value in record.values():
        if isinstance(value, dict):
            logged_cost(value, meter, depth + 1)


def shape(record: Any, depth: int = 0) -> Any:
    """A record's field names without their values, for the log when it carries no cost."""
    if isinstance(record, dict) and depth < 2:
        return {k: shape(v, depth + 1) for k, v in record.items()}
    return type(record).__name__


class Proxy:
    """The paid part of /v1, for ApiKeys.public."""

    def __init__(self, keys: Any, upstream: Upstream, balances: Balances):
        self.keys, self.upstream, self.balances = keys, upstream, balances
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
              error: Callable[..., Exception], reserve: Callable[[int], Callable[[int], None]],
              raw: tuple[bytes, str] | None = None) -> Relay:
        """`raw` is a file upload (bytes, content type) sent on as it came; `body` then holds only its model."""
        upstream_path, _dialect = ROUTES[path]
        account, key_id, per = row["account_id"], row["key_id"], int(row["per_request_cap_atomic"])
        request = dict(body)
        if path in MEDIA_PATHS:
            model_id = request.get("model")
            if not isinstance(model_id, str) or not model_id.strip():
                raise error(400, f"Name a model: see {MEDIA_PATHS[path]}.", code="model_required")
            if path == "/images/generations" and (type(request.get("n", 1)) is not int or not 1 <= request.get("n", 1) <= MAX_IMAGES):
                raise error(400, f"n must be 1 to {MAX_IMAGES}.", code="invalid_n")
            if path == "/audio/speech" and (not isinstance(request.get("input"), str) or not request["input"].strip()
                                            or len(request["input"]) > MAX_SPEECH_CHARS):
                raise error(400, f"Send input text of up to {MAX_SPEECH_CHARS} characters.", code="invalid_input")
            if path == "/audio/transcriptions" and (raw is None or not raw[0] or len(raw[0]) > MAX_AUDIO_BYTES):
                raise error(400, "Send the audio as a multipart file upload, up to 25 MB.", code="invalid_file")
        else:
            model_id = surplus_model(request.get("model"))
        request["model"] = model_id
        try:
            output_tokens(request)
        except UnpricedRequest as exc:
            raise error(400, f"{exc.field} must be a positive integer.", code="invalid_max_tokens") from None
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
        if path in MEDIA_PATHS:
            if path == "/images/generations":
                listed, units = ask_catalogue.image_list_usd(model_id), request.get("n", 1)
            elif path == "/audio/speech":
                listed, units = ask_catalogue.speech_list_usd(model_id), len(request["input"]) / 1000
            else:
                listed, units = ask_catalogue.transcription_list_usd(model_id), len(raw[0]) * 8 / AUDIO_BITS_PER_SECOND / 60
            if listed is None:
                raise error(404, f"No such model here. See {MEDIA_PATHS[path]}.", code="model_not_found")
            likely = most = charge_for(max(1, -int(-listed * units * 1_000_000 // 1)))
        else:
            likely, most = estimate(model_id, request, HOLD_OUTPUT_TOKENS), estimate(model_id, request)
        if likely is not None and likely > per:
            raise error(400, f"This request may cost up to {likely / 1e6:.4f} USDC, above this key's limit of "
                        f"{per / 1e6:g} USDC per request. Ask for less, or make a key with a higher limit.",
                        code="over_request_limit")
        hold = likely if likely is not None else per
        ceiling = min(per, most) if most is not None else per  # the most this request is ever charged
        done = reserve(ceiling)  # the key's own daily cap, counting requests in flight
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
            response = (self.upstream.send_raw(upstream_path, *raw) if raw is not None
                        else self.upstream.send(upstream_path, request, forward))
        except Exception:
            self.balances.release(hold_id)
            done(0)
            raise error(502, "The model could not be reached. You were not charged.", type_="api_error",
                        code="upstream_unreachable") from None
        status = int(response.status)
        if status in (401, 402, 403):  # SingIt's own key or prepaid balance upstream, not the caller's fault
            response.close()
            self.balances.release(hold_id)
            done(0)
            logger.error("web api: Surplus refused SingIt's key with HTTP %s; check its key and prepaid balance", status)
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
            if meter.cost is None:
                header = str(response.headers.get("x-si-buyer-cost-micro") or "")
                meter.cost = int(header) if header.isdigit() else None  # an image's cost comes only in the header
            return charge()

        def settle_stream() -> None:
            """A stream's headers left before its cost was known, so a stream without one in its events is charged
            once Surplus's request log has it; the hold stays until then."""
            lookup = getattr(self.upstream, "request_record", None)
            if status >= 400 or meter.cost is not None or not request_id or lookup is None:
                settle()
                return

            def work() -> None:
                record = None
                try:
                    for delay in COST_LOOKUP_DELAYS:
                        time.sleep(delay)
                        record = lookup(request_id)
                        logged_cost(record, meter)
                        if meter.cost is not None:
                            break
                    if meter.cost is None:
                        logger.warning("web api: %s stream %s has no cost in the request log either; its fields: %s",
                                       model_id, request_id, json.dumps(shape(record))[:1000])
                finally:
                    settle()

            background(work)

        def charge() -> int:
            cost = meter.cost
            if cost is None:  # an answer that came back without its cost is charged its hold, and logged
                logger.warning("web api: %s answered %s with no cost; charged the hold", model_id, request_id)
                asked = hold
            else:
                asked = min(charge_for(cost), ceiling)
            charged, after = self.balances.bill(account, hold_id, asked, int(self.keys.now()),
                                                beyond_hold=ceiling - hold, key_id=key_id, model=model_id,
                                                ref=request_id, cost=cost, input_tokens=meter.input_tokens,
                                                output_tokens=meter.output_tokens)
            if cost is not None and charge_for(cost) > charged:
                logger.warning("web api: %s cost %s micro-USD; charged %s (hold %s, at most %s)",
                               model_id, cost, charged, hold, ceiling)
            done(charged)
            self.refill_later(account, after)
            return charged

        answer_id = "chatcmpl-singit-" + secrets.token_hex(12) if path == "/chat/completions" else None
        watch = HoldWatch(self.balances, hold_id, lambda: int(self.keys.now()),
                          deadline=time.monotonic() + ANSWER_DEADLINE_SECONDS)

        def stop_if_late() -> bool:
            watch.keep()
            if not watch.stopped:
                return False
            logger.warning("web api: %s answer ran past %ss; stopping", model_id, ANSWER_DEADLINE_SECONDS)
            return True

        if streaming and status < 400 and "event-stream" in content_type:
            def chunks() -> Iterator[bytes]:
                try:
                    while True:
                        if stop_if_late():
                            break
                        line = response.readline()
                        if not line:
                            break
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
                    settle_stream()

            return Relay(status, {"Content-Type": content_type, "Cache-Control": "no-store"}, chunks())

        parts: list[bytes] = []
        size = 0
        try:
            while size < MAX_ANSWER_BYTES:
                if stop_if_late():
                    break
                piece = response.read(min(64 * 1024, MAX_ANSWER_BYTES - size))
                if not piece:
                    break
                parts.append(piece)
                size += len(piece)
        finally:
            response.close()
        raw = b"".join(parts)
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

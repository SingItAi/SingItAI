import pytest

from singit.guards import DailyLimiter, SingItPaymentError, select_offer, usd_to_atomic

BASE_SEPOLIA = "eip155:84532"
ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
RESOURCE_URL = "http://127.0.0.1:1/v1/chat/completions"


def addr(suffix: str) -> str:
    return f"0x{'0' * (40 - len(suffix))}{suffix}"


PAY_TO = addr("1")
FACILITATOR = addr("2")
OTHER_ADDRESS = addr("dead")


def challenge_with(offer):
    return {"x402Version": 2, "resource": {"url": RESOURCE_URL}, "accepts": [offer]}


def offer(**overrides):
    base = {
        "scheme": "upto", "network": BASE_SEPOLIA, "asset": ASSET, "payTo": PAY_TO, "amount": "2000",
        "maxTimeoutSeconds": 120, "extra": {"facilitatorAddress": FACILITATOR},
    }
    base.update(overrides)
    return base


def opts(**overrides):
    base = {"scheme": "upto", "network_id": BASE_SEPOLIA, "family": "evm", "asset": ASSET,
            "pay_to": PAY_TO, "max_cap_atomic": "3000", "resource_url": RESOURCE_URL}
    base.update(overrides)
    return base


def test_select_offer_accepts_a_matching_upto_offer():
    selected = select_offer(challenge_with(offer()), **opts())
    assert selected["amount"] == "2000"


def test_select_offer_refuses_a_different_asset():
    with pytest.raises(SingItPaymentError):
        select_offer(challenge_with(offer(asset=OTHER_ADDRESS)), **opts())


def test_select_offer_refuses_a_different_pay_to():
    with pytest.raises(SingItPaymentError):
        select_offer(challenge_with(offer(payTo=OTHER_ADDRESS)), **opts())


def test_select_offer_refuses_an_amount_over_the_ceiling():
    with pytest.raises(SingItPaymentError, match="per-call ceiling"):
        select_offer(challenge_with(offer(amount="5000")), **opts(max_cap_atomic="3000"))


def test_select_offer_refuses_a_resource_url_for_a_different_endpoint():
    challenge = challenge_with(offer())
    challenge["resource"]["url"] = "http://evil.example/v1/chat/completions"
    with pytest.raises(SingItPaymentError, match="different resource"):
        select_offer(challenge, **opts())


def test_select_offer_refuses_a_payload_missing_the_upto_facilitator_address():
    with pytest.raises(SingItPaymentError, match="facilitator address"):
        select_offer(challenge_with(offer(extra={})), **opts())


def test_select_offer_is_case_insensitive_for_evm_addresses():
    selected = select_offer(challenge_with(offer(asset=ASSET.upper().replace("0X", "0x"))), **opts())
    assert selected["amount"] == "2000"


def test_daily_limiter_refuses_once_the_cap_is_reached():
    limiter = DailyLimiter("5000")
    release1 = limiter.reserve("3000")
    limiter.settle(release1, "3000", "3000")
    with pytest.raises(SingItPaymentError, match="Daily spend cap"):
        limiter.reserve("3000")
    release2 = limiter.reserve("2000")
    limiter.settle(release2, "2000", "2000")


def test_daily_limiter_frees_unused_headroom():
    limiter = DailyLimiter("5000")
    release = limiter.reserve("3000")
    limiter.settle(release, "1000", "3000")
    assert limiter.remaining_atomic() == 4000


def test_daily_limiter_releases_the_full_reservation_on_failure():
    limiter = DailyLimiter("5000")
    release = limiter.reserve("3000")
    release()
    assert limiter.remaining_atomic() == 5000


def test_usd_to_atomic():
    assert usd_to_atomic(0.01) == "10000"
    assert usd_to_atomic(1) == "1000000"


def test_usd_to_atomic_refuses_negative():
    with pytest.raises(SingItPaymentError):
        usd_to_atomic(-1)


def test_a_reservation_from_yesterday_never_reduces_todays_counter(monkeypatch):
    from datetime import datetime as real_datetime, timezone as tz
    from singit import guards

    now = {"t": real_datetime(2026, 10, 24, 23, 59, 59, tzinfo=tz.utc)}

    class Clock(real_datetime):
        @classmethod
        def now(cls, tz=None):
            return now["t"]

    monkeypatch.setattr(guards, "datetime", Clock)
    limiter = guards.DailyLimiter("1000")
    release = limiter.reserve("600")  # reserved just before UTC midnight
    now["t"] = real_datetime(2026, 10, 25, 0, 0, 1, tzinfo=tz.utc)
    limiter.reserve("1000")  # today's counter is full
    release()  # yesterday's release must not free today's room
    assert limiter.remaining_atomic() == 0
    limiter.settle(release, "100", "600")
    assert limiter.remaining_atomic() == 0

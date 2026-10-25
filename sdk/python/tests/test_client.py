import pytest
from eth_account import Account

from singit import SingIt, SingItPaymentError

from helpers.merchant import Merchant, decode, exact_offer, upto_offer

BASE_SEPOLIA = "eip155:84532"
USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
PAY_TO = "0x" + "0" * 39 + "1"
OTHER = "0x" + "0" * 36 + "dead"
FACILITATOR = "0x" + "0" * 39 + "2"
MESSAGES = [{"role": "user", "content": "Hello"}]


@pytest.fixture
def account():
    return Account.create()


def exact(amount="2000", **overrides):
    return exact_offer(network=BASE_SEPOLIA, asset=USDC, pay_to=overrides.pop("pay_to", PAY_TO), amount=amount, **overrides)


@pytest.fixture
def start():
    merchants = []

    def _start(offers, **kwargs):
        merchant = Merchant(lambda body: offers, **kwargs)
        merchants.append(merchant)
        return merchant

    yield _start
    for merchant in merchants:
        merchant.close()


def client(account, merchant, **overrides):
    options = {"evm_account": account, "network": "base-sepolia", "base_url": merchant.url, "app_base_url": merchant.url,
               "pay_to": PAY_TO, "max_per_call_usd": 0.01, "max_per_day_usd": 1}
    options.update(overrides)
    return SingIt(**options)


def test_exact_payment_is_signed_verified_and_answered(account, start):
    merchant = start([exact("2000")])
    answer = client(account, merchant).chat(messages=MESSAGES, scheme="exact")

    assert answer["choices"][0]["message"]["content"] == "Hello back."
    assert answer["payment"] == {"scheme": "exact", "network": "base-sepolia", "amountAtomic": "2000", "txHash": "0x" + "ab" * 32}

    assert len(merchant.payment_headers) == 1
    payload = decode(merchant.payment_headers[0])
    auth = payload["payload"]["authorization"]
    assert auth["from"].lower() == account.address.lower()
    assert auth["to"].lower() == PAY_TO.lower()
    assert auth["value"] == "2000"
    assert int(auth["validBefore"]) > int(auth["validAfter"])


def test_the_merchant_rejects_a_signature_from_a_different_key(account, start):
    # Guards the verifier itself: a tampered `from` must not pass, or the other tests prove nothing.
    from helpers.merchant import verify_exact_payload

    merchant = start([exact()])
    client(account, merchant).chat(messages=MESSAGES, scheme="exact")
    payload = decode(merchant.payment_headers[0])
    assert verify_exact_payload(payload)[0] is True
    payload["payload"]["authorization"]["from"] = Account.create().address
    assert verify_exact_payload(payload)[0] is False


def test_upto_payment_is_signed_and_billed_at_actual_usage(account, start):
    offer = upto_offer(network=BASE_SEPOLIA, asset=USDC, pay_to=PAY_TO, amount="2000", facilitator_address=FACILITATOR)
    merchant = start([offer])
    answer = client(account, merchant).chat(messages=MESSAGES, scheme="upto")

    assert answer["payment"]["scheme"] == "upto"
    assert answer["payment"]["amountAtomic"] == "1000"
    assert len(merchant.payment_headers) == 1


def test_refused_when_pay_to_differs_and_nothing_is_signed(account, start):
    merchant = start([exact(pay_to=OTHER)])
    with pytest.raises(SingItPaymentError, match="Unexpected payee"):
        client(account, merchant).chat(messages=MESSAGES, scheme="exact")
    assert merchant.payment_headers == []
    assert merchant.requests == 1


def test_refused_over_max_per_call(account, start):
    merchant = start([exact("20000")])
    with pytest.raises(SingItPaymentError, match="per-call ceiling"):
        client(account, merchant, max_per_call_usd=0.01).chat(messages=MESSAGES, scheme="exact")
    assert merchant.payment_headers == []


def test_daily_cap_applies_across_two_calls(account, start):
    merchant = start([exact("2000")])
    singit = client(account, merchant, max_per_call_usd=0.003, max_per_day_usd=0.003)

    assert singit.chat(messages=MESSAGES, scheme="exact")["payment"]["amountAtomic"] == "2000"
    with pytest.raises(SingItPaymentError, match="Daily spend cap"):
        singit.chat(messages=MESSAGES, scheme="exact")
    assert len(merchant.payment_headers) == 1


def test_an_unresolved_payment_keeps_its_reservation(account, start):
    merchant = start([exact("2000")])
    singit = client(account, merchant, max_per_call_usd=0.003, max_per_day_usd=0.003)
    merchant.bill = lambda offer: "999999"  # invoice above the ceiling: it may still have settled
    with pytest.raises(SingItPaymentError, match="invoice"):
        singit.chat(messages=MESSAGES, scheme="exact")
    assert singit.limiter.remaining_atomic() == 1000  # the 2000 ceiling stays counted


def test_a_refused_payment_frees_the_daily_reservation(account, start):
    merchant = start([exact("2000")])
    merchant.refuse = True  # HTTP 402 to the signed payment: nothing settled
    singit = client(account, merchant, max_per_call_usd=0.003, max_per_day_usd=0.003)
    with pytest.raises(SingItPaymentError, match="refused"):
        singit.chat(messages=MESSAGES, scheme="exact")
    assert singit.limiter.remaining_atomic() == 3000


def test_wallet_report_and_allowance_parse_the_mock_response(account, start):
    address = account.address
    report = {"address": address, "allowance": {"limitAtomic": "5000000", "spentTodayAtomic": "2000"}, "calls": []}
    merchant = start([exact()], routes={f"/v1/wallet/{address}/reconciliation?days=7": (200, report)})
    singit = client(account, merchant)
    assert singit.wallet_report(address, days=7) == report
    assert singit.allowance(address, days=7) == report["allowance"]


def test_wallet_report_raises_a_clear_error_on_404(account, start):
    merchant = start([exact()])
    with pytest.raises(SingItPaymentError, match=r"not available \(HTTP 404\)"):
        client(account, merchant).wallet_report(account.address)


def test_pricing_parses_the_mock_response(account, start):
    pricing = {"models": {"example": {"inputPerMTokUsd": 1.0}}}
    merchant = start([exact()], routes={"/pricing.json": (200, pricing)})
    assert client(account, merchant).pricing() == pricing


def test_pricing_raises_a_clear_error_on_404(account, start):
    merchant = start([exact()])
    with pytest.raises(SingItPaymentError, match=r"pricing.json is not available \(HTTP 404\)"):
        client(account, merchant).pricing()

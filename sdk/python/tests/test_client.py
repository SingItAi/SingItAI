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
    assert singit.wallet_report(address, days=7, api_key="sk_singit_test") == report
    assert merchant.last_get_headers.get("Authorization") == "Bearer sk_singit_test"
    assert singit.allowance(address, days=7, api_key="sk_singit_test") == report["allowance"]


def test_wallet_report_says_it_is_private_on_401(account, start):
    address = account.address
    merchant = start([exact()], routes={f"/v1/wallet/{address}/reconciliation": (401, {"error": "api_key_required"})})
    with pytest.raises(SingItPaymentError, match=r"private \(HTTP 401\).*api_key"):
        client(account, merchant).wallet_report(address)


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


def test_mismatched_receipt_keeps_full_reservation(account, start, monkeypatch):
    import singit.client as module
    from singit.guards import encode_header

    merchant = start([exact("2000")])
    singit = client(account, merchant, max_per_call_usd=0.003, max_per_day_usd=0.003)
    original = module._post_json

    def post(*args, **kwargs):
        status, headers, raw = original(*args, **kwargs)
        if status == 200:
            headers.replace_header("payment-response", encode_header({"network": "wrong-network"}))
        return status, headers, raw

    monkeypatch.setattr(module, "_post_json", post)
    with pytest.raises(SingItPaymentError, match="settlement receipt"):
        singit.chat(messages=MESSAGES, scheme="exact")
    assert singit.limiter.remaining_atomic() == 1000


@pytest.mark.parametrize("billed", ["1000", "4001"])
def test_exact_invoice_mismatch_keeps_full_authorization(account, start, billed):
    merchant = start([exact("4000")], bill=lambda offer: billed)
    singit = client(account, merchant, max_per_call_usd=0.004, max_per_day_usd=0.006)
    with pytest.raises(SingItPaymentError, match="invoice does not match.*unresolved"):
        singit.chat(messages=MESSAGES, scheme="exact")
    assert singit.limiter.remaining_atomic() == 2000
    with pytest.raises(SingItPaymentError, match="Daily spend cap"):
        singit.chat(messages=MESSAGES, scheme="exact")
    assert len(merchant.payment_headers) == 1


@pytest.mark.parametrize("scheme,billed,remaining,error", [
    ("exact", "1000", 2000, True),
    ("exact", "4000", 2000, False),
    ("exact", "4001", 2000, True),
    ("upto", "1000", 5000, False),
    ("upto", "4001", 2000, True),
])
def test_invoice_accounting_without_sockets(account, monkeypatch, scheme, billed, remaining, error):
    import json
    import singit.client as module
    from singit.guards import encode_header

    url = "http://localhost"
    offer = (exact("4000") if scheme == "exact" else upto_offer(
        network=BASE_SEPOLIA, asset=USDC, pay_to=PAY_TO, amount="4000", facilitator_address=FACILITATOR))
    paid = []

    def post(request_url, body, headers):
        if not headers:
            return 402, {"payment-required": encode_header({
                "x402Version": 2, "resource": {"url": url + "/v1/chat/completions"}, "accepts": [offer],
            })}, b"{}"
        paid.append(headers)
        return 200, {}, json.dumps({"billing": {"totalAtomic": billed}}).encode()

    monkeypatch.setattr(module, "_post_json", post)
    singit = SingIt(evm_account=account, network="base-sepolia", base_url=url, pay_to=PAY_TO,
                    max_per_call_usd=0.004, max_per_day_usd=0.006)
    if error:
        with pytest.raises(SingItPaymentError, match="invoice does not match.*unresolved"):
            singit.chat(messages=MESSAGES, scheme=scheme)
    else:
        assert singit.chat(messages=MESSAGES, scheme=scheme)["payment"]["amountAtomic"] == billed
    assert singit.limiter.remaining_atomic() == remaining
    if remaining == 2000:
        with pytest.raises(SingItPaymentError, match="Daily spend cap"):
            singit.chat(messages=MESSAGES, scheme=scheme)
    assert len(paid) == 1

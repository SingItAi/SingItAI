"""Offline audit tests: all HTTP and alert delivery use injected fakes."""
import base64
from contextlib import redirect_stdout, redirect_stderr
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.parse

SPEC = importlib.util.spec_from_file_location('model_audit', Path(__file__).parents[1] / 'singit-model-audit.py')
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def challenge(amount='1000', network='eip155:8453', scheme='upto'):
    return {'payment-required': base64.b64encode(json.dumps({'accepts': [
        {'network': network, 'scheme': scheme, 'amount': amount, 'payTo': 'REDACTED'}]}).encode()).decode()}


def operation(model='sample', maximum='0.01'):
    return {'post': {'x-payment-info': {'price': {'max': maximum}}, 'requestBody': {
        'content': {'application/json': {'example': {'model': model, 'messages': [], 'max_tokens': 600}}}}}}


class FakeService:
    def __init__(self):
        self.paths = {'/v1/chat/sample': operation()}
        self.calls = []
        self.quote = (402, challenge(), {})
        self.probe = (402, challenge('2000'), {})
        self.window = {'status': 'up', 'successes': 5}
        self.book = {'offers': [{'trusted': True, 'healthy': True, 'available': True, 'discount_pct': 50}]}
        self.free = (200, {}, {'choices': [{'message': {'content': 'hello'}}], 'billing': {'free': True, 'remainingToday': 1}})
        self.bazaar = (200, {}, {'resources': []})

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, body))
        if any(k.lower() in ('payment-signature', 'x-payment') for k in headers):
            raise AssertionError('payment header')
        host = urllib.parse.urlsplit(url).netloc
        if host not in {urllib.parse.urlsplit(b).netloc for b in audit.DEFAULTS}:
            raise AssertionError('unexpected host')
        path = urllib.parse.urlsplit(url).path
        if path == '/openapi.json':
            return 200, {}, {'paths': self.paths}
        if path == '/v1/models':
            return 200, {}, {'data': [{'id': 'sample'}, {'id': 'free/test'}]}
        if 'discovery/search' in path:
            return self.bazaar
        if path == '/health':
            return 200, {}, {'models': {'sample': self.window}}
        if '/api/markets/' in path:
            return 200, {}, self.book
        if method == 'POST' and body.get('model', '').startswith('free/'):
            return self.free
        return self.probe if method == 'GET' else self.quote


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeService()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / 'state.json'
        self.history = Path(self.tmp.name) / 'history.jsonl'
        self.sent = []
        self.network_guard = patch.object(audit.urllib.request, 'build_opener', side_effect=AssertionError('network forbidden'))
        self.network_guard.start()
        self.addCleanup(self.network_guard.stop)

    def run_audit(self, **kw):
        return audit.audit(fetch=self.fake, sleep=lambda _: None, now=lambda: 100, **kw)

    def row(self, kind='quote'):
        return next(r for r in self.run_audit()['results'] if r['kind'] == kind)

    def main(self, *flags, delivery=None):
        output = io.StringIO()
        def send(message, **kw):
            self.sent.append(message)
        with redirect_stdout(output), redirect_stderr(io.StringIO()):
            code = audit.main(['--state', str(self.state), '--append', str(self.history), *flags],
                              env={'SINGIT_ALERT_NTFY_URL': 'https://ntfy.invalid/private-topic'},
                              fetch=self.fake, sleep=lambda _: None, now=lambda: 100,
                              deliver=delivery or send)
        return code, output.getvalue()

    def test_inventory_driven_variants_and_fixed_route(self):
        self.fake.paths['/v1/new-operation'] = operation()
        self.fake.paths['/v1/responses'] = operation()
        self.assertTrue(self.row()['ok'])
        posts = [(u, b) for m, u, _, b in self.fake.calls if m == 'POST']
        self.assertEqual(sum('/v1/new-operation' in u for u, _ in posts), 1)
        bodies = [b for u, b in posts if u.endswith('/v1/responses')]
        self.assertEqual(len(bodies), 3)
        self.assertEqual([b['max_output_tokens'] for b in bodies[1:]], [400, 2000])
        self.assertEqual(bodies[0]['max_tokens'], 600)
        self.assertEqual(sum(b.get('model') == 'free/test' for _, b in posts), 1)

    def test_decode_variants_and_reject_bad_challenges(self):
        for network in ('base', 'eip155:8453'):
            for scheme in ('upto', 'exact'):
                self.assertEqual(audit.offers(402, challenge(network=network, scheme=scheme)), {'base:' + scheme: '1000'})
        raw = json.dumps({'accepts': [{'network': 'base', 'scheme': 'exact', 'maxAmountRequired': '20'},
                                    {'network': 'solana:main', 'scheme': 'upto', 'amount': '30'}]})
        self.assertEqual(audit.offers(402, {'PAYMENT-REQUIRED': raw}), {'base:exact': '20', 'solana:upto': '30'})
        for status, headers in ((200, challenge()), (402, {}), (402, {'payment-required': 'bad'}),
                                (402, challenge(network='solana:main'))):
            with self.assertRaises(ValueError):
                audit.offers(status, headers)

    def test_route_errors_and_seller_down(self):
        for response in ((422, {}, {}), (402, {}, {}), (402, challenge(network='other'), {}),
                         (503, {}, {'error': {'code': 'no_healthy_sellers'}})):
            self.fake.quote = response
            self.assertIn('error', self.row()['issues'])
        self.assertIn('seller down', self.row()['issues'])

    def test_price_mismatch_probe_and_bazaar_and_maximum(self):
        self.fake.probe = (402, challenge('999'), {})
        self.assertIn('price_mismatch', self.row()['issues'])
        self.fake.probe = (402, challenge('2000'), {})
        self.fake.bazaar = (200, {}, {'resources': [{'resource': audit.DEFAULTS[0] + '/v1/chat/sample',
                            'accepts': [{'network': 'base', 'scheme': 'upto', 'amount': '999'}]}]})
        self.assertIn('price_mismatch', self.row()['issues'])
        self.fake.paths['/v1/chat/sample'] = operation(maximum='0.0009')
        self.assertIn('above_openapi_max', self.row()['issues'])

    def test_larger_max_tokens_quote_is_not_a_price_mismatch(self):
        # A 2000-token quote is dearer than the example-sized probe by design; only the OpenAPI maximum bounds it.
        def quote(method, url, headers, body):
            if method == 'POST' and body.get('max_tokens') == 2000:
                return 402, challenge('5000'), {}
            return self.fake.quote
        base = self.fake
        self.fake = lambda m, u, h, b: quote(m, u, h, b) if m == 'POST' and '/v1/chat/sample' in u else base(m, u, h, b)
        issues = self.row()['issues']
        self.assertNotIn('price_mismatch', issues)
        self.assertNotIn('above_openapi_max', issues)

    def test_non_text_models_get_no_order_book_check(self):
        self.fake.paths['/v1/images/generations'] = operation(model='venice-image')
        report = self.run_audit()
        self.assertNotIn('book:venice-image', [r['name'] for r in report['results']])
        self.assertNotIn('health:venice-image', [r['name'] for r in report['results']])

    def test_bazaar_unreadable_is_skipped(self):
        self.fake.bazaar = (503, {}, None)
        self.assertTrue(self.row('bazaar')['skipped'])
        self.assertEqual(self.main()[0], 0)

    def test_health_outcomes_and_reasoning_counter(self):
        for status in ('down', 'degraded', 'unavailable'):
            self.fake.window = {'status': status, 'reasoning422': 2, 'retryAfterSeconds': 90}
            row = self.row('health')
            self.assertEqual(row['issues'], ['seller down', 'reasoning422'])
            self.assertEqual(row['retryAfterSeconds'], 90)
            self.assertEqual(row['signal'], 'health outcome window')
        self.fake.window = {'status': 'insufficient_data', 'successes': 0, 'failures': 2}
        self.assertIn('seller down', self.row('health')['issues'])
        self.fake.window = {}
        self.assertTrue(self.row('health')['skipped'])

    def test_no_sellers_uses_shared_filter(self):
        self.fake.book = {'offers': [{'trusted': False, 'healthy': True, 'available': True, 'discount_pct': 90}]}
        self.assertEqual(self.row('book')['issues'], ['no_sellers'])
        self.assertIn('unverified', self.row('book')['signal'])

    def test_free_canary_pass_fail_skip(self):
        self.assertTrue(self.row('free')['ok'])
        for response in ((422, {}, {}), (200, {}, {'billing': {'free': True}}), (200, {}, {'choices': []})):
            self.fake.free = response
            self.assertEqual(self.row('free')['issues'], ['free_canary_failed'])
        for code in ('free_tier_exhausted', 'free_budget_exhausted', 'free_tier_busy'):
            self.fake.free = (429, {}, {'error': {'code': code}})
            self.assertTrue(self.row('free')['skipped'])
        self.fake.calls.clear()
        self.run_audit(no_free_canary=True)
        self.assertFalse(any(b and b.get('model') == 'free/test' for _, _, _, b in self.fake.calls))

    def test_change_only_three_runs_and_recovery(self):
        self.fake.quote = (422, {}, {})
        self.assertEqual(self.main()[0], 2)
        self.main()
        self.assertEqual(len(self.sent), 1)
        self.fake.quote = (402, challenge(), {})
        self.assertEqual(self.main()[0], 0)
        self.assertEqual(len(self.sent), 2)
        self.assertIn('Recovered:', self.sent[-1])

    def test_dry_run_no_writes_or_delivery(self):
        self.fake.quote = (422, {}, {})
        self.main('--dry-run')
        self.assertFalse(self.state.exists())
        self.assertFalse(self.history.exists())
        self.assertEqual(self.sent, [])

    def test_delivery_failure_preserves_previous_state(self):
        self.main()
        before = self.state.read_bytes()
        self.fake.quote = (422, {}, {})
        self.main(delivery=lambda *a, **kw: 'failed')
        self.assertEqual(self.state.read_bytes(), before)
        self.main()
        self.assertEqual(len(self.sent), 1)

    def test_exit_codes_and_unreadable_inventory(self):
        self.assertEqual(self.main()[0], 0)
        original = self.fake
        def broken(method, url, headers, body):
            if url.endswith('/openapi.json'):
                return 500, {}, None
            return original(method, url, headers, body)
        self.fake = broken
        self.assertEqual(self.main()[0], 2)
        self.assertEqual(self.main('--strict')[0], 3)
        self.assertEqual(self.main('--unknown')[0], 1)
        self.assertEqual(self.main('--ask-url', 'invalid')[0], 1)

    def test_request_cap_and_post_pause(self):
        self.fake.paths = {f'/v1/fixed/{n}': operation() for n in range(200)}
        pauses = []
        report = audit.audit(fetch=self.fake, sleep=pauses.append)
        self.assertLessEqual(len(self.fake.calls), audit.REQUEST_CAP)
        self.assertTrue(any(not r['ok'] for r in report['results']))
        self.assertTrue(pauses)
        self.assertEqual(set(pauses), {0.2})

    def test_report_and_history_do_not_contain_sensitive_data(self):
        _, output = self.main()
        report = json.loads(output)
        for text in (output, self.history.read_text(), audit.render_report(report), self.state.read_text(), *self.sent):
            self.assertNotIn('0x', text.lower())
            self.assertNotIn('ntfy.invalid', text)
            self.assertNotIn('Say hi', text)
            self.assertNotIn('REDACTED', text)

    def test_all_calls_have_only_allowlisted_hosts_and_no_payment_headers(self):
        self.main()
        allowed = {urllib.parse.urlsplit(base).netloc for base in audit.DEFAULTS}
        for _, url, headers, _ in self.fake.calls:
            self.assertIn(urllib.parse.urlsplit(url).netloc, allowed)
            self.assertTrue({'payment-signature', 'x-payment'}.isdisjoint(k.lower() for k in headers))

    def test_service_free_list_is_deduplicated(self):
        original = self.fake
        def service(method, url, headers, body):
            status, response_headers, data = original(method, url, headers, body)
            if url.endswith('/v1/models'):
                data['free'] = {'models': ['free/test', 'free/extra', 'free/extra']}
            return status, response_headers, data
        self.fake = service
        report = self.run_audit()
        self.assertEqual(sum(r['kind'] == 'free' for r in report['results']), 2)
        calls = [b['model'] for m, _, _, b in original.calls if m == 'POST' and b.get('model', '').startswith('free/')]
        self.assertCountEqual(calls, ['free/test', 'free/extra'])

    def test_exception_messages_and_health_fields_are_not_reflected(self):
        original = self.fake
        def service(method, url, headers, body):
            if method == 'POST' and body.get('model') == 'sample':
                raise OSError('https://ntfy.invalid/private-topic')
            return original(method, url, headers, body)
        original.window['reasoning422'] = 'https://ntfy.invalid/private-topic'
        original.window['retryAfterSeconds'] = 'private-topic'
        self.fake = service
        _, output = self.main()
        self.assertNotIn('private-topic', output)

    def test_no_redirects(self):
        self.assertIsNone(audit.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://outside.invalid'))


if __name__ == '__main__':
    unittest.main()

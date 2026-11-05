"""Offline key readiness checks: only a loopback HTTP server, never real keys."""
import contextlib
import http.server
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import importlib.util

SCRIPT = Path(__file__).resolve().parents[1] / 'singit-key-path-check.py'
SPEC = importlib.util.spec_from_file_location('key_check', SCRIPT)
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)
KEY = 'sk_singit_test_secret_123'


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.mode = ''
        self.target = 0
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.reply()

            def do_POST(self):
                self.reply()

            def reply(self):
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or '{}')
                outer.requests.append((self.path, body))
                index = len(outer.requests)
                status, data, headers = 200, {}, {}
                if index == 1:
                    status, data = 401, {'error': {'message': 'invalid', 'type': 'auth', 'code': 'invalid_api_key'}}
                elif self.path == '/v1/models':
                    data = {'data': [] if outer.mode == 'no_free' else [{'id': 'free/test'}]}
                elif self.path == '/v1/balance':
                    data = {'availableUsd': 1, 'balanceUsd': 1}
                    if outer.mode == 'balance' and index > 4:
                        data['balanceUsd'] = 0.9
                elif self.path.startswith('/v1/usage'):
                    data = {'totalUsd': 0.2 if outer.mode == 'usage' and index > 4 else 0.1}
                elif body.get('tools'):
                    status, data = 400, {'error': {'code': 'tools_unsupported', 'message': 'Use x402 /v1/messages'}}
                    if index == 9 and outer.mode in ('paid_ok', 'paid_cap'):
                        status, data = 200, {'choices': [{'message': {'content': 'OK'}}], 'billing': {'chargedAtomic': 1000 if outer.mode == 'paid_ok' else 50001}}
                    if outer.mode == 'guidance':
                        data['error']['message'] = 'unavailable'
                else:
                    data = {'choices': [{'message': {'content': 'OK'}}], 'usage': {'total_tokens': 2}, 'billing': {'chargedAtomic': 0}}
                    if outer.mode == 'charge':
                        data['billing']['chargedAtomic'] = 1
                    if outer.mode == 'header_charge':
                        headers['X-SingIt-Charged-Atomic'] = '1'
                    if outer.mode == 'bad_usage':
                        data['usage'] = {'total_tokens': 'two'}
                    if outer.mode == 'bad_billing':
                        data['billing'] = []
                    if outer.mode in ('limited', 'limited_echo'):
                        status, data = 429, {'error': {'code': 'free_limit_reached'}}
                        headers['Retry-After'] = KEY if outer.mode == 'limited_echo' else '123'
                if index == outer.target:
                    if outer.mode == 'status':
                        status = 403
                    elif outer.mode == '5xx':
                        status = 503
                    elif outer.mode == 'echo':
                        status, data = 500, {'error': {'message': 'Bearer ' + KEY}}
                raw = b'not json' if outer.mode == 'malformed' and index == outer.target else json.dumps(data).encode()
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(raw)

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def run_probe(self, *args, key=KEY, paid_ok=None):
        env = dict(os.environ)
        for name in ('SINGIT_KEY_CHECK_API_KEY', 'SINGIT_KEY_CHECK_PAID_OK', 'CI'):
            env.pop(name, None)
        if key is not None:
            env['SINGIT_KEY_CHECK_API_KEY'] = key
        if paid_ok:
            env['SINGIT_KEY_CHECK_PAID_OK'] = paid_ok
        return subprocess.run([sys.executable, str(SCRIPT), '--base-url', f'http://127.0.0.1:{self.server.server_port}/v1', '--report', '--write', str(self.root / 'report.json'), '--append', str(self.root / 'history.jsonl'), *args], env=env, capture_output=True, text=True, timeout=15)

    def assert_run(self, code, count=8, **kwargs):
        result = self.run_probe(**kwargs)
        self.assertEqual(result.returncode, code, result.stderr + result.stdout)
        self.assertEqual(len(self.requests), count)
        return result

    def test_green(self):
        self.assert_run(0)
        self.assertEqual(json.loads((self.root / 'report.json').read_text())['result'], 'green')

    def test_failures_at_each_request(self):
        for mode in ('status', 'malformed', '5xx'):
            for target in range(1, 9):
                with self.subTest(mode=mode, target=target):
                    self.requests.clear()
                    self.mode, self.target = mode, target
                    self.assert_run(2, 6 if mode == 'malformed' and target == 2 else 8)

    def test_charge_balance_usage_guidance(self):
        for mode in ('charge', 'header_charge', 'balance', 'usage', 'guidance', 'bad_usage', 'bad_billing'):
            with self.subTest(mode=mode):
                self.requests.clear()
                self.mode = mode
                self.assert_run(2)

    def test_limited(self):
        self.mode = 'limited'
        self.assert_run(3)
        self.assertIn('123', (self.root / 'report.json').read_text())

    def test_no_free(self):
        self.mode = 'no_free'
        self.assert_run(3, 6)

    def test_missing_key(self):
        result = self.assert_run(1, 0, key=None)
        self.assertIn('SINGIT_KEY_CHECK_API_KEY is required', result.stderr)

    def test_redaction_in_all_outputs(self):
        self.mode, self.target = 'echo', 5
        result = self.assert_run(2)
        for text in (result.stdout, result.stderr, (self.root / 'report.json').read_text(), (self.root / 'history.jsonl').read_text()):
            self.assertNotIn(KEY, text)
        self.assertEqual(check.redact('Bearer ' + KEY + ' sk_singit_another', KEY), '[redacted] [redacted]')
        self.requests.clear()
        self.mode = 'limited_echo'
        result = self.assert_run(3)
        for text in (result.stdout, result.stderr, (self.root / 'report.json').read_text(), (self.root / 'history.jsonl').read_text()):
            self.assertNotIn(KEY, text)
        self.assertIn('[redacted]', result.stdout)
        self.assertIn('[redacted]', (self.root / 'report.json').read_text())

        # A response header is the only arbitrary upstream detail we retain.
        with patch.object(check, 'streak', side_effect=ValueError('Bearer ' + KEY)), patch.dict(os.environ, {'SINGIT_KEY_CHECK_API_KEY': KEY}):
            output = io.StringIO()
            with contextlib.redirect_stderr(output):
                self.assertEqual(check.main(['--streak', 'unused']), 1)
            self.assertNotIn(KEY, output.getvalue())

    def test_paid_opt_ins(self):
        for args, ok in ((['--paid-tools', '--paid-model', 'test'], None), (['--paid-tools'], 'yes')):
            result = self.run_probe(*args, paid_ok=ok)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(len(self.requests), 0)
        # Environment alone does not enable the paid request.
        self.assert_run(0, paid_ok='yes')
        self.requests.clear()
        result = self.run_probe('--paid-tools', '--paid-model', 'test', '--max-spend-usd', '0.06', paid_ok='yes')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.requests, [])

    def test_paid_cap_and_refusal(self):
        for mode, code in (('', 0), ('paid_ok', 0), ('paid_cap', 2)):
            self.requests.clear()
            self.mode = mode
            result = self.run_probe('--paid-tools', '--paid-model', 'test', '--max-spend-usd', '0.05', paid_ok='yes')
            self.assertEqual(result.returncode, code, result.stdout)
            self.assertEqual(len(self.requests), 9)
            self.assertLessEqual(self.requests[-1][1]['max_tokens'], 64)

    def test_streak(self):
        path = self.root / 'days.jsonl'
        entries = [('2026-11-01T01:00:00+00:00', 'green'), ('2026-11-02T01:00:00+00:00', 'broken'), ('2026-11-02T02:00:00+00:00', 'green'), ('2026-11-03T01:00:00+00:00', 'green'), ('2026-11-04T01:00:00+00:00', 'green')]
        path.write_text(''.join(json.dumps({'timestamp': stamp, 'result': result}) + '\n' for stamp, result in entries))
        result = self.run_probe('--streak', str(path), key=None)
        self.assertEqual(result.returncode, 0)
        self.assertIn('2 consecutive UTC days', result.stdout)
        self.assertEqual(self.requests, [])
        path.write_text(json.dumps({'timestamp': '2026-11-06T00:00:00Z', 'result': 'incomplete'}) + '\n')
        self.assertEqual(check.streak(path), 0)
        path.write_text(''.join(json.dumps({'timestamp': stamp, 'result': 'green'}) + '\n' for stamp in ('2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z')))
        self.assertEqual(check.streak(path), 1)
        path.write_text('')
        self.assertEqual(check.streak(path), 0)


class TransportTests(unittest.TestCase):
    def test_timeout_single_request_and_fake_auth(self):
        response = io.BytesIO(b'{"error":{"message":"invalid","type":"auth","code":"bad"}}')
        response.code = 401
        response.headers = {}
        opener = unittest.mock.Mock()
        opener.open.return_value = response
        with patch.object(check.urllib.request, 'build_opener', return_value=opener):
            status, _, _ = check.fetch('http://127.0.0.1:1234/v1', '/chat/completions', 'sk_singit_readiness_probe_invalid', {})
        self.assertEqual(status, 401)
        opener.open.assert_called_once()
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header('Authorization'), 'Bearer sk_singit_readiness_probe_invalid')
        self.assertEqual(opener.open.call_args.kwargs['timeout'], 10)
        self.assertIsNone(check.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://invalid.test'))

    def test_http_error_body_is_decoded_without_retry(self):
        import urllib.error
        opener = unittest.mock.Mock()
        opener.open.side_effect = urllib.error.HTTPError('http://127.0.0.1', 500, '', {}, io.BytesIO(json.dumps({'error': {'message': KEY}}).encode()))
        with patch.object(check.urllib.request, 'build_opener', return_value=opener):
            status, _, data = check.fetch('http://127.0.0.1', '/v1/models', KEY)
        self.assertEqual(status, 500)
        self.assertEqual(data['error']['message'], KEY)
        opener.open.assert_called_once()


if __name__ == '__main__':
    unittest.main()

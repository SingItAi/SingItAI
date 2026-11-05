#!/usr/bin/env python3
"""Zero-spend API-key readiness probe (Python 3.12 standard library).

    SINGIT_KEY_CHECK_API_KEY=... python3 scripts/singit-key-path-check.py --report
    python3 scripts/singit-key-path-check.py --streak history.jsonl

Exit: 0 green, 2 broken, 3 incomplete (skipped/limited), 1 usage/crash.
Paid tools needs the owner's explicit OK, BOTH --paid-tools and
SINGIT_KEY_CHECK_PAID_OK=yes, and an explicit --paid-model. Never use in CI.
Eight requests per complete run, nine with paid tools; no redirects or retries.
The cap is checked after payment and cannot prevent upstream overspending.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

TOOLS = [{"type": "function", "function": {"name": "x", "parameters": {"type": "object", "properties": {}}}}]


def redact(value, key):
    text = str(value)
    if key:
        text = text.replace('Bearer ' + key, '[redacted]').replace(key, '[redacted]')
    return re.sub(r'sk_singit_[A-Za-z0-9_-]+', '[redacted]', text)


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(base, path, key, body=None):
    request = urllib.request.Request(base + path, headers={
        'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'},
        data=json.dumps(body).encode() if body is not None else None)
    try:
        response = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=10)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError('response too large')
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeError):
            data = None
        return response.code, {k.lower(): v for k, v in response.headers.items()}, data


def streak(path):
    days = {}
    for line in Path(path).read_text().splitlines():
        entry = json.loads(line)
        stamp = dt.datetime.fromisoformat(entry['timestamp'].replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError('history timestamps must include UTC offset')
        day = stamp.astimezone(dt.timezone.utc).date()
        days[day] = days.get(day, True) and entry['result'] == 'green'
    day = max(days) if days else None
    count = 0
    while day is not None and days.get(day, False):
        count += 1
        day -= dt.timedelta(days=1)
    return count


def charges(data, headers):
    billing = data.get('billing', {}) if isinstance(data, dict) else {}
    if not isinstance(billing, dict):
        raise ValueError('Invalid billing')
    atomic = billing.get('chargedAtomic', 0)
    header = float(headers.get('x-singit-charged-atomic', 0))
    if not number(atomic) or atomic < 0 or not number(header) or header < 0:
        raise ValueError('Invalid charge')
    return max(atomic, header)


def probe(args, key):
    checks = []

    def add(name, ok, status, detail):
        checks.append(dict(name=name, ok=ok, status=status, detail=detail))

    def call(name, path, body=None, auth=None):
        try:
            return fetch(args.base_url, path, auth or key, body)
        except Exception:
            # Never reflect upstream bodies, prompts, answers, or exception URLs.
            add(name, False, 'error', 'Request failed')
            return 0, {}, None

    def checked(name, status, valid, detail='Response validated'):
        if status:
            add(name, bool(valid), status, detail if valid else 'Unexpected status or response shape')

    body = {'messages': [{'role': 'user', 'content': 'Reply with the word OK.'}], 'max_tokens': 32}
    s, h, d = call('unauth_shape', '/chat/completions', body, 'sk_singit_readiness_probe_invalid')
    e = d.get('error') if isinstance(d, dict) else None
    checked('unauth_shape', s, s == 401 and isinstance(e, dict) and all(isinstance(e.get(k), str) for k in ('message', 'type', 'code')))
    s, h, d = call('models', '/models')
    models = d.get('data') if isinstance(d, dict) else None
    free = next((m['id'] for m in models if isinstance(m, dict) and isinstance(m.get('id'), str) and m['id'].startswith('free/')), None) if isinstance(models, list) else None
    checked('models', s, s == 200 and isinstance(models, list), 'free models present: ' + str(bool(free)))

    def balance(name):
        s, h, d = call(name, '/balance')
        valid = s == 200 and isinstance(d, dict) and all(number(d.get(k)) for k in ('availableUsd', 'balanceUsd'))
        checked(name, s, valid, {k: d[k] for k in ('availableUsd', 'balanceUsd')} if valid else '')
        return (d['availableUsd'], d['balanceUsd']) if valid else None

    def usage(name):
        s, h, d = call(name, '/usage?days=1')
        valid = s == 200 and isinstance(d, dict) and number(d.get('totalUsd'))
        checked(name, s, valid, {'totalUsd': d['totalUsd']} if valid else '')
        return d['totalUsd'] if valid else None

    before = balance('balance_before')
    used = usage('usage_before')
    model = args.free_model or free
    if not model:
        for name in ('free_chat', 'free_tools_refusal'):
            add(name, None, 'skipped', 'No free model available')
    else:
        request = dict(body, model=model)
        s, h, d = call('free_chat', '/chat/completions', request)
        try:
            no_charge = charges(d, h) == 0
        except (ValueError, TypeError):
            no_charge = False
        if s == 429 and no_charge and isinstance(d, dict) and isinstance(d.get('error'), dict) and d['error'].get('code') == 'free_limit_reached':
            add('free_chat', None, 'limited', {'retry_after': h.get('retry-after', '')})
        else:
            try:
                message = d['choices'][0]['message']
                valid = isinstance(message, dict) and (isinstance(message.get('content'), str) or 'content' in message and message['content'] is None or isinstance(message.get('reasoning'), str))
                valid = valid and isinstance(d['usage'], dict) and bool(d['usage']) and all(number(v) for v in d['usage'].values())
            except (KeyError, TypeError, IndexError):
                valid = False
            checked('free_chat', s, s == 200 and valid and no_charge)
        s, h, d = call('free_tools_refusal', '/chat/completions', dict(request, tools=TOOLS))
        e = d.get('error', {}) if isinstance(d, dict) else {}
        checked('free_tools_refusal', s, s == 400 and isinstance(e, dict) and e.get('code') == 'tools_unsupported' and '/v1/messages' in str(e.get('message', '')))
    after = balance('balance_after')
    if before is not None and after is not None and before != after:
        add('balance_unchanged', False, 'changed', 'Balance changed during zero-spend checks')
    else:
        add('balance_unchanged', before is not None and after is not None, 'compared', 'Balance comparison')
    used_after = usage('usage_after')
    add('usage_unchanged', used is not None and used_after is not None and used_after <= used, 'compared', 'Usage must not rise during zero-spend checks')
    if args.paid_tools:
        s, h, d = call('paid_tools', '/chat/completions', dict(body, model=args.paid_model, tools=TOOLS))
        try:
            charge = charges(d, h)
            billing = d.get('billing', {}) if isinstance(d, dict) else {}
            cap_ok = 'chargedAtomic' in billing and charge / 1e6 <= args.max_spend_usd
            message = d['choices'][0]['message'] if s == 200 else None
            accepted = s == 200 and isinstance(message, dict) and (isinstance(message.get('content'), str) or isinstance(message.get('tool_calls'), list)) and cap_ok
            refused = s == 400 and d['error']['code'] == 'tools_unsupported' and charge == 0
        except (TypeError, KeyError, IndexError, ValueError):
            accepted = refused = False
        checked('paid_tools', s, accepted or refused, 'accepted' if accepted else 'tools_unsupported' if refused else 'PAID CALL FAILED: invalid response or spend cap exceeded')
        if s and not (accepted or refused):
            checks[-1]['detail'] = 'PAID CALL FAILED: invalid response or spend cap exceeded'
    result = 'broken' if any(c['ok'] is False for c in checks) else 'incomplete' if any(c['ok'] is None for c in checks) else 'green'
    return {'version': 1, 'generated_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'base_url': args.base_url, 'result': result, 'checks': checks}


def main(argv=None):
    key = os.environ.get('SINGIT_KEY_CHECK_API_KEY', '')
    class SafeParser(argparse.ArgumentParser):
        def _print_message(self, message, file=None):
            if message:
                super()._print_message(redact(message, key), file)

    parser = SafeParser(description=__doc__)
    parser.add_argument('--base-url', default=os.environ.get('SINGIT_API_BASE', 'https://app.singitai.app/v1'))
    parser.add_argument('--free-model')
    parser.add_argument('--paid-tools', action='store_true', help="Paid; needs the owner's explicit OK. Never use in CI.")
    parser.add_argument('--paid-model')
    parser.add_argument('--max-spend-usd', type=float, default=0.05)
    parser.add_argument('--report', action='store_true')
    parser.add_argument('--write')
    parser.add_argument('--append')
    parser.add_argument('--streak')
    try:
        try:
            args = parser.parse_args(argv)
        except SystemExit as exc:
            return 0 if exc.code == 0 else 1
        if args.streak:
            print(redact(str(streak(args.streak)) + ' consecutive UTC days', key))
            return 0
        if not key:
            raise ValueError('SINGIT_KEY_CHECK_API_KEY is required')
        if args.paid_tools and (os.environ.get('SINGIT_KEY_CHECK_PAID_OK') != 'yes' or not args.paid_model or os.environ.get('CI')):
            raise ValueError("Paid tools needs the owner's explicit OK: --paid-tools, --paid-model and SINGIT_KEY_CHECK_PAID_OK=yes; forbidden in CI")
        if not number(args.max_spend_usd) or not 0 < args.max_spend_usd <= 0.05:
            raise ValueError('--max-spend-usd must be positive and <= 0.05')
        if args.free_model and not args.free_model.startswith('free/'):
            raise ValueError('--free-model must start with free/')
        parsed = urllib.parse.urlsplit(args.base_url)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Invalid base URL')
        args.base_url = args.base_url.rstrip('/')
        report = probe(args, key)
        serialized = redact(json.dumps(report, indent=2), key)
        if args.write:
            Path(args.write).write_text(serialized + '\n')
        if args.append:
            entry = {'timestamp': report['generated_at'], 'result': report['result'], 'checks': {c['name']: c['ok'] for c in report['checks']}}
            with Path(args.append).open('a') as stream:
                stream.write(redact(json.dumps(entry), key) + '\n')
        if args.report:
            print(redact('Result: ' + report['result'] + '\n\n| Check | OK | Status | Detail |\n|---|---|---|---|', key))
            for c in report['checks']:
                print(redact('| {name} | {ok} | {status} | {detail} |'.format(**c), key))
        return {'green': 0, 'broken': 2, 'incomplete': 3}[report['result']]
    except Exception as exc:
        print(redact('Key path check: ' + str(exc), key), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Daily read-only model audit (Python 3.12, standard library only).

Inventory comes from OpenAPI and /v1/models. Paid routes receive unpaid quote
requests only; free models receive at most one answer request per run.
No payment header, credentials, prompts, answers or addresses enter the report.

    python3 scripts/singit-model-audit.py --dry-run --report
    python3 scripts/singit-model-audit.py --append history.jsonl

Alerts reuse singit-health-alert.py and its SINGIT_ALERT_* delivery environment.
State: $SINGIT_AUDIT_STATE or ~/.local/state/singit/model-audit-state.json.
--dry-run sends no alert and writes neither state nor history (probes still run).
Exit: 0 clear, 2 broken, 3 unreadable inventory with --strict, 1 crash/usage.
Quotes and order books cannot prove a paid answer; /health outcomes are primary.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import importlib.util
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal, InvalidOperation
from pathlib import Path

_spec = importlib.util.spec_from_file_location('model_audit_health', Path(__file__).with_name('singit-health-alert.py'))
health = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(health)
DEFAULTS = ('https://ask.singitai.app', 'https://api.cdp.coinbase.com', 'https://api.surplusintelligence.ai')
REQUEST_CAP = 150


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(method, url, headers, body):
    """Network seam: (status, headers, decoded JSON). Never follows redirects."""
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                     headers=headers, method=method)
    try:
        response = urllib.request.build_opener(NoRedirect()).open(request, timeout=15)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError('response too large')
        try:
            data = json.loads(raw)
        except ValueError:
            data = None
        return response.code, dict(response.headers), data


def safe(value):
    """Identifiers only, never reflect arbitrary server error bodies or URLs."""
    value = str(value)
    if not re.fullmatch(r'[A-Za-z0-9_./:{}-]{1,200}', value) or '0x' in value.lower() or '://' in value or re.search(r'[A-Za-z0-9]{32,}', value):
        return '[redacted]'
    return value


def offers(status, headers):
    if status != 402:
        raise ValueError('not_402')
    headers = {k.lower(): v for k, v in headers.items()}
    raw = headers.get('payment-required', headers.get('x-payment-required'))
    if not raw:
        raise ValueError('missing_payment_required')
    challenge = None
    for candidate in (raw,):
        try:
            challenge = json.loads(candidate)
        except (ValueError, TypeError):
            try:
                challenge = json.loads(base64.b64decode(candidate, validate=True))
            except (ValueError, TypeError):
                pass
    if not isinstance(challenge, dict) or not isinstance(challenge.get('accepts'), list):
        raise ValueError('invalid_payment_required')
    result = {}
    for offer in challenge['accepts']:
        if not isinstance(offer, dict):
            continue
        network, scheme = offer.get('network', ''), offer.get('scheme')
        network = 'base' if network in ('base', 'eip155:8453') else 'solana' if str(network).startswith('solana:') or network == 'solana' else None
        amount = str(offer.get('amount', offer.get('maxAmountRequired', '')))
        if network and scheme in ('upto', 'exact') and re.fullmatch(r'\d{1,40}', amount):
            key = network + ':' + scheme
            result[key] = str(max(int(amount), int(result.get(key, '0'))))
    if not any(k.startswith('base:') for k in result):
        raise ValueError('no_base_offer')
    return result


def error_code(exc):
    # Only our fixed validation reasons may be reflected; network exceptions can contain URLs.
    reasons = {'request_cap', 'host_not_allowed', 'not_402', 'missing_payment_required',
               'invalid_payment_required', 'no_base_offer', 'invalid_status'}
    return str(exc) if type(exc) is ValueError and str(exc) in reasons else 'probe_unreadable'


def count_value(value):
    return value if type(value) is int and 0 <= value <= 10**12 else 0


def exceeds(actual, listed):
    # A listing is a snapshot: ignore drift of a hundredth or a few micro-USDC, flag a real gap.
    return any(k in listed and int(v) > int(listed[k]) * 1.01 + 5 for k, v in actual.items())


def audit(*, fetch=fetch, ask_url=DEFAULTS[0], bazaar_url=DEFAULTS[1], surplus_url=DEFAULTS[2],
          no_free_canary=False, sleep=time.sleep, now=time.time, blocked=None):
    bases = [u.rstrip('/') for u in (ask_url, bazaar_url, surplus_url)]
    for base in bases:
        p = urllib.parse.urlsplit(base)
        if p.scheme not in ('http', 'https') or not p.netloc or p.username or p.password or p.query or p.fragment:
            raise ValueError('invalid base URL')
    allowed = {urllib.parse.urlsplit(u).netloc for u in bases}
    count, last_post = 0, None
    results = []

    def add(kind, target, issues=(), *, skipped=False, **details):
        row = dict(name=f'{kind}:{safe(target)}', route=safe(target), kind=kind,
                   ok=not issues, once=True, skipped=skipped, issues=list(issues), **details)
        row['message'] = json.dumps({k: v for k, v in row.items() if k not in ('name', 'message', 'once')}, sort_keys=True)
        results.append(row)
        return row

    def request(method, base, path, body=None):
        nonlocal count, last_post
        url = base + path
        p = urllib.parse.urlsplit(url)
        if p.netloc not in allowed or not path.startswith('/') or path.startswith('//') or '#' in path:
            raise ValueError('host_not_allowed')
        if count >= REQUEST_CAP:
            raise ValueError('request_cap')
        count += 1
        if method == 'POST':
            if last_post is not None:
                sleep(0.2)
            last_post = True
        status, headers, data = fetch(method, url, {'Accept': 'application/json', 'Content-Type': 'application/json',
                                                  'User-Agent': 'SingIt-ModelAudit/1.0'}, body)
        if type(status) is not int:
            raise ValueError('invalid_status')
        return status, headers, data

    def get(base, path):
        status, _, data = request('GET', base, path)
        if status != 200 or not isinstance(data, dict):
            raise ValueError('unreadable')
        return data

    ask, bazaar, surplus = bases
    try:
        spec = get(ask, '/openapi.json')
        models = get(ask, '/v1/models')
        if not isinstance(spec.get('paths'), dict) or not isinstance(models.get('data'), list):
            raise ValueError('invalid inventory')
    except Exception:
        add('inventory', 'inventory', ['inventory_unreadable'])
        return dict(at=now(), results=results, requests=count, inventory_unreadable=True)
    add('inventory', 'inventory')
    ids = {m['id'] for m in models['data'] if isinstance(m, dict) and isinstance(m.get('id'), str)}
    free = {m for m in ids if m.startswith('free/')}
    for source in (models, spec):
        free.update(m for m in (source.get('free') or {}).get('models', []) if isinstance(m, str) and m.startswith('free/'))
    try:
        bazaar_data = get(bazaar, '/platform/v2/x402/discovery/search?query=singit')
        listings = {}
        def walk(item):
            if isinstance(item, dict):
                resource = item.get('resource')
                if isinstance(resource, dict):
                    resource = resource.get('url')
                if isinstance(resource, str) and isinstance(item.get('accepts'), list):
                    p = urllib.parse.urlsplit(resource)
                    if p.netloc == urllib.parse.urlsplit(ask).netloc:
                        listings[p.path] = offers(402, {'payment-required': json.dumps(item)})
                for child in item.values():
                    walk(child)
            elif isinstance(item, list):
                for child in item:
                    walk(child)
        walk(bazaar_data)
        add('bazaar', 'discovery', skipped=not listings)
    except Exception:
        listings = {}
        add('bazaar', 'discovery', skipped=True)
    pinned = set()
    for path, operations in spec['paths'].items():
        for method, op in operations.items():
            if not isinstance(op, dict) or 'x-payment-info' not in op:
                continue
            for m in op.get('x-free-models', []):
                value = m.get('id') if isinstance(m, dict) else m
                if isinstance(value, str) and value.startswith('free/'):
                    free.add(value)
            if method.lower() != 'post':
                add('quote', path, ['error'], status='unsupported_method')
                continue
            content = op.get('requestBody', {}).get('content', {}).get('application/json', {})
            example = content.get('example')
            if example is None:
                examples = content.get('examples', {})
                example = next((v.get('value') for v in examples.values() if isinstance(v, dict)), None)
            if not isinstance(example, dict):
                add('quote', path, ['error'], status='missing_example')
                continue
            model = example.get('model')
            if path.startswith('/v1/chat/') and path != '/v1/chat/completions':
                model = path[len('/v1/chat/'):]
            chat = path.startswith('/v1/chat/') or path in ('/v1/messages', '/v1/responses')
            # Only text models are sold from Surplus's order books; image and speech models are not.
            if chat and isinstance(model, str) and not model.startswith('free/'):
                pinned.add(model)
                ids.add(model)
            variants = [('example', example)]
            if chat:
                field = 'max_output_tokens' if path == '/v1/responses' else 'max_tokens'
                variants += [(str(n), {**example, field: n}) for n in (400, 2000)]
            probe, quotes, issues, statuses, errors = {}, {}, [], {}, {}
            try:
                status, headers, _ = request('GET', ask, path)
                probe = offers(status, headers)
            except Exception as exc:
                issues.append('error')
                errors['probe'] = error_code(exc)
            for label, body in variants:
                try:
                    status, headers, data = request('POST', ask, path, body)
                    statuses[label] = status
                    code = (data.get('error') or {}) if isinstance(data, dict) else {}
                    code = code.get('code') if isinstance(code, dict) else code
                    if status == 503 and code == 'no_healthy_sellers':
                        issues.append('seller down')
                    quotes[label] = offers(status, headers)
                except Exception as exc:
                    issues.append('error')
                    errors[label] = error_code(exc)
            # A listing prices the route's own example; a larger max_tokens is quoted higher on purpose, so only the
            # example-sized quotes must stay within the probe/listing (2000 is checked against the OpenAPI maximum).
            if any(exceeds(quotes.get(k, {}), probe) for k in ('example', '400')) or exceeds(quotes.get('example', {}), listings.get(path, {})):
                issues.append('price_mismatch')
            maximum = op['x-payment-info'].get('price', {}).get('max')
            try:
                ceiling = Decimal(str(maximum)) * 1_000_000
                if any(Decimal(v) > ceiling for v in quotes.get('2000', {}).values()):
                    issues.append('above_openapi_max')
            except (InvalidOperation, TypeError):
                issues.append('error')
            add('quote', path, sorted(set(issues)), status=statuses, errors=errors, quotes=quotes, probe=probe,
                listed=listings.get(path, {}), openapi_max=str(maximum) if re.fullmatch(r'\d+(\.\d+)?', str(maximum)) else None)
    try:
        health_data = get(ask, '/health')
        windows = health_data.get('models', {})
        for model in sorted(ids - free):
            window = windows.get(model, {})
            issues = []
            if window.get('status') in ('down', 'unavailable', 'degraded') or (window.get('successes') == 0 and count_value(window.get('failures')) >= 2):
                issues.append('seller down')
            if count_value(window.get('reasoning422')):
                issues.append('reasoning422')
            add('health', model, issues, skipped=not window, signal='health outcome window',
                status=safe(window.get('status', 'unverified')), reasoning422=count_value(window.get('reasoning422')),
                retryAfterSeconds=count_value(window.get('retryAfterSeconds')) if 'retryAfterSeconds' in window else None)
    except Exception:
        add('health', 'health', ['error'], signal='health outcome window')
    for model in sorted(pinned):
        try:
            book = get(surplus, '/api/markets/' + urllib.parse.quote(model, safe=''))
            missing = health.cheapest_trusted_share(book, blocked or set()) is None
            add('book', model, ['no_sellers'] if missing else [], signal='order book only; paid liveness unverified')
        except Exception:
            add('book', model, ['error'], signal='order book unreadable')
    for model in sorted(free):
        if no_free_canary:
            add('free', model, skipped=True)
            continue
        try:
            status, _, data = request('POST', ask, '/v1/chat/completions', {
                'model': model, 'max_tokens': 400, 'messages': [{'role': 'user', 'content': 'Say hi in five words.'}]})
            data = data if isinstance(data, dict) else {}
            code = data.get('error', {})
            code = code.get('code') if isinstance(code, dict) else code
            skipped = status == 429 and code in ('free_tier_exhausted', 'free_budget_exhausted', 'free_tier_busy')
            billing = data.get('billing') or {}
            text = any(isinstance(c.get('message', {}).get('content'), str) and c['message']['content'].strip()
                       for c in data.get('choices', []) if isinstance(c, dict))
            ok = status == 200 and text and billing.get('free') is True and 'remainingToday' in billing
            add('free', model, [] if ok or skipped else ['free_canary_failed'], skipped=skipped, status=status)
        except Exception:
            add('free', model, ['free_canary_failed'])
    return dict(at=now(), results=results, requests=count, inventory_unreadable=False)


def render_report(report):
    lines = ['| Route / model | Check | Status | Quote example / 2000 | Listing / probe | Issue / signal |',
             '|---|---|---|---|---|---|']
    for row in report['results']:
        quotes = row.get('quotes', {})
        values = (row['route'], row['kind'], 'skipped' if row['skipped'] else 'ok' if row['ok'] else 'broken',
                  json.dumps([quotes.get('example'), quotes.get('2000')]),
                  json.dumps([row.get('listed'), row.get('probe')]),
                  ', '.join(row['issues']) + ' ' + row.get('signal', ''))
        lines.append('| ' + ' | '.join(str(v).replace('|', '\\|') for v in values) + ' |')
    return '\n'.join(lines)


def main(argv=None, *, env=None, fetch=fetch, sleep=time.sleep, now=time.time, deliver=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for name, default in zip(('ask', 'bazaar', 'surplus'), DEFAULTS):
        parser.add_argument('--' + name + '-url', default=default)
    for flag in ('no-free-canary', 'strict', 'dry-run', 'report'):
        parser.add_argument('--' + flag, action='store_true')
    parser.add_argument('--append')
    parser.add_argument('--state')
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 1
    env = os.environ if env is None else env
    try:
        report = audit(fetch=fetch, sleep=sleep, now=now, ask_url=args.ask_url, bazaar_url=args.bazaar_url,
                       surplus_url=args.surplus_url, no_free_canary=args.no_free_canary,
                       blocked={s.strip().lower() for s in env.get('SINGIT_ALERT_BLOCKED_PROVIDERS', '').split(',') if s.strip()})
        path = Path(args.state or env.get('SINGIT_AUDIT_STATE') or '~/.local/state/singit/model-audit-state.json').expanduser()
        alerts, recovered, state = health.triage(report['results'], health.load_state(path), now=now(), repeat_seconds=0)
        message = health.format_message(alerts, recovered)
        if not args.dry_run:
            note = None
            channels = (env.get(health.TELEGRAM_TOKEN_ENV) and env.get(health.TELEGRAM_CHAT_ENV)) or env.get(health.NTFY_URL_ENV) \
                or env.get(health.WEBHOOK_URL_ENV)
            if message and not channels and deliver is None:
                # Nowhere to send it: keep stdout a single JSON report, put the alert in the journal (stderr), and keep
                # the transition pending so configuring a channel later still announces what is broken.
                print(message, file=sys.stderr)
                note = 'no alert channel configured'
            elif message:
                # deliver's no-channel fallback prints text; keep stdout a single JSON report.
                with contextlib.redirect_stdout(io.StringIO()):
                    note = (deliver or health.deliver)(message, env=env, timeout=15)
            if note:
                report['delivery'] = (note if isinstance(note, str) else 'failed') + '; previous state retained'
            else:
                health.save_state(path, state)
            if args.append:
                history = Path(args.append).expanduser()
                history.parent.mkdir(parents=True, exist_ok=True)
                with history.open('a') as stream:
                    stream.write(json.dumps(report) + '\n')
        print(render_report(report) if args.report else json.dumps(report))
        if args.strict and report['inventory_unreadable']:
            return 3
        return 2 if any(not r['ok'] for r in report['results']) else 0
    except Exception:
        print('model audit failed', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

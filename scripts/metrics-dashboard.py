#!/usr/bin/env python3
"""A static operator dashboard from the daily JSON files `daily-metrics.py --out DIR` writes.

Reads DIR/YYYY-MM-DD.json for the last N days (default 30, ending at the newest file) and writes ONE
self-contained HTML file: inline CSS, inline SVG sparklines, no external script, font or image, and no
JavaScript at all. Missing or null figures show as "—", never 0; a day with no file is a gap in the
sparkline and "—" in the tables.

    python scripts/metrics-dashboard.py                       # ~/.sign402/metrics -> ~/.sign402/metrics/dashboard.html
    python scripts/metrics-dashboard.py --dir DIR --days 14 --out /tmp/dashboard.html

OPERATOR ONLY. This is a local file for the operator to open over ssh/scp. It is never served on a public
route, and it must not be put behind the web app or the landing page: serving it, behind auth, is a later
owner decision (see docs/analytics.md). It carries only the aggregates daily-metrics.py already prints (no
address, account id, key, uid or tool argument), and every value is also scrubbed for 0x-addresses on
the way out.

Suggested cron (NOT installed; daily-metrics.py runs at 00:10 Europe/Prague, this a few minutes later):

    # 15 0 * * *  cd /opt/singit && python3 scripts/metrics-dashboard.py >/dev/null
"""

from __future__ import annotations

import argparse
import datetime
import decimal
import html
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable

DEFAULT_DIR = "~/.sign402/metrics"
DEFAULT_OUT = "~/.sign402/metrics/dashboard.html"
DEFAULT_DAYS = 30
DASH = "—"
DAY_FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.json$")
ADDRESS_RE = re.compile(r"0x[0-9a-fA-F]{40}")

Report = dict[str, Any]


# -- reading ---------------------------------------------------------------------------------------

def load_reports(directory: Path, days: int) -> tuple[list[datetime.date], dict[datetime.date, Report], list[str]]:
    """(the calendar window, the reports found in it, notes on files that were skipped)."""
    found: dict[datetime.date, Report] = {}
    notes: list[str] = []
    if directory.is_dir():
        for path in sorted(directory.iterdir()):
            match = DAY_FILE_RE.match(path.name)
            if not match:
                continue
            try:
                day = datetime.date.fromisoformat(match.group(1))
                data = json.loads(path.read_text())
            except (ValueError, OSError):
                notes.append(f"skipped {path.name}: not readable JSON")
                continue
            if isinstance(data, dict):
                found[day] = data
            else:
                notes.append(f"skipped {path.name}: not a report")
    if not found:
        return [], {}, notes
    last = max(found)
    window = [last - datetime.timedelta(days=offset) for offset in range(max(1, days) - 1, -1, -1)]
    return window, {day: found[day] for day in window if day in found}, notes


def dig(report: Report | None, *path: str) -> Any:
    """report[path[0]][path[1]]... or None at the first missing, null or non-dict step."""
    value: Any = report
    for key in path:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


# -- values: every one is a number, a decimal or None ------------------------------------------------

def number(value: Any) -> decimal.Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        out = decimal.Decimal(str(value))
    except decimal.InvalidOperation:
        return None
    return out if out.is_finite() else None


def total_of(*values: Any) -> decimal.Decimal | None:
    """A sum that is None only when every part is missing (one chain missing is not a zero total)."""
    parts = [n for n in map(number, values) if n is not None]
    return sum(parts, decimal.Decimal(0)) if parts else None


def count_total(mapping: Any) -> decimal.Decimal | None:
    return total_of(*mapping.values()) if isinstance(mapping, dict) and mapping else None


def fmt_int(value: decimal.Decimal | None) -> str:
    return DASH if value is None else f"{int(value):,}"


def fmt_usd(value: decimal.Decimal | None) -> str:
    if value is None:
        return DASH
    text = f"{value:,.6f}".rstrip("0")
    whole, _, frac = text.partition(".")
    return f"${whole}.{frac.ljust(2, '0')}"


def fmt_ms(value: decimal.Decimal | None) -> str:
    return DASH if value is None else f"{int(value):,} ms"


class Metric:
    """One row: a label, how to read it from a day's report, and how to print it."""

    def __init__(self, label: str, read: Callable[[Report], decimal.Decimal | None], fmt: Callable = fmt_int,
                 *, summed: bool = True, note: str = ""):
        self.label, self.read, self.fmt, self.summed, self.note = label, read, fmt, summed, note

    def series(self, window: list[datetime.date], reports: dict[datetime.date, Report]) -> list[decimal.Decimal | None]:
        return [self.read(reports[day]) if day in reports else None for day in window]


def _n(*path: str) -> Callable[[Report], decimal.Decimal | None]:
    return lambda report: number(dig(report, *path))


def _sum_of(*paths: tuple[str, ...]) -> Callable[[Report], decimal.Decimal | None]:
    return lambda report: total_of(*(dig(report, *path) for path in paths))


def _purchases(report: Report) -> decimal.Decimal | None:
    return count_total(dig(report, "purchases"))


SECTIONS: list[tuple[str, list[Metric]]] = [
    ("Wallets", [
        Metric("New accounts (Base + Solana)", _sum_of(("new_accounts", "base"), ("new_accounts", "solana"))),
        Metric("Signed in", _n("signed_in_today")),
        Metric("Active spenders", _n("active_spenders")),
        Metric("First purchases", _n("first_purchases")),
    ]),
    ("Transactions and purchases", [
        Metric("Purchases (all categories)", _purchases),
        Metric("Repeat buyers", _n("repeat_buyers")),
        Metric("Failed operations", _n("errors", "ops_failed")),
    ]),
    ("Revenue", [
        Metric("USDC volume, Base", _n("usdc_volume", "base"), fmt_usd),
        Metric("USDC volume, Solana", _n("usdc_volume", "solana"), fmt_usd),
        Metric("Chat answers", _n("chat_answers")),
        Metric("Chat answers paid", _n("chat_cost_usd"), fmt_usd),
        Metric("Credit top-ups credited", _n("topups_credited_usd"), fmt_usd),
        Metric("Margin", _n("revenue", "margin"), fmt_usd,
               note="Not recorded: most stores keep what was paid, not what it cost us."),
        Metric("Margin, API-key balance lane only", _n("revenue", "balance_lane", "margin_usd"), fmt_usd,
               note="Charges that carry a provider cost only."),
    ]),
    ("Active API keys", [
        Metric("Keys with a billed call", _n("api_keys", "active"),
               note="Free-tool calls are not counted: only billed calls touch a key's usage row."),
        Metric("Keys created", _n("api_keys", "created")),
    ]),
    ("MCP calls", [
        Metric("Calls", _n("mcp", "calls_total")),
        Metric("Paid calls", _n("mcp", "paid_calls")),
        Metric("Charged", _n("mcp", "cost_usd"), fmt_usd),
        Metric("Distinct users", _n("mcp", "distinct_uids"), summed=False),
        Metric("Latency p50", _n("mcp", "latency_ms", "p50"), fmt_ms, summed=False),
        Metric("Latency p95", _n("mcp", "latency_ms", "p95"), fmt_ms, summed=False),
    ]),
]


# -- drawing -----------------------------------------------------------------------------------------

def esc(value: Any) -> str:
    """HTML-escaped text with any 0x-address replaced: the page must never carry one."""
    return html.escape(ADDRESS_RE.sub(DASH, str(value)), quote=True)


def sparkline(values: list[decimal.Decimal | None], width: int = 160, height: int = 28) -> str:
    """An inline SVG polyline; a missing day breaks the line instead of dropping to zero."""
    known = [v for v in values if v is not None]
    label = "no data" if not known else f"trend over {len(values)} days"
    if not known:
        return f'<svg class="spark" width="{width}" height="{height}" role="img" aria-label="{label}"></svg>'
    low, high = min(known), max(known)
    span = (high - low) or decimal.Decimal(1)
    pad, step = 3, (width - 6) / max(1, len(values) - 1)

    def point(index: int, value: decimal.Decimal) -> str:
        y = height - pad - float((value - low) / span) * (height - 2 * pad) if high != low else height / 2
        return f"{pad + index * step:.1f},{y:.1f}"

    runs: list[list[str]] = [[]]
    for index, value in enumerate(values):
        if value is None:
            if runs[-1]:
                runs.append([])
        else:
            runs[-1].append(point(index, value))
    shapes = []
    for run in runs:
        if len(run) == 1:
            x, y = run[0].split(",")
            shapes.append(f'<circle cx="{x}" cy="{y}" r="1.8"/>')
        elif run:
            shapes.append(f'<polyline fill="none" stroke-width="1.5" points="{" ".join(run)}"/>')
    return (f'<svg class="spark" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" '
            f'aria-label="{label}">{"".join(shapes)}</svg>')


def _summary_table(metrics: list[Metric], window: list[datetime.date], reports: dict[datetime.date, Report]) -> str:
    rows = []
    for metric in metrics:
        values = metric.series(window, reports)
        latest = next((v for v in reversed(values) if v is not None), None)
        known = [v for v in values if v is not None]
        total = fmt_total = DASH
        if metric.summed and known:
            total = metric.fmt(sum(known, decimal.Decimal(0)))
            fmt_total = f'{total} <span class="ash">({len(known)} of {len(values)} days)</span>'
        else:
            fmt_total = DASH
        note = f'<div class="ash small">{esc(metric.note)}</div>' if metric.note and not known else ""
        rows.append(f"<tr><th scope=\"row\">{esc(metric.label)}{note}</th><td>{sparkline(values)}</td>"
                    f"<td class=\"num\">{esc(metric.fmt(latest))}</td><td class=\"num\">{fmt_total}</td></tr>")
    return ("<table><thead><tr><th>Metric</th><th>Trend</th><th class=\"num\">Latest</th>"
            "<th class=\"num\">Window total</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table>")


def _day_table(metrics: list[Metric], window: list[datetime.date], reports: dict[datetime.date, Report]) -> str:
    head = "".join(f'<th class="num">{esc(m.label)}</th>' for m in metrics)
    body = []
    for day in reversed(window):
        cells = "".join(f'<td class="num">{esc(m.fmt(m.read(reports[day]) if day in reports else None))}</td>'
                        for m in metrics)
        body.append(f'<tr><th scope="row">{day.isoformat()}</th>{cells}</tr>')
    return (f'<details><summary>Day by day</summary><div class="scroll"><table><thead><tr><th>Day</th>{head}</tr>'
            f'</thead><tbody>{"".join(body)}</tbody></table></div></details>')


def _mcp_breakdown(window: list[datetime.date], reports: dict[datetime.date, Report]) -> str:
    """MCP calls by tool and by status, summed over the window; "—" when no day carried an mcp section."""
    sections = []
    for title, key in (("By tool", "by_tool"), ("By status", "by_status")):
        totals: dict[str, int] = {}
        seen = False
        for report in reports.values():
            counts = dig(report, "mcp", key)
            if isinstance(counts, dict):
                seen = True
                for name, count in counts.items():
                    value = number(count)
                    if value is not None:
                        totals[str(name)] = totals.get(str(name), 0) + int(value)
        if not seen:
            rows = f'<tr><td>{DASH}</td><td class="num">{DASH}</td></tr>'
        else:
            rows = "".join(f'<tr><th scope="row">{esc(name)}</th><td class="num">{count:,}</td></tr>'
                           for name, count in sorted(totals.items(), key=lambda item: (-item[1], item[0]))) \
                or f'<tr><td>{DASH}</td><td class="num">{DASH}</td></tr>'
        sections.append(f'<div><h3>{title}</h3><table><thead><tr><th>{title.split()[1].capitalize()}</th>'
                        f'<th class="num">Calls</th></tr></thead><tbody>{rows}</tbody></table></div>')
    return '<div class="pair">' + "".join(sections) + "</div>"


CSS = """
:root{--ink:#0c0a08;--ash:#6d6c6b;--bone:#f4f2f0;--paper:#fff;--hair:#e5e7eb}
*{box-sizing:border-box}
body{margin:0;background:var(--bone);color:var(--ink);font:400 16px/1.5 Inter,system-ui,-apple-system,"Segoe UI",
Roboto,sans-serif;font-feature-settings:"ss01"}
main{max-width:1200px;margin:0 auto;padding:48px 24px 64px}
h1{font-weight:400;font-size:40px;line-height:1.05;margin:0 0 8px}
h2{font-weight:400;font-size:24px;line-height:1.17;margin:0 0 16px}
h3{font-weight:400;font-size:16px;margin:16px 0 8px;color:var(--ash)}
p{margin:0 0 8px}.ash{color:var(--ash)}.small{font-size:13px}
section{background:var(--paper);border:1px solid var(--hair);border-radius:16px;padding:24px;margin:24px 0}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:8px 12px 8px 0;border-bottom:1px solid var(--hair);font-weight:400;vertical-align:middle}
thead th{font-size:13px;color:var(--ash);letter-spacing:.05em;text-transform:uppercase}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.spark{display:block}.spark polyline{stroke:var(--ink)}.spark circle{fill:var(--ink)}
.scroll{overflow-x:auto}.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}
details{margin-top:16px}summary{cursor:pointer;color:var(--ash)}
"""


def render(window: list[datetime.date], reports: dict[datetime.date, Report], notes: list[str],
           generated: str = "") -> str:
    if not window:
        body = '<section><p>No daily reports found. Run <code>scripts/daily-metrics.py --out DIR</code> first.</p></section>'
        span = DASH
    else:
        span = f"{window[0].isoformat()} to {window[-1].isoformat()}"
        parts = []
        for title, metrics in SECTIONS:
            extra = _mcp_breakdown(window, reports) if title == "MCP calls" else ""
            parts.append(f"<section><h2>{esc(title)}</h2>{_summary_table(metrics, window, reports)}{extra}"
                         f"{_day_table(metrics, window, reports)}</section>")
        body = "".join(parts)
    present = f"{len(reports)} of {len(window)} days have a report" if window else "no reports"
    note_html = "".join(f'<p class="ash small">{esc(n)}</p>' for n in notes)
    margin_note = next((dig(r, "revenue", "margin_note") for r in reversed(list(reports.values()))
                        if dig(r, "revenue", "margin_note")), None)
    margin_html = f'<p class="ash small">Margin: {esc(margin_note)}</p>' if margin_note else ""
    stamp = f" Generated {esc(generated)}." if generated else ""
    return ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            "<meta name=\"robots\" content=\"noindex,nofollow\"><title>SingIt metrics</title>"
            f"<style>{CSS}</style></head><body><main><h1>SingIt metrics</h1>"
            f"<p class=\"ash\">Operator only: a local file, never served publicly. Days: {esc(span)} "
            f"({esc(present)}). Days are Europe/Prague; a dash means not recorded, not zero.{stamp}</p>"
            f"{note_html}{margin_html}{body}</main></body></html>\n")


# -- command line ------------------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", default=None, help=f"daily-metrics.py's --out directory (default {DEFAULT_DIR})")
    parser.add_argument("--days", type=int, default=DEFAULT_DAYS, help=f"last N days (default {DEFAULT_DAYS})")
    parser.add_argument("--out", default=None, help=f"the HTML file to write (default {DEFAULT_OUT})")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.days < 1:
        raise SystemExit("metrics-dashboard: --days must be at least 1")
    directory = Path(args.dir or DEFAULT_DIR).expanduser()
    out = Path(args.out or DEFAULT_OUT).expanduser()
    window, reports, notes = load_reports(directory, args.days)
    generated = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    page = render(window, reports, notes, generated)
    out.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # operator-only, not world-readable
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        os.fchmod(handle.fileno(), 0o600)  # os.open's mode only applies to a new file; tighten an older one too
        handle.write(page)
    print(f"wrote {out} ({len(reports)} of {len(window)} days)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

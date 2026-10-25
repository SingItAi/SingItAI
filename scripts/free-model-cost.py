#!/usr/bin/env python3
"""What a free answer can cost, per model, from a saved `/v1/models` JSON file.

Offline and read-only: it reads the file it is given and prints. Per model it shows the worst-case cost of
one free answer (the question at its longest, `--max-chars` characters at 4 characters per token, and the
answer at its longest, `--max-tokens`), once at the list price (`data[].usdPerMillionTokens`) and once at the
expected price (`data[].expectedUsdPerMillionTokens`), then the month's cost if the global daily cap is
used up every day (`--caps`, `--days` per month).

    python scripts/free-model-cost.py docs/data/singit-models-2026-10-24.json
    python scripts/free-model-cost.py MODELS.json --models deepseek-v4.1-flash,qwen3.7-flash --caps 100,300,1000
    python scripts/free-model-cost.py MODELS.json --json

A model that is not in the file, or has no price, is reported as such and never given a number. A price of 0
is printed as 0: the file says "no cost recorded", which is not a promise that the answer is free.
"""

from __future__ import annotations

import argparse
import json
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

DEFAULT_MODELS = (
    "deepseek-v4.1-flash",
    "openai-gpt-oss-20b",
    "qwen3.7-flash",
    "glm-5.3-flash",
    "mistral-small-3.2-24b-instruct",
)
DEFAULT_CAPS = (100, 300, 1000)
DEFAULT_MAX_CHARS = 4000
DEFAULT_MAX_TOKENS = 400
DEFAULT_DAYS = 30
CHARS_PER_TOKEN = 4  # the same bound singit-ask's pricing uses for an input it has not counted
MILLION = Decimal(1_000_000)


def load_models(path: str | Path) -> dict[str, dict[str, Any]]:
    """`data[]` of a /v1/models file by id. Prices stay exact decimals, not floats."""
    document = json.loads(Path(path).read_text(encoding="utf-8"), parse_float=Decimal)
    data = document.get("data") if isinstance(document, dict) else None
    if not isinstance(data, list):
        raise ValueError(f"{path}: no data[] list; is this a /v1/models response?")
    return {m["id"]: m for m in data if isinstance(m, dict) and isinstance(m.get("id"), str)}


def _price(raw: Any) -> tuple[Decimal, Decimal] | None:
    """(input, output) USD per million tokens, or None when the entry has no usable price."""
    if not isinstance(raw, dict):
        return None
    prices = []
    for key in ("input", "output"):
        value = raw.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)) or value < 0:
            return None
        prices.append(Decimal(str(value)))
    return prices[0], prices[1]


def answer_cost(price: tuple[Decimal, Decimal] | None, max_chars: int, max_tokens: int) -> Decimal | None:
    """Worst-case USD of one answer: max_chars/4 input tokens plus max_tokens output tokens."""
    if price is None:
        return None
    input_tokens = Decimal(max_chars) / CHARS_PER_TOKEN
    return (input_tokens * price[0] + Decimal(max_tokens) * price[1]) / MILLION


def report(models: dict[str, dict[str, Any]], wanted: list[str], *, max_chars: int, max_tokens: int,
           caps: list[int], days: int) -> list[dict[str, Any]]:
    rows = []
    for model_id in wanted:
        entry = models.get(model_id)
        row: dict[str, Any] = {"model": model_id, "found": entry is not None}
        for kind, field in (("list", "usdPerMillionTokens"), ("expected", "expectedUsdPerMillionTokens")):
            price = _price(entry.get(field)) if entry else None
            cost = answer_cost(price, max_chars, max_tokens)
            row[kind] = {
                "usdPerMillionTokens": None if price is None else {"input": price[0], "output": price[1]},
                "perAnswerUsd": cost,
                "perMonthUsd": {str(cap): None if cost is None else cost * cap * days for cap in caps},
            }
        basis = entry.get("expectedUsdPerMillionTokens", {}).get("basis") if entry else None
        row["expectedBasis"] = basis if isinstance(basis, str) else None
        rows.append(row)
    return rows


def _usd(value: Decimal | None, places: int = 6) -> str:
    if value is None:
        return "n/a"
    return f"{value:.{places}f}"


def render(rows: list[dict[str, Any]], *, max_chars: int, max_tokens: int, caps: list[int], days: int) -> str:
    lines = [
        f"Worst case per free answer: question {max_chars} chars (= {max_chars // CHARS_PER_TOKEN} input tokens at "
        f"{CHARS_PER_TOKEN} chars/token), answer {max_tokens} tokens.",
        f"Month = {days} days with the global daily cap used up every day. USD.",
        "",
    ]
    for kind, title in (("list", "LIST price"), ("expected", "EXPECTED price")):
        head = ["model", "in $/M", "out $/M", "per answer"] + [f"{cap}/day/mo" for cap in caps]
        table = [head]
        for row in rows:
            part = row[kind]
            price = part["usdPerMillionTokens"]
            if not row["found"]:
                table.append([row["model"], "not in file"] + [""] * (len(head) - 2))
                continue
            table.append([
                row["model"],
                "n/a" if price is None else f"{price['input']:.6g}",
                "n/a" if price is None else f"{price['output']:.6g}",
                _usd(part["perAnswerUsd"], 8),
                *[_usd(part["perMonthUsd"][str(cap)], 4) for cap in caps],
            ])
        widths = [max(len(r[i]) for r in table) for i in range(len(head))]
        lines.append(title)
        for n, cells in enumerate(table):
            lines.append("  ".join(c.ljust(widths[0]) if i == 0 else c.rjust(widths[i]) for i, c in enumerate(cells)).rstrip())
            if n == 0:
                lines.append("  ".join("-" * w for w in widths))
        lines.append("")
    bases = sorted({f"{r['model']}: {r['expectedBasis']}" for r in rows if r["expectedBasis"]})
    if bases:
        lines.append("Expected-price basis in the file: " + "; ".join(bases))
    return "\n".join(lines).rstrip() + "\n"


def _jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    return value


def _positive_int(text: str) -> int:
    value = int(text)
    if value <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("models_file", help="a saved /v1/models JSON response")
    parser.add_argument("--models", default=",".join(DEFAULT_MODELS), help="comma-separated model ids (default: the five candidates)")
    parser.add_argument("--max-chars", type=_positive_int, default=DEFAULT_MAX_CHARS)
    parser.add_argument("--max-tokens", type=_positive_int, default=DEFAULT_MAX_TOKENS)
    parser.add_argument("--caps", default=",".join(map(str, DEFAULT_CAPS)), help="global answers-a-day caps, comma-separated")
    parser.add_argument("--days", type=_positive_int, default=DEFAULT_DAYS)
    parser.add_argument("--json", action="store_true", help="print JSON instead of the table")
    args = parser.parse_args(argv)
    try:
        caps = [_positive_int(c) for c in args.caps.split(",") if c.strip()]
        models = load_models(args.models_file)
    except (OSError, ValueError, argparse.ArgumentTypeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    wanted = [m.strip() for m in args.models.split(",") if m.strip()]
    rows = report(models, wanted, max_chars=args.max_chars, max_tokens=args.max_tokens, caps=caps, days=args.days)
    if args.json:
        print(json.dumps(_jsonable(rows), indent=2))
    else:
        print(render(rows, max_chars=args.max_chars, max_tokens=args.max_tokens, caps=caps, days=args.days), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

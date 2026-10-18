"""Operator paths for one-shot activation scripts.

Real locations are not stored in this repository. Set the variables from
private ops notes before running a script.
"""
import os
from pathlib import Path


def required(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Set {name} from private ops notes")
    return Path(value)

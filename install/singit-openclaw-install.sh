#!/usr/bin/env bash
# Repo path for the curl installer; website/singit-openclaw-install is the single source of truth.
set -euo pipefail
exec bash "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../website/singit-openclaw-install" "$@"

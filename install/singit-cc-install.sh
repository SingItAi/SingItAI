#!/usr/bin/env bash
# Repo path for the curl installer; website/singit-cc-install is the single source of truth.
set -euo pipefail
exec bash "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../website/singit-cc-install" "$@"

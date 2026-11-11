#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
node "$root/proxy/src/openclaw.js" doctor
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${SINGIT_PROXY_PORT:-8787}/v1/models" >/dev/null && echo 'Model catalog: OK' || { echo 'Model catalog unavailable; an unpaid 402 means payment required, not success.'; exit 1; }

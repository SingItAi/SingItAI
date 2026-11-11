#!/usr/bin/env bash
set -euo pipefail
dry_run=false
args=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    --default-model|--no-mcp|--mcp) args+=("$arg") ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done
command -v node >/dev/null || { echo 'Node 20+ is required.' >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo 'Node 20+ is required.' >&2; exit 1; }
echo 'Not on npm yet. The future https://singitai.app/singit-openclaw-install URL is NOT LIVE.'
echo 'From the SingItAI checkout: cd proxy && npm install && node src/openclaw.js setup'
echo 'Then: node src/openclaw.js start (or start --no-launch)'
$dry_run && exit 0
command -v openclaw >/dev/null || echo 'Install OpenClaw using https://docs.openclaw.ai or start with --no-launch.'
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/../proxy"
npm install
node src/openclaw.js setup "${args[@]}"

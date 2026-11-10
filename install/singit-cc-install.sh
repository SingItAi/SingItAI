#!/usr/bin/env bash
set -euo pipefail
# Intended URL is NOT LIVE. No wallet material is passed to any command.
dry_run=false
skip_claude=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    --skip-claude) skip_claude=true ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done
echo 'SingIt for Claude Code requires Node 20+.'
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo 'Install Node 20+ and run this script again.' >&2
  exit 1
fi
if "$dry_run"; then
  echo 'Dry run: Not on npm yet. No installation or wallet creation performed.'
  echo 'cd cc && npm install && node src/index.js setup && node src/index.js start'
  exit 0
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${SINGIT_CC_FROM:-}" == checkout || -f "$script_dir/../cc/package.json" ]] || ! npm view @singitai/cc version >/dev/null 2>&1; then
  echo 'Not on npm yet. From the SingItAI checkout run:'
  echo 'cd cc && npm install && node src/index.js setup && node src/index.js start'
  if ! command -v claude >/dev/null 2>&1; then
    echo 'Claude Code is missing. Install it using the official instructions at https://claude.ai/install.sh'
  fi
  exit 0
fi
if ! "$skip_claude" && ! command -v claude >/dev/null 2>&1; then
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://claude.ai/install.sh -o "$installer"
  bash "$installer"
fi
npm i -g @singitai/cc
singit-cc setup base
echo 'Next: singit-cc start (or start --no-launch if managing the proxy separately).'

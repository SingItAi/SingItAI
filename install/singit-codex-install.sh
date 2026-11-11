#!/usr/bin/env bash
set -euo pipefail

dry_run=false
skip_codex=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    --skip-codex) skip_codex=true ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done
command -v node >/dev/null || { echo 'Node 20+ is required.' >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo 'Node 20+ is required.' >&2; exit 1; }
echo 'Not on npm yet. The future https://singitai.app/singit-codex-install URL is NOT LIVE.'
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
checkout=false
if [[ "${SINGIT_CODEX_FROM:-}" == checkout || -f "$script_dir/../proxy/package.json" ]]; then
  checkout=true
elif ! npm view @singitai/proxy version >/dev/null 2>&1; then
  checkout=true
fi
if $checkout; then
  echo 'From the SingItAI checkout: cd proxy && npm install && node src/codex.js setup'
  echo 'Then: node src/codex.js start'
else
  echo 'npm i -g @singitai/proxy && singit-codex setup'
fi
$dry_run && exit 0
if ! $skip_codex && ! command -v codex >/dev/null; then
  echo 'Install Codex using the official guidance: https://developers.openai.com/codex (or start with --no-launch).'
fi
if $checkout; then
  if [[ ! -f "$script_dir/../proxy/package.json" ]]; then
    echo 'Obtain a SingItAI checkout and run the instructions above.'
    exit 0
  fi
  cd "$script_dir/../proxy"
  npm install
  node src/codex.js setup
else
  npm i -g @singitai/proxy
  singit-codex setup
fi

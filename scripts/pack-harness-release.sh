#!/usr/bin/env bash
# Pack the harness packages for testing (never publishes, never commits .tgz).
#   scripts/pack-harness-release.sh [output-dir]      (default: a new temp dir)
# @singitai/proxy depends on file:../sdk/typescript and file:../session-wallet in the
# monorepo, which a raw `npm pack` tarball cannot resolve on a clean machine. In a
# staging copy we install those two, then bundle them into the tarball and pin plain
# version ranges, so `npm i -g ./singitai-proxy-<version>.tgz` works with no repo.
# proxy/package.json in the checkout is not touched.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-$(mktemp -d)}"
mkdir -p "$out"
out="$(cd -- "$out" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir "$stage/proxy"
cp -R "$root/proxy/src" "$root/proxy/README.md" "$root/proxy/LICENSE" "$root/proxy/package.json" "$stage/proxy/"
# Stage siblings at the same relative paths so the file: deps resolve unchanged.
mkdir -p "$stage/sdk" "$stage/session-wallet"
cp -R "$root/sdk/typescript" "$stage/sdk/typescript"
cp -R "$root/session-wallet/." "$stage/session-wallet/"
rm -rf "$stage/sdk/typescript/node_modules" "$stage/session-wallet/node_modules"

(
  cd "$stage/proxy"
  # install-links copies the file: deps instead of symlinking them, so they can be bundled.
  npm install --omit=dev --install-links --no-audit --no-fund --loglevel=error
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    for (const name of Object.keys(pkg.dependencies)) {
      pkg.dependencies[name] = JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version;
    }
    pkg.bundleDependencies = Object.keys(pkg.dependencies);
    writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  '
  npm pack --pack-destination "$out" --loglevel=error >/dev/null
)
(cd "$root/openclaw" && npm pack --pack-destination "$out" --loglevel=error >/dev/null)

ls "$out"/*.tgz

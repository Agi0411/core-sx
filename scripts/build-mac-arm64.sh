#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== Core SX macOS arm64 build =="
echo "Node: $(node -v)"
echo "npm:  $(npm -v)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: This script must be run on macOS." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: This script targets Apple Silicon (arm64)." >&2
  echo "Use npm run dist:mac for a host-appropriate mac build instead." >&2
  exit 1
fi

npm install
npm run parser:verify
npm run dist:mac:arm64

echo
printf 'Build complete. DMG/ZIP files are in: %s\n' "$(pwd)/release"
ls -lh release/*.{dmg,zip} 2>/dev/null || true

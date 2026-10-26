#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: This script must be run on macOS." >&2
  exit 1
fi

npm install
npm run parser:verify
npm run dist:mac

echo
printf 'Build complete. DMG/ZIP files are in: %s\n' "$(pwd)/release"
ls -lh release/*.{dmg,zip} 2>/dev/null || true

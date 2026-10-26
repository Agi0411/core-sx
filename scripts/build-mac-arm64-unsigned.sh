#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: This script must run on macOS." >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: This script targets Apple Silicon (arm64)." >&2
  exit 1
fi

npm install
npm run parser:verify
npm run prepare:icon:mac
npm run build

CSC_IDENTITY_AUTO_DISCOVERY=false \
./node_modules/.bin/electron-builder \
  --mac \
  --arm64 \
  --config.mac.notarize=false \
  --config.mac.gatekeeperAssess=false

echo
printf 'Artifacts:\n'
find release -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.zip' \) -print

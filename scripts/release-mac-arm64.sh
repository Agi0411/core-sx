#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: This release script must run on macOS." >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: This release script targets Apple Silicon (arm64)." >&2
  exit 1
fi

: "${CSC_LINK:=}"
: "${CSC_KEY_PASSWORD:=}"
: "${CSC_NAME:=}"

if [[ -z "${CSC_LINK}" && -z "${CSC_NAME}" ]]; then
  echo "ERROR: Set CSC_LINK/CSC_KEY_PASSWORD or install a Developer ID Application certificate in the login keychain." >&2
  exit 1
fi

if [[ -n "${APPLE_API_KEY:-}" ]]; then
  : "${APPLE_API_KEY_ID:?Set APPLE_API_KEY_ID}"
  : "${APPLE_API_ISSUER:?Set APPLE_API_ISSUER}"
elif [[ -n "${APPLE_ID:-}" ]]; then
  : "${APPLE_APP_SPECIFIC_PASSWORD:?Set APPLE_APP_SPECIFIC_PASSWORD}"
  : "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID}"
else
  echo "ERROR: Set App Store Connect API key variables or Apple ID notarization variables." >&2
  exit 1
fi

npm install
npm run parser:verify
npm run prepare:icon:mac
npm run build
electron-builder --mac --arm64 dmg zip

echo
echo "Release artifacts:"
ls -lh release/*.{dmg,zip}

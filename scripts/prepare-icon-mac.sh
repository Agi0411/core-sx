#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: icon preparation must run on macOS." >&2
  exit 1
fi
mkdir -p build/Core-SX.iconset
for size in 16 32 128 256 512 1024; do
  /usr/bin/sips -z "$size" "$size" build/icon.png --out "build/Core-SX.iconset/icon_${size}x${size}.png" >/dev/null
  if [[ "$size" != "1024" ]]; then
    size2=$((size*2))
    /usr/bin/sips -z "$size2" "$size2" build/icon.png --out "build/Core-SX.iconset/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
/usr/bin/iconutil -c icns build/Core-SX.iconset -o build/icon.icns
rm -rf build/Core-SX.iconset
echo "Prepared build/icon.icns"

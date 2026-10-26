# Core SX macOS unsigned build

Use this when you do not have a Developer ID Application certificate and only need a DMG/ZIP for local or direct distribution.

```bash
chmod +x scripts/build-mac-arm64-unsigned.sh
./scripts/build-mac-arm64-unsigned.sh
```

Artifacts are written to `release/`.

# Core SX 1.0.0 — macOS Release

This release package prepares Core SX for a signed, notarized Apple Silicon macOS distribution.

## Included
- Branded macOS app icon
- Branded DMG background and Applications drop target
- Version `1.0.0`
- Developer ID signing configuration
- Hardened Runtime
- Apple notarization configuration
- Apple Silicon (`arm64`) release script
- Existing parser regression test

## Apple requirements
For distribution outside the Mac App Store, Apple requires Developer ID signing and notarization. You need an active Apple Developer account and a `Developer ID Application` certificate. The release script supports either an App Store Connect API key or Apple ID + app-specific password for notarization.

## Build on an M-series Mac
1. Make sure Xcode Command Line Tools are installed.
2. Install/export your Developer ID Application certificate.
3. Copy `.env.release.example` values into your shell environment without committing secrets.
4. Run:

```bash
./scripts/release-mac-arm64.sh
```

The output will be in `release/`:

```text
Core-SX-1.0.0-arm64.dmg
Core-SX-1.0.0-arm64.zip
```

## Verify the signed app
After building:

```bash
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Core SX.app"
spctl --assess --type execute --verbose=4 "release/mac-arm64/Core SX.app"
```

If the app was notarized, you can also inspect the ticket:

```bash
xcrun stapler validate "release/mac-arm64/Core SX.app"
```

## Notes
- This environment cannot create or sign a final macOS DMG because signing/notarization must use your Apple Developer credentials on macOS (or an equivalent CI environment).
- Do not put certificates, `.p8` keys, app-specific passwords, or private credentials in the repository.

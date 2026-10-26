# Contributing to Core SX

Thanks for helping out! Bug reports, ideas and pull requests are all welcome.

## Set up

```bash
npm install        # also compiles the native MIDI module (needs the Xcode Command Line Tools)
npm run dev        # Vite + Electron with hot reload
```

## Before you open a pull request

```bash
npm run parser:verify   # SPD-SX project parser
npm run test:fx         # effect engine
npm run build           # renderer + main process must compile
```

- **UI text:** never hard-code a user-visible string. Use `t('key')` for the shared dictionary or `tr('中文原文')` for everything else, and add the English / 日本語 / 한국어 translations to the `L10N` table in `src/renderer/main.tsx`.
- **Effects:** DSP lives in `src/renderer/fx.ts`, is DOM-free and covered by `tests/fx.test.ts`. A new effect needs a definition in `FX_DEFS`, a processor in `processSlot`, and a test.
- **Icons:** edit `assets/logo-source.png` and run `npm run icons`; do not hand-edit `build/icon.*`.
- **Hardware data:** don't commit backups, wave data or firmware from a real SPD-SX unless you have the right to share them. Test fixtures must be synthetic or your own.
- Keep pull requests focused, and describe how you tested them (macOS version, Apple Silicon / Intel, whether an SPD-SX was connected).

## Reporting bugs

Please include the Core SX version (shown in the title bar), macOS version, whether an SPD-SX was connected (and in which mode), and the steps to reproduce.

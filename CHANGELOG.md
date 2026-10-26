# Changelog

## 1.1.0

### Added
- **Effects per layer.** Every PAD's MAIN and SUB can carry up to six effects: noise gate, compressor, channel EQ (with response curve), filter, overdrive, distortion, chorus, flanger, delay and reverb — in a Logic-style insert rack with presets, drag-to-reorder and bypass. Effects are baked ahead of time, so playback latency is the same as without them; exported WAVs include them.
- **Audio output.** Choose any system output device (including virtual devices such as BlackHole / Loopback for Logic Pro), with a quick picker in the SPD Pad toolbar and a full *Settings → Audio output* page. Optional per-PAD channel-pair routing on multi-channel devices.
- **Play from a DAW.** Core SX creates a virtual MIDI destination called “Core SX”; notes sent to it (Logic Pro External Instrument, any DAW) play the Instrument-mode pads — with or without an SPD-SX connected, on any page, with velocity shaping, MIDI Learn from the DAW, and a note map in Settings. The window no longer throttles when it is behind your DAW.
- **Monitor output.** Every pad hit can also be played through a second device while the main output feeds a DAW.
- **New app icon** and a script to regenerate every icon size from one source logo (`npm run icons`).
- Waveform editor: Logic-style fade handles and curves, waveform mirrors when Reverse is on, zoom with pan, keyboard and double-click editing of values.
- Cascading context menus that open on hover; "?" help buttons instead of inline instructions.
- Layouts that fit the window without scrolling (density levels, then scaling), including at large text sizes.
- Complete translations (English, 日本語, 한국어) for every UI string.

### Fixed
- With Reverse on, the whole waveform is now mirrored and stays in place; the START / END handles trim it instead of dragging the waveform shape along with them.
- Clicking PAD 2 right after PAD 1 could play PAD 1's sound on the first hit.
- Start / End handles could get stuck after toggling Reverse.
- MAIN and SUB of a pad did not start at the same instant.
- PAD assignments were never saved between sessions.
- Fade values were displayed in the wrong unit; fade curve dragging accelerated.
- Zoom made the trim handles drift away from the waveform.

### Changed
- Redesigned PAD cards, waveform editor, title bar, wave browser and settings pages; the title bar now shows the version from `package.json`.

<p align="center"><img src="build/icon.png" width="128" alt="Core SX icon"></p>

<h1 align="center">Core SX</h1>

<p align="center">A modern editor, MIDI controller and computer instrument for the Roland SPD-SX / SPD-SX Special Edition.</p>

<p align="center"><a href="README.zh-TW.md">繁體中文</a> · <a href="docs/PUBLISHING.md">Publishing guide (zh-TW)</a></p>

<p align="center"><img src="docs/screenshots/spd-pad.png" alt="Core SX — SPD Pad mode" width="900"></p>

## Features

- **Two modes, detected automatically** — *Editor* (browse and edit the kits and waves of an SPD-SX in WAVE MGR mode) and *Instrument* (the computer plays the pads; the SPD-SX is just the controller over AUDIO/MIDI).
- **10 PADs × MAIN / SUB layers** — drag samples from the library onto a layer, or right-click a sample → MAIN / SUB → PAD. *Learn* maps a physical pad to a software pad.
- **Waveform editor** — trim (Start / End), fade in / out with draggable curves (Logic Pro style), reverse, normalize, pitch, volume and pan, undo / redo, export WAV.
- **Effects per layer** — noise gate, compressor, channel EQ, filter, overdrive, distortion, chorus, flanger, delay and reverb, in a Logic-style insert rack with presets. Effects are rendered ahead of time, so playback latency is identical with or without them.
- **Play it from your DAW** — Core SX opens a virtual MIDI port named “Core SX”, so Logic Pro (or any DAW) can play the pads as an External Instrument, with or without an SPD-SX connected.
- **Audio output** — pick any system output (including virtual devices such as BlackHole or Loopback to feed Logic Pro), play through a second *monitor* device at the same time, and optionally route each PAD to its own channel pair on multi-channel devices.
- **Kit library** — kits live on the computer in Instrument mode and on the SPD-SX in Editor mode.
- **MIDI / SysEx tools**, four UI languages (繁體中文, English, 日本語, 한국어), themes, adjustable text size, UI sound styles, per-pad sensitivity.

<p align="center"><img src="docs/screenshots/effects.png" width="440" alt="Effects rack"> <img src="docs/screenshots/audio-output.png" width="440" alt="Audio output settings"></p>

## Getting started

Requirements: macOS, **Node.js 20 or newer**, and the Xcode Command Line Tools (`xcode-select --install`) — the MIDI module is a native add-on that is compiled during `npm install`.

```bash
git clone https://github.com/<your-account>/core-sx.git
cd core-sx
npm install
npm run dev
```

Build an installer (Apple Silicon, unsigned):

```bash
npm run dist:mac:arm64:unsigned     # → release/*.dmg and *.zip
```

Signed and notarized builds are described in [RELEASE.md](RELEASE.md); unsigned builds in [RELEASE_UNSIGNED.md](RELEASE_UNSIGNED.md).

## Sending sound to Logic Pro (or any other app)

Core SX cannot present itself as an audio device, so use a virtual one:

1. Install a virtual audio driver, for example [BlackHole](https://existential.audio/blackhole/) (free) or Loopback.
2. In Core SX: **Settings → Audio output**, choose that device.
3. In Logic Pro: **Settings → Audio**, set the same device as the input and pick the matching channels on your audio tracks.
4. To monitor while recording, create a *Multi-Output* or *Aggregate* device in macOS **Audio MIDI Setup**.
5. With a multi-channel device (e.g. BlackHole 16ch) choose **Separate channels per PAD** to get every PAD on its own track.

## Playing Core SX from Logic Pro (External Instrument)

1. Leave **Settings → Audio output → Virtual MIDI port “Core SX”** on (it is on by default). Logic Pro lists it as a MIDI destination — no IAC setup needed.
2. In Logic Pro, create a *Software Instrument* track, insert **External Instrument**, and set **MIDI Destination** to “Core SX”.
3. Set the External Instrument’s **Audio Input** to a channel pair of your virtual audio device (see above), and choose the same device as Core SX’s output.
4. Each PAD answers to notes **C1–A1 (36–45, Logic’s C3 = 60)**. To use other notes, press **Learn** on a PAD and play the note from Logic.
5. Core SX plays one-shot samples, so Note Off never cuts a sound; velocity follows the PAD sensitivity setting. If the recorded audio lands slightly late, adjust Logic’s recording delay.

Use **Also play through** (Settings → Audio output) to hear Core SX on your speakers while the main output feeds Logic.

## Project layout

```
src/main        Electron main process (device detection, project files, MIDI, preload bridge)
src/renderer    React UI — main.tsx, fx.ts (effect engine), sx-design.css, styles.css
src/shared      SPD-SX project parser and shared types
scripts         build / release / icon helpers
tests           parser fixture and effect-engine tests
```

```bash
npm run parser:verify   # SPD-SX project parser
npm run test:fx         # effect engine (gate, compressor, EQ, reverb RT60 …)
npm run icons           # regenerate every icon from assets/logo-source.png
```

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Agi Lin.

*Core SX is an independent project and is not affiliated with, endorsed by or sponsored by Roland Corporation. "Roland" and "SPD-SX" are trademarks of their respective owner.*

## Credits

- UI sound effects: [UI SFX](https://uisfx.com) by Yuki Capital (CC0 1.0). See `THIRD_PARTY_LICENSES.md`.

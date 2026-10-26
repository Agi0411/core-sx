# Architecture

```text
Roland Backup (.zip / folder)
        |
        v
  Electron Main Process
        |
        +--> unzip / fs
        |
        +--> SPD-SX Parser
        |
        v
   ProjectModel
   /    |     \
 Kits  Waves   Tags
   |
   v
 React Renderer
   |
   +--> Kit Browser
   +--> 16 Pad Grid
   +--> Pad Inspector
   +--> Export
```

## Parser assumptions verified against the provided backup

- `KIT/kitNNN.spd`
- 15 `PadPrm` sections per kit in the provided sample
- `Tempo` is stored in tenths of BPM
- Roland names are stored as numeric `<Nm0>...` fields
- Wave IDs map to `WAVE/PRM/<bank>/<slot>.spd`
- Wave PRM `<Path>` points to the corresponding file under `WAVE/DATA`
- `SYSTEM/tag_list.spd` stores tag labels as numeric name fields

Unknown kit/pad fields are preserved because export starts from the original `.spd` text and only replaces fields we intentionally edit.

### USB mode state machine (v0.3.1)

`main.ts` continuously classifies the device as:
- `WAVE_MGR`: mounted volume contains `Roland/SPD-SX/KIT` and `WAVE`.
- `AUDIO_MIDI`: no WAVE MGR volume, but CoreMIDI exposes an SPD-SX-like port.
- `UNKNOWN`: other MIDI exists but no SPD-SX port match.
- `DISCONNECTED`: neither storage nor MIDI is detected.

The renderer switches to Editor Mode or Instrument Mode accordingly. The app does not attempt to switch the SPD-SX USB MODE itself; the hardware still owns that setting.

## Renderer modules (v1.1)

```text
src/renderer/main.tsx      UI, state, Instrument-mode playback
src/renderer/fx.ts         effect engine — DOM-free DSP + parameter specs + presets
src/renderer/sx-design.css design layer (tokens derive from the theme variables)
```

**Audio path (Instrument mode).** `audioEngine` owns the single `AudioContext`, the selected output device (`setSinkId`) and optional per-PAD channel routing (`ChannelMerger`, one stereo bus per channel pair). A PAD hit resolves the layer's edited buffer, then — if the layer has effects — `bakeFx()` renders *trim region → effect chain → soft limiter* into a cached `AudioBuffer`. Playback is therefore a plain `AudioBufferSourceNode` → gain → pan → output bus, so latency does not depend on the effects. Layers with effects are re-baked in idle time whenever their parameters, sample or edits change (`warmFx`).

**Effects.** Each layer stores `fx: FxSlot[]` (`{id, type, on, p}`) inside the pad assignment, so effects are saved with Kit presets. Reverb is an 8-line feedback delay network calibrated to its RT60 setting; the gate looks ahead (free offline) so transients are never clipped. `tests/fx.test.ts` checks every effect numerically.

**Fit-to-window.** `FitPage` keeps pages free of scrollbars: it first raises a layout *density* (`data-density` 0–3) and only then scales the page down.

**Localization.** `t(key)` for the shared dictionary, `tr('中文原文', …args)` + the `L10N` table for everything else.

**DAW input.** `src/main/midi.ts` can open a virtual MIDI destination (`Core SX`) through RtMidi/CoreMIDI. Messages arriving there are forwarded to the renderer flagged `virtual: true`; the renderer maps `note → pad` (`midiNote ?? 36 + index`) and plays the Instrument-mode pad regardless of SPD-SX connection state or the open page. The hardware handler ignores virtual messages, so a note is never played twice. The window is created with `backgroundThrottling: false` so audio keeps flowing when a DAW is in front.

**Monitor output.** `audioEngine` can keep a second `AudioContext` bound to another device (`setSinkId`); the pad-playback path creates a matching source there for every hit.

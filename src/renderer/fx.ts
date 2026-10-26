/* ==========================================================================
   Core SX · effect engine
   One-shot samples are "baked": the chain is rendered offline into a new
   buffer whenever a parameter changes, so playback stays a plain buffer
   source (lowest latency, identical result in preview / pad / export).
   This file is DOM-free on purpose (the AudioBuffer wrapper is at the end).
   ========================================================================== */

export type FxType = 'gate' | 'compressor' | 'eq' | 'filter' | 'drive' | 'distortion' | 'chorus' | 'flanger' | 'delay' | 'reverb'
export type FxSlot = { id: string; type: FxType; on: boolean; p: Record<string, number> }
export type ParamUnit = 'dB' | 'ms' | 'Hz' | '%' | 's' | 'x' | 'st' | ''
export type ParamSpec = { key: string; label: string; min: number; max: number; def: number; unit: ParamUnit; log?: boolean; options?: string[] }
export type FxPreset = { name: string; p: Record<string, number> }
export type FxDef = { label: string; group: 'dynamics' | 'eq' | 'distortion' | 'modulation' | 'space'; params: ParamSpec[]; presets: FxPreset[] }

const P = (key: string, label: string, min: number, max: number, def: number, unit: ParamUnit, log = false, options?: string[]): ParamSpec => ({ key, label, min, max, def, unit, log, options })

export const FX_DEFS: Record<FxType, FxDef> = {
  gate: { label: 'Noise Gate', group: 'dynamics',
    params: [P('threshold', 'THRESHOLD', -80, 0, -42, 'dB'), P('attack', 'ATTACK', 0.1, 50, 0.5, 'ms', true), P('hold', 'HOLD', 0, 500, 30, 'ms'), P('release', 'RELEASE', 5, 1000, 120, 'ms', true), P('range', 'RANGE', -80, 0, -80, 'dB')],
    presets: [{ name: 'Tight', p: { threshold: -36, attack: 0.3, hold: 10, release: 60, range: -80 } }, { name: 'Gentle', p: { threshold: -50, attack: 1, hold: 40, release: 220, range: -30 } }, { name: 'Chop', p: { threshold: -24, attack: 0.2, hold: 5, release: 25, range: -80 } }] },
  compressor: { label: 'Compressor', group: 'dynamics',
    params: [P('threshold', 'THRESHOLD', -60, 0, -20, 'dB'), P('ratio', 'RATIO', 1, 20, 4, 'x', true), P('attack', 'ATTACK', 0.1, 200, 12, 'ms', true), P('release', 'RELEASE', 10, 2000, 160, 'ms', true), P('knee', 'KNEE', 0, 30, 6, 'dB'), P('makeup', 'MAKEUP', 0, 24, 3, 'dB'), P('mix', 'MIX', 0, 100, 100, '%')],
    presets: [{ name: 'Punch', p: { threshold: -22, ratio: 4, attack: 25, release: 120, knee: 4, makeup: 4, mix: 100 } }, { name: 'Glue', p: { threshold: -18, ratio: 2, attack: 30, release: 250, knee: 12, makeup: 2, mix: 100 } }, { name: 'Squash', p: { threshold: -32, ratio: 12, attack: 2, release: 90, knee: 2, makeup: 10, mix: 60 } }] },
  eq: { label: 'Channel EQ', group: 'eq',
    params: [P('lf', 'LOW', 20, 500, 90, 'Hz', true), P('lg', 'GAIN', -18, 18, 0, 'dB'), P('m1f', 'LOW MID', 80, 2000, 350, 'Hz', true), P('m1g', 'GAIN', -18, 18, 0, 'dB'), P('m1q', 'Q', 0.2, 10, 1, '', true), P('m2f', 'HIGH MID', 500, 8000, 2800, 'Hz', true), P('m2g', 'GAIN', -18, 18, 0, 'dB'), P('m2q', 'Q', 0.2, 10, 1, '', true), P('hf', 'HIGH', 2000, 18000, 9000, 'Hz', true), P('hg', 'GAIN', -18, 18, 0, 'dB')],
    presets: [{ name: 'Flat', p: { lg: 0, m1g: 0, m2g: 0, hg: 0 } }, { name: 'Bright', p: { lg: -2, m1g: -1, m2g: 3, hg: 5 } }, { name: 'Warm', p: { lf: 110, lg: 4, m1g: 1.5, m2g: -2, hg: -3 } }, { name: 'Telephone', p: { lf: 300, lg: -18, m1f: 900, m1g: 5, m1q: 1.2, m2f: 2600, m2g: 5, m2q: 1.2, hf: 4500, hg: -18 } }] },
  filter: { label: 'Filter', group: 'eq',
    params: [P('type', 'TYPE', 0, 2, 0, '', false, ['LP', 'HP', 'BP']), P('cutoff', 'CUTOFF', 20, 20000, 4000, 'Hz', true), P('res', 'RESONANCE', 0.5, 14, 0.8, '', true), P('mix', 'MIX', 0, 100, 100, '%')],
    presets: [{ name: 'Dark', p: { type: 0, cutoff: 1800, res: 0.7, mix: 100 } }, { name: 'Thin', p: { type: 1, cutoff: 600, res: 0.7, mix: 100 } }, { name: 'Radio', p: { type: 2, cutoff: 1800, res: 1.4, mix: 100 } }] },
  drive: { label: 'Overdrive', group: 'distortion',
    params: [P('drive', 'DRIVE', 0, 40, 14, 'dB'), P('tone', 'TONE', 500, 18000, 7000, 'Hz', true), P('level', 'LEVEL', -24, 6, -4, 'dB'), P('mix', 'MIX', 0, 100, 100, '%')],
    presets: [{ name: 'Warm', p: { drive: 8, tone: 5200, level: -2, mix: 100 } }, { name: 'Crunch', p: { drive: 20, tone: 7500, level: -6, mix: 100 } }, { name: 'Parallel', p: { drive: 26, tone: 6000, level: -8, mix: 45 } }] },
  distortion: { label: 'Distortion', group: 'distortion',
    params: [P('type', 'TYPE', 0, 3, 0, '', false, ['Clip', 'Fuzz', 'Fold', 'Crush']), P('drive', 'DRIVE', 0, 100, 45, '%'), P('tone', 'TONE', 500, 18000, 9000, 'Hz', true), P('level', 'LEVEL', -24, 6, -6, 'dB'), P('mix', 'MIX', 0, 100, 100, '%')],
    presets: [{ name: 'Hard Clip', p: { type: 0, drive: 55, tone: 8000, level: -8, mix: 100 } }, { name: 'Fuzz Face', p: { type: 1, drive: 70, tone: 5000, level: -8, mix: 100 } }, { name: 'Wavefolder', p: { type: 2, drive: 45, tone: 12000, level: -6, mix: 80 } }, { name: 'Lo-Fi', p: { type: 3, drive: 55, tone: 9000, level: -4, mix: 100 } }] },
  chorus: { label: 'Chorus', group: 'modulation',
    params: [P('rate', 'RATE', 0.05, 8, 0.7, 'Hz', true), P('depth', 'DEPTH', 0, 100, 50, '%'), P('delay', 'DELAY', 4, 30, 14, 'ms'), P('spread', 'SPREAD', 0, 100, 100, '%'), P('mix', 'MIX', 0, 100, 45, '%')],
    presets: [{ name: 'Classic', p: { rate: 0.7, depth: 50, delay: 14, spread: 100, mix: 45 } }, { name: 'Lush', p: { rate: 0.35, depth: 75, delay: 20, spread: 100, mix: 55 } }, { name: 'Vibrato', p: { rate: 5.2, depth: 35, delay: 8, spread: 0, mix: 100 } }] },
  flanger: { label: 'Flanger', group: 'modulation',
    params: [P('rate', 'RATE', 0.05, 6, 0.3, 'Hz', true), P('depth', 'DEPTH', 0, 100, 65, '%'), P('delay', 'DELAY', 0.2, 10, 1.8, 'ms', true), P('feedback', 'FEEDBACK', -95, 95, 55, '%'), P('spread', 'SPREAD', 0, 100, 60, '%'), P('mix', 'MIX', 0, 100, 50, '%')],
    presets: [{ name: 'Jet', p: { rate: 0.18, depth: 85, delay: 2.2, feedback: 72, spread: 60, mix: 50 } }, { name: 'Metallic', p: { rate: 0.4, depth: 40, delay: 0.8, feedback: -80, spread: 40, mix: 50 } }, { name: 'Subtle', p: { rate: 0.25, depth: 45, delay: 1.5, feedback: 30, spread: 80, mix: 35 } }] },
  delay: { label: 'Delay', group: 'space',
    params: [P('mode', 'MODE', 0, 2, 1, '', false, ['Mono', 'Stereo', 'Ping-Pong']), P('time', 'TIME', 1, 2000, 280, 'ms', true), P('feedback', 'FEEDBACK', 0, 95, 38, '%'), P('tone', 'TONE', 500, 18000, 6500, 'Hz', true), P('mix', 'MIX', 0, 100, 30, '%')],
    presets: [{ name: 'Slapback', p: { mode: 0, time: 95, feedback: 12, tone: 7000, mix: 28 } }, { name: 'Ping-Pong', p: { mode: 2, time: 320, feedback: 48, tone: 5500, mix: 32 } }, { name: 'Dub', p: { mode: 1, time: 450, feedback: 68, tone: 3200, mix: 38 } }] },
  reverb: { label: 'Reverb', group: 'space',
    params: [P('decay', 'DECAY', 0.2, 10, 1.8, 's', true), P('predelay', 'PRE-DELAY', 0, 200, 12, 'ms'), P('size', 'SIZE', 20, 100, 70, '%'), P('damping', 'DAMPING', 0, 100, 45, '%'), P('lowcut', 'LOW CUT', 20, 800, 120, 'Hz', true), P('width', 'WIDTH', 0, 100, 100, '%'), P('mix', 'MIX', 0, 100, 28, '%')],
    presets: [{ name: 'Room', p: { decay: 0.6, predelay: 4, size: 45, damping: 55, lowcut: 140, width: 85, mix: 22 } }, { name: 'Plate', p: { decay: 1.7, predelay: 10, size: 70, damping: 30, lowcut: 160, width: 100, mix: 28 } }, { name: 'Hall', p: { decay: 3.6, predelay: 24, size: 90, damping: 45, lowcut: 120, width: 100, mix: 30 } }, { name: 'Cathedral', p: { decay: 7, predelay: 40, size: 100, damping: 60, lowcut: 100, width: 100, mix: 36 } }] }
}
export const FX_ORDER: FxType[] = ['gate', 'compressor', 'eq', 'filter', 'drive', 'distortion', 'chorus', 'flanger', 'delay', 'reverb']
export const FX_GROUPS: { id: FxDef['group']; label: string; types: FxType[] }[] = [
  { id: 'dynamics', label: 'Dynamics', types: ['gate', 'compressor'] },
  { id: 'eq', label: 'EQ & Filter', types: ['eq', 'filter'] },
  { id: 'distortion', label: 'Distortion', types: ['drive', 'distortion'] },
  { id: 'modulation', label: 'Modulation', types: ['chorus', 'flanger'] },
  { id: 'space', label: 'Delay & Reverb', types: ['delay', 'reverb'] }
]
export const MAX_FX_SLOTS = 6

export function defaultParams(type: FxType): Record<string, number> { return Object.fromEntries(FX_DEFS[type].params.map(s => [s.key, s.def])) }
export function newSlot(type: FxType): FxSlot { return { id: 'fx' + Math.random().toString(36).slice(2, 9), type, on: true, p: defaultParams(type) } }
export function withDefaults(type: FxType, p: Record<string, number> | undefined) { return { ...defaultParams(type), ...(p || {}) } }
/** slider position (0..1) <-> parameter value */
export function paramToUnit(s: ParamSpec, v: number) { const t = s.log ? Math.log(v / s.min) / Math.log(s.max / s.min) : (v - s.min) / (s.max - s.min); return Math.min(1, Math.max(0, t)) }
export function unitToParam(s: ParamSpec, t: number) { const c = Math.min(1, Math.max(0, t)); return s.log ? s.min * Math.pow(s.max / s.min, c) : s.min + c * (s.max - s.min) }
export function formatParam(s: ParamSpec, v: number): string {
  if (s.options) return s.options[Math.round(v)] ?? String(v)
  switch (s.unit) {
    case 'dB': return `${v > 0 && s.min < 0 ? '+' : ''}${v.toFixed(1)} dB`
    case 'ms': return v >= 100 ? `${Math.round(v)} ms` : `${v.toFixed(v < 10 ? 2 : 1)} ms`
    case 'Hz': return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`
    case '%': return `${Math.round(v)}%`
    case 's': return `${v.toFixed(2)} s`
    case 'x': return `${v.toFixed(v < 10 ? 1 : 0)} : 1`
    default: return v >= 10 ? v.toFixed(1) : v.toFixed(2)
  }
}
export function fxSignature(slots: FxSlot[] | undefined) { return (slots || []).filter(s => s.on).map(s => `${s.type}:${FX_DEFS[s.type].params.map(d => (withDefaults(s.type, s.p)[d.key]).toFixed(3)).join(',')}`).join('|') }
export function hasActiveFx(slots: FxSlot[] | undefined) { return !!slots && slots.some(s => s.on) }

/* ------------------------------ DSP helpers ------------------------------ */
type Chs = Float32Array[]
const dbToLin = (d: number) => Math.pow(10, d / 20)
const linToDb = (l: number) => 20 * Math.log10(Math.max(l, 1e-9))
const clampN = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const timeCoef = (ms: number, sr: number) => Math.exp(-1 / Math.max(1, (ms / 1000) * sr))
const grow = (chs: Chs, extra: number): Chs => chs.map(c => { const o = new Float32Array(c.length + extra); o.set(c); return o })
function toStereo(chs: Chs): Chs { return chs.length >= 2 ? chs : [chs[0], Float32Array.from(chs[0])] }

type Bq = { b0: number; b1: number; b2: number; a1: number; a2: number }
export function biquad(type: 'lp' | 'hp' | 'bp' | 'peak' | 'lowshelf' | 'highshelf', f0: number, q: number, gainDb: number, sr: number): Bq {
  const f = clampN(f0, 10, sr * 0.49), w0 = 2 * Math.PI * f / sr, cw = Math.cos(w0), sw = Math.sin(w0), A = Math.pow(10, gainDb / 40), alpha = sw / (2 * Math.max(0.05, q))
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0
  if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha }
  else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha }
  else if (type === 'bp') { b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha }
  else if (type === 'peak') { b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A }
  else { const sq = 2 * Math.sqrt(A) * alpha
    if (type === 'lowshelf') { b0 = A * ((A + 1) - (A - 1) * cw + sq); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sq); a0 = (A + 1) + (A - 1) * cw + sq; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sq }
    else { b0 = A * ((A + 1) + (A - 1) * cw + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sq); a0 = (A + 1) - (A - 1) * cw + sq; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sq } }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}
function runBiquad(x: Float32Array, c: Bq) { let z1 = 0, z2 = 0; for (let i = 0; i < x.length; i++) { const v = x[i], y = c.b0 * v + z1; z1 = c.b1 * v - c.a1 * y + z2; z2 = c.b2 * v - c.a2 * y; x[i] = y } }
export function biquadMagDb(c: Bq, f: number, sr: number) {
  const w = 2 * Math.PI * f / sr, cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
  const nr = c.b0 + c.b1 * cw + c.b2 * c2, ni = -(c.b1 * sw + c.b2 * s2), dr = 1 + c.a1 * cw + c.a2 * c2, di = -(c.a1 * sw + c.a2 * s2)
  return 10 * Math.log10((nr * nr + ni * ni) / Math.max(1e-20, dr * dr + di * di))
}
export function eqBands(p: Record<string, number>, sr: number): Bq[] {
  return [biquad('lowshelf', p.lf, 0.707, p.lg, sr), biquad('peak', p.m1f, p.m1q, p.m1g, sr), biquad('peak', p.m2f, p.m2q, p.m2g, sr), biquad('highshelf', p.hf, 0.707, p.hg, sr)]
}
export function eqResponseDb(p: Record<string, number>, f: number, sr = 44100) { return eqBands(p, sr).reduce((a, b) => a + biquadMagDb(b, f, sr), 0) }
function mixDryWet(dry: Chs, wet: Chs, mix: number): Chs { const m = clampN(mix, 0, 1); return wet.map((w, c) => { const d = dry[Math.min(c, dry.length - 1)], o = new Float32Array(w.length); for (let i = 0; i < w.length; i++) o[i] = (i < d.length ? d[i] : 0) * (1 - m) + w[i] * m; return o }) }

/* -------------------------------- effects -------------------------------- */
export const FX_METERS: Record<string, number> = {}   // compressor gain reduction (dB, ≤ 0) of the last bake, keyed by slot id

function gateFx(chs: Chs, sr: number, p: Record<string, number>): Chs {
  const n = chs[0].length, thr = dbToLin(p.threshold), floor = dbToLin(p.range), look = Math.round(Math.min(p.attack * 3, 6) * sr / 1000)
  const att = timeCoef(p.attack, sr), rel = timeCoef(p.release, sr), hold = Math.round(p.hold * sr / 1000), det = timeCoef(6, sr)
  const open = new Uint8Array(n); let env = 0, isOpen = false, cnt = 0
  for (let i = 0; i < n; i++) {
    let lv = 0; for (const c of chs) lv = Math.max(lv, Math.abs(c[i])); env = Math.max(lv, env * det)
    if (!isOpen) { if (env > thr) { isOpen = true; cnt = hold } } else if (env > thr * 0.7) cnt = hold; else if (cnt > 0) cnt--; else isOpen = false
    open[i] = isOpen ? 1 : 0
  }
  const g = new Float32Array(n); let gs = open[0] ? 1 : floor
  for (let i = 0; i < n; i++) { const target = open[Math.min(n - 1, i + look)] ? 1 : floor; gs = target > gs ? att * gs + (1 - att) * target : rel * gs + (1 - rel) * target; g[i] = gs }
  return chs.map(c => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = c[i] * g[i]; return o })
}
function compressorFx(chs: Chs, sr: number, p: Record<string, number>, id?: string): Chs {
  const n = chs[0].length, thr = p.threshold, ratio = Math.max(1, p.ratio), knee = p.knee, att = timeCoef(p.attack, sr), rel = timeCoef(p.release, sr), makeup = dbToLin(p.makeup), mix = p.mix / 100
  const gain = new Float32Array(n); let gr = 0, minGr = 0
  for (let i = 0; i < n; i++) {
    let lv = 0; for (const c of chs) lv = Math.max(lv, Math.abs(c[i]))
    const x = linToDb(lv), over = x - thr; let y = x
    if (2 * over < -knee) y = x; else if (2 * Math.abs(over) <= knee) y = x + (1 / ratio - 1) * Math.pow(over + knee / 2, 2) / (2 * Math.max(knee, 1e-6)); else y = thr + over / ratio
    const target = y - x
    gr = target < gr ? att * gr + (1 - att) * target : rel * gr + (1 - rel) * target
    if (gr < minGr) minGr = gr
    gain[i] = dbToLin(gr)
  }
  if (id) FX_METERS[id] = minGr
  const wet = chs.map(c => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = c[i] * gain[i] * makeup; return o })
  return mix >= 0.999 ? wet : mixDryWet(chs, wet, mix)
}
function eqFx(chs: Chs, sr: number, p: Record<string, number>): Chs {
  const bands = eqBands(p, sr), active = [p.lg, p.m1g, p.m2g, p.hg].map(g => Math.abs(g) > 0.01)
  return chs.map(c => { const o = Float32Array.from(c); bands.forEach((b, i) => { if (active[i]) runBiquad(o, b) }); return o })
}
function filterFx(chs: Chs, sr: number, p: Record<string, number>): Chs {
  const t = Math.round(p.type), kind = t === 1 ? 'hp' : t === 2 ? 'bp' : 'lp', c0 = biquad(kind, p.cutoff, p.res, 0, sr)
  const wet = chs.map(c => { const o = Float32Array.from(c); runBiquad(o, c0); return o })
  return mixDryWet(chs, wet, p.mix / 100)
}
/** 4× oversampled waveshaper (linear upsample → shaper → 2×LP → decimate) */
function shapeOversampled(x: Float32Array, sr: number, shaper: (v: number) => number): Float32Array {
  const F = 4, n = x.length, up = new Float32Array(n * F)
  for (let i = 0; i < n; i++) { const a = x[i], b = i + 1 < n ? x[i + 1] : a; for (let k = 0; k < F; k++) up[i * F + k] = shaper(a + (b - a) * (k / F)) }
  const lp = biquad('lp', sr * 0.45, 0.707, 0, sr * F); runBiquad(up, lp); runBiquad(up, lp)
  const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = up[i * F]; return out
}
function driveFx(chs: Chs, sr: number, p: Record<string, number>): Chs {
  const pre = dbToLin(p.drive), bias = 0.1, off = Math.tanh(bias), out = dbToLin(p.level), tone = biquad('lp', p.tone, 0.707, 0, sr)
  const comp = 1 / Math.max(0.35, Math.tanh(Math.min(pre, 4) * 0.8))   // keep loudness in the same ballpark as drive rises
  const wet = chs.map(c => { const o = shapeOversampled(c, sr, v => (Math.tanh(pre * v + bias) - off) * comp * 0.6); runBiquad(o, tone); for (let i = 0; i < o.length; i++) o[i] *= out; return o })
  return mixDryWet(chs, wet, p.mix / 100)
}
function distortionFx(chs: Chs, sr: number, p: Record<string, number>): Chs {
  const type = Math.round(p.type), d = p.drive / 100, g = 1 + d * d * 60, out = dbToLin(p.level), tone = biquad('lp', p.tone, 0.707, 0, sr)
  const wet = chs.map(c => {
    let o: Float32Array
    if (type === 0) o = shapeOversampled(c, sr, v => clampN(v * g, -1, 1) * 0.7)
    else if (type === 1) o = shapeOversampled(c, sr, v => { const y = v * g; return (y > 0 ? Math.tanh(y * 1.6) : Math.max(-0.55, Math.tanh(y * 0.5))) * 0.65 })
    else if (type === 2) o = shapeOversampled(c, sr, v => (2 / Math.PI) * Math.asin(Math.sin(v * (1 + d * 14) * Math.PI / 2)) * 0.8)
    else { const pre = Float32Array.from(c); runBiquad(pre, tone); o = new Float32Array(c.length); const bits = Math.max(3, 16 - d * 13), lv = Math.pow(2, bits - 1), hold = Math.max(1, Math.round(1 + d * d * 14)); let held = 0
      for (let i = 0; i < c.length; i++) { if (i % hold === 0) held = Math.round(pre[i] * lv) / lv; o[i] = held * 0.9 } }
    if (type !== 3) runBiquad(o, tone); for (let i = 0; i < o.length; i++) o[i] *= out; return o
  })
  return mixDryWet(chs, wet, p.mix / 100)
}
function readFrac(buf: Float32Array, pos: number, size: number) {   // 4-point Hermite
  const i1 = Math.floor(pos), f = pos - i1, m = (k: number) => buf[((i1 + k) % size + size) % size]
  const y0 = m(-1), y1 = m(0), y2 = m(1), y3 = m(2), c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)
  return ((c3 * f + c2) * f + c1) * f + y1
}
function modDelay(chs: Chs, sr: number, o: { rate: number; depthMs: number; baseMs: number; fb: number; spread: number; mix: number; voices: number }): Chs {
  const st = toStereo(chs), n = st[0].length, tailN = o.fb !== 0 ? Math.round(sr * 0.35) : 0, N = n + tailN
  const size = Math.ceil((o.baseMs + o.depthMs + 3) * sr / 1000) + 8
  const wet = st.map((src, c) => {
    const buf = new Float32Array(size), out = new Float32Array(N); let w = 0
    for (let i = 0; i < N; i++) {
      const x = i < n ? src[i] : 0; let acc = 0
      for (let v = 0; v < o.voices; v++) {
        const phase = (c * 0.5 * (o.spread / 100) + v * 0.5) % 1, lfo = Math.sin(2 * Math.PI * (o.rate * i / sr + phase))
        const dms = Math.max(0.05, o.baseMs * (1 + v * 0.18) + o.depthMs * lfo), pos = w - dms * sr / 1000
        acc += readFrac(buf, pos, size)
      }
      const y = acc / o.voices
      buf[w] = x + o.fb * y; out[i] = y; w = (w + 1) % size
    }
    return out
  })
  return mixDryWet(grow(st, tailN), wet, o.mix)
}
const chorusFx = (chs: Chs, sr: number, p: Record<string, number>) => modDelay(chs, sr, { rate: p.rate, depthMs: p.delay * 0.45 * (p.depth / 100), baseMs: p.delay, fb: 0, spread: p.spread, mix: p.mix / 100, voices: 2 })
const flangerFx = (chs: Chs, sr: number, p: Record<string, number>) => modDelay(chs, sr, { rate: p.rate, depthMs: p.delay * 0.9 * (p.depth / 100), baseMs: p.delay, fb: clampN(p.feedback / 100, -0.95, 0.95), spread: p.spread, mix: p.mix / 100, voices: 1 })
function delayFx(chs: Chs, sr: number, p: Record<string, number>): Chs {
  const mode = Math.round(p.mode), st = mode === 0 ? chs : toStereo(chs), fb = clampN(p.feedback / 100, 0, 0.95), t = Math.max(1, Math.round(p.time * sr / 1000))
  const maxT = Math.round(t * (mode === 1 ? 1.5 : 1)), repeats = fb < 0.01 ? 1 : Math.ceil(Math.log(0.001) / Math.log(fb)), tailN = Math.min(Math.round(6 * sr), maxT * (repeats + 1))
  const n = st[0].length, N = n + tailN, lp = Math.exp(-2 * Math.PI * clampN(p.tone, 200, 20000) / sr), mixV = p.mix / 100
  const bufs = st.map(() => new Float32Array(maxT + 2)), pos = st.map(() => 0), lpS = st.map(() => 0), out = st.map(() => new Float32Array(N))
  const times = st.map((_, c) => mode === 1 && c === 1 ? Math.round(t * 1.5) : t)
  for (let i = 0; i < N; i++) {
    const xs = st.map(c => i < n ? c[i] : 0)
    const rd = st.map((_, c) => bufs[c][(pos[c] - times[c] + bufs[c].length) % bufs[c].length])
    st.forEach((_, c) => {
      let inp = xs[c], fbSrc = rd[c]
      if (mode === 2) { inp = c === 0 ? (xs[0] + (st[1] ? xs[1] : 0)) * 0.5 : 0; fbSrc = rd[1 - c] }
      lpS[c] = (1 - lp) * fbSrc + lp * lpS[c]
      bufs[c][pos[c]] = inp + fb * lpS[c]; pos[c] = (pos[c] + 1) % bufs[c].length; out[c][i] = rd[c]
    })
  }
  const dry = grow(st, tailN)
  return out.map((w, c) => { const o = new Float32Array(N), d = dry[c]; for (let i = 0; i < N; i++) o[i] = d[i] + w[i] * mixV; return o })
}
const FDN_BASE = [1087, 1201, 1327, 1451, 1559, 1697, 1801, 1931]
function reverbFx(chs: Chs, sr: number, p: Record<string, number>): Chs {
  const st = toStereo(chs), n = st[0].length, pre = Math.round(p.predelay * sr / 1000), rt = p.decay, tailN = Math.round((rt * 1.15 + 0.1) * sr) + pre, N = n + tailN
  const scale = (sr / 44100) * (0.35 + p.size / 100 * 0.95), M = 8
  const dl = FDN_BASE.map(d => Math.max(31, Math.round(d * scale))), bufs = dl.map(d => new Float32Array(d)), pos = new Array(M).fill(0)
  const gain = dl.map(d => Math.pow(10, -3 * d / (rt * 1.2 * sr))), damp = clampN(p.damping / 100, 0, 0.97) * 0.85, lpS = new Array(M).fill(0)
  const ap = (len: number) => ({ buf: new Float32Array(len), i: 0 }), aps = [ap(Math.round(142 * sr / 44100)), ap(Math.round(107 * sr / 44100)), ap(Math.round(379 * sr / 44100))]
  const doAp = (a: { buf: Float32Array; i: number }, x: number) => { const d = a.buf[a.i], y = -0.6 * x + d; a.buf[a.i] = x + 0.6 * y; a.i = (a.i + 1) % a.buf.length; return y }
  const preBuf = new Float32Array(Math.max(1, pre) + 1); let pp = 0
  const wl = new Float32Array(N), wr = new Float32Array(N), v = new Array(M).fill(0), sgn = [1, -1, 1, 1, -1, 1, -1, -1], norm = 1 / Math.sqrt(M)
  for (let i = 0; i < N; i++) {
    const x = i < n ? (st[0][i] + st[1][i]) * 0.5 : 0
    preBuf[pp] = x; const xd = pre > 0 ? preBuf[(pp - pre + preBuf.length) % preBuf.length] : x; pp = (pp + 1) % preBuf.length
    let inp = xd; for (const a of aps) inp = doAp(a, inp)
    for (let k = 0; k < M; k++) { const o = bufs[k][pos[k]]; lpS[k] = (1 - damp) * o + damp * lpS[k]; v[k] = lpS[k] * gain[k] }
    // fast Walsh–Hadamard (orthogonal feedback matrix)
    for (let h = 1; h < M; h *= 2) for (let a = 0; a < M; a += h * 2) for (let b = a; b < a + h; b++) { const x0 = v[b], x1 = v[b + h]; v[b] = x0 + x1; v[b + h] = x0 - x1 }
    let l = 0, r = 0
    for (let k = 0; k < M; k++) { const o = bufs[k][pos[k]]; bufs[k][pos[k]] = v[k] * norm + inp * sgn[k] * 0.35; pos[k] = (pos[k] + 1) % dl[k]; if (k % 2 === 0) l += o * sgn[(k + 3) % M]; else r += o * sgn[(k + 5) % M] }
    wl[i] = l * 0.5; wr[i] = r * 0.5
  }
  const hp = biquad('hp', p.lowcut, 0.707, 0, sr); runBiquad(wl, hp); runBiquad(wr, hp)
  const wdt = p.width / 100, mixV = p.mix / 100
  for (let i = 0; i < N; i++) { const m = (wl[i] + wr[i]) * 0.5, s = (wl[i] - wr[i]) * 0.5 * wdt; wl[i] = m + s; wr[i] = m - s }
  const dry = grow(st, tailN)
  return [wl, wr].map((w, c) => { const o = new Float32Array(N), d = dry[c]; for (let i = 0; i < N; i++) o[i] = d[i] * (1 - mixV * 0.5) + w[i] * mixV * 1.6; return o })
}

export function processSlot(slot: FxSlot, chs: Chs, sr: number): Chs {
  const p = withDefaults(slot.type, slot.p)
  switch (slot.type) {
    case 'gate': return gateFx(chs, sr, p)
    case 'compressor': return compressorFx(chs, sr, p, slot.id)
    case 'eq': return eqFx(chs, sr, p)
    case 'filter': return filterFx(chs, sr, p)
    case 'drive': return driveFx(chs, sr, p)
    case 'distortion': return distortionFx(chs, sr, p)
    case 'chorus': return chorusFx(chs, sr, p)
    case 'flanger': return flangerFx(chs, sr, p)
    case 'delay': return delayFx(chs, sr, p)
    case 'reverb': return reverbFx(chs, sr, p)
  }
}
/** transparent safety limiter so a hot chain never clips the output */
function softLimit(chs: Chs) { for (const c of chs) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > 0.9) c[i] = Math.sign(c[i]) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1)) } }
export function processChain(chs: Chs, sr: number, slots: FxSlot[]): Chs {
  const maxLen = chs[0].length + 8 * sr; let cur: Chs = chs.map(c => Float32Array.from(c))
  for (const s of slots) { if (!s.on) continue; cur = processSlot(s, cur, sr); if (cur[0].length > maxLen) cur = cur.map(c => Float32Array.from(c.subarray(0, maxLen))) }
  softLimit(cur); return cur
}

/* ------------------------- AudioBuffer integration ------------------------ */
const bufIds = new WeakMap<object, number>(); let bufSeq = 0
export const bufferId = (b: object) => { let id = bufIds.get(b); if (!id) { id = ++bufSeq; bufIds.set(b, id) } return id }
const bakeCache = new Map<string, { sig: string; buffer: AudioBuffer }>()
/** region [start,end] (ratios) of `buffer` → FX chain → new AudioBuffer (cached per key) */
export function bakeFx(key: string, buffer: AudioBuffer, region: { start: number; end: number }, slots: FxSlot[]): AudioBuffer {
  const sig = `${bufferId(buffer)}|${region.start.toFixed(5)}|${region.end.toFixed(5)}|${fxSignature(slots)}`
  const hit = bakeCache.get(key); if (hit && hit.sig === sig) return hit.buffer
  const len = buffer.length, rs = Math.max(0, Math.floor(Math.min(0.999, Math.max(0, region.start)) * len)), re = Math.min(len, Math.max(rs + 1, Math.floor(Math.min(1, Math.max(region.end, region.start + 0.001)) * len)))
  const src: Chs = Array.from({ length: buffer.numberOfChannels }, (_, c) => Float32Array.from(buffer.getChannelData(c).subarray(rs, re)))
  const out = processChain(src, buffer.sampleRate, slots)
  const res = new AudioBuffer({ length: out[0].length, numberOfChannels: out.length, sampleRate: buffer.sampleRate })
  out.forEach((c, i) => res.copyToChannel(c as Float32Array<ArrayBuffer>, i))
  bakeCache.set(key, { sig, buffer: res }); if (bakeCache.size > 120) bakeCache.delete(bakeCache.keys().next().value as string)
  return res
}

import { createRequire } from 'node:module'
import { BrowserWindow } from 'electron'

interface MidiInput {
  getPortCount(): number
  getPortName(index: number): string
  openPort(index: number): void
  openVirtualPort(name: string): void
  closePort(): void
  ignoreTypes(sysex: boolean, timing: boolean, activeSensing: boolean): void
  on(event: 'message', listener: (deltaTime: number, message: number[]) => void): void
}
interface MidiOutput {
  getPortCount(): number
  getPortName(index: number): string
  openPort(index: number): void
  closePort(): void
  sendMessage(message: number[]): void
}
interface MidiModule {
  Input: new () => MidiInput
  Output: new () => MidiOutput
}

const require = createRequire(import.meta.url)
const midi = require('@julusian/midi') as MidiModule

export interface MidiPortInfo {
  index: number
  name: string
}

/** Name of the virtual MIDI destination other apps (Logic Pro, Ableton, …) can send notes to. */
export const VIRTUAL_PORT_NAME = 'Core SX'

export interface MidiStatus {
  inputOpen: boolean
  outputOpen: boolean
  virtualOpen: boolean
  virtualName?: string
  virtualError?: string
  inputPort?: MidiPortInfo
  outputPort?: MidiPortInfo
}

let input: MidiInput | null = null
let output: MidiOutput | null = null
let virtualIn: MidiInput | null = null
let virtualError: string | undefined
let inputPort: MidiPortInfo | undefined
let outputPort: MidiPortInfo | undefined

export function listMidiPorts(): { inputs: MidiPortInfo[]; outputs: MidiPortInfo[]; likelySpd: string[] } {
  const probeIn = new midi.Input()
  const probeOut = new midi.Output()
  try {
    // our own virtual destination also shows up as an input port — hide it so it cannot be opened by mistake
    const inputs = Array.from({ length: probeIn.getPortCount() }, (_, index) => ({ index, name: probeIn.getPortName(index) })).filter((p) => p.name !== VIRTUAL_PORT_NAME)
    const outputs = Array.from({ length: probeOut.getPortCount() }, (_, index) => ({ index, name: probeOut.getPortName(index) }))
    const likelySpd = [...new Set([...inputs, ...outputs].map((p) => p.name).filter((name) => /SPD[- ]SX|SPD[- ]SX SE|SPD[- ]SX Special|Roland SPD/i.test(name)))]
    return { inputs, outputs, likelySpd }
  } finally {
    try { probeIn.closePort() } catch {}
    try { probeOut.closePort() } catch {}
  }
}

export function getMidiStatus(): MidiStatus {
  return { inputOpen: !!input, outputOpen: !!output, virtualOpen: !!virtualIn, virtualName: virtualIn ? VIRTUAL_PORT_NAME : undefined, virtualError, inputPort, outputPort }
}

function emit(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

function formatHex(message: number[]) {
  return message.map((n) => n.toString(16).padStart(2, '0').toUpperCase()).join(' ')
}

export function openMidiInput(portIndex: number) {
  closeMidiInput()
  const next = new midi.Input()
  const info = { index: portIndex, name: next.getPortName(portIndex) }
  next.ignoreTypes(false, false, false)
  next.on('message', (deltaTime, message) => {
    emit('midi:message', { direction: 'in', deltaTime, bytes: message, hex: formatHex(message), port: info })
  })
  next.openPort(portIndex)
  input = next
  inputPort = info
  emit('midi:status', getMidiStatus())
  return info
}

/** Creates (or removes) the virtual MIDI destination "Core SX". Notes sent to it play the Instrument-mode pads. */
export function setVirtualPort(enabled: boolean): MidiStatus {
  if (enabled && !virtualIn) {
    try {
      const v = new midi.Input()
      v.ignoreTypes(true, true, true)   // notes / CC / program change only — no SysEx, clock or active sensing
      v.on('message', (deltaTime, message) => {
        emit('midi:message', { direction: 'in', deltaTime, bytes: message, hex: formatHex(message), port: { index: -1, name: VIRTUAL_PORT_NAME }, virtual: true })
      })
      v.openVirtualPort(VIRTUAL_PORT_NAME)
      virtualIn = v
      virtualError = undefined
    } catch (error) {
      virtualIn = null
      virtualError = error instanceof Error ? error.message : String(error)
    }
  } else if (!enabled && virtualIn) {
    try { virtualIn.closePort() } catch {}
    virtualIn = null
    virtualError = undefined
  }
  const status = getMidiStatus()
  emit('midi:status', status)
  return status
}

export function openMidiOutput(portIndex: number) {
  closeMidiOutput()
  const next = new midi.Output()
  const info = { index: portIndex, name: next.getPortName(portIndex) }
  next.openPort(portIndex)
  output = next
  outputPort = info
  emit('midi:status', getMidiStatus())
  return info
}

export function closeMidiInput() {
  if (!input) return
  try { input.closePort() } catch {}
  input = null
  inputPort = undefined
  emit('midi:status', getMidiStatus())
}

export function closeMidiOutput() {
  if (!output) return
  try { output.closePort() } catch {}
  output = null
  outputPort = undefined
  emit('midi:status', getMidiStatus())
}

export function sendMidi(message: number[]) {
  if (!output) throw new Error('尚未開啟 MIDI Output。')
  const bytes = message.map((n) => Number(n) & 0xff)
  output.sendMessage(bytes)
  emit('midi:message', { direction: 'out', deltaTime: 0, bytes, hex: formatHex(bytes), port: outputPort })
  return bytes
}

export function sendProgramChange(channel: number, program: number) {
  const ch = Math.max(1, Math.min(16, Math.round(channel))) - 1
  const pc = Math.max(0, Math.min(127, Math.round(program)))
  return sendMidi([0xC0 | ch, pc])
}

export function sendNote(channel: number, note: number, velocity = 110) {
  const ch = Math.max(1, Math.min(16, Math.round(channel))) - 1
  const nn = Math.max(0, Math.min(127, Math.round(note)))
  const vel = Math.max(0, Math.min(127, Math.round(velocity)))
  sendMidi([0x90 | ch, nn, vel])
  if (vel > 0) setTimeout(() => { try { sendMidi([0x80 | ch, nn, 0]) } catch {} }, 60)
}

export function sendIdentityRequest(deviceId = 0x10) {
  const dev = Math.max(0x10, Math.min(0x1f, Math.round(deviceId)))
  return sendMidi([0xF0, 0x7E, dev, 0x06, 0x01, 0xF7])
}

export function closeAllMidi() {
  closeMidiInput()
  closeMidiOutput()
  setVirtualPort(false)
}

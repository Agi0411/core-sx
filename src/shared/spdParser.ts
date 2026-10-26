import fs from 'node:fs'
import path from 'node:path'
import type { KitModel, PadModel, ProjectModel, TagModel, WaveModel } from './models.js'

const text = (filePath: string) => fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')

function numericEntries(section: string): Record<string, number> {
  const out: Record<string, number> = {}
  const re = /<([A-Za-z0-9_]+)>\s*(-?\d+(?:\.\d+)?)\s*<\/\1>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(section))) out[m[1]] = Number(m[2])
  return out
}

function decodeRolandName(textValue: string): string {
  const nums = [...textValue.matchAll(/<Nm\d+>\s*(-?\d+)\s*<\/Nm\d+>/g)].map((m) => Number(m[1]))
  return nums.filter((n) => n > 0).map((n) => String.fromCharCode(n)).join('').replace(/\0/g, '').trim()
}

function tagValue(section: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)
  const m = section.match(re)
  return m?.[1]?.trim()
}

function parsePad(section: string, index: number, waves: Map<number, WaveModel>): PadModel {
  const fields = numericEntries(section)
  const waveId = fields.Wv ?? -1
  const subWaveId = fields.SubWv ?? -1
  const wave = waves.get(waveId)
  return {
    index,
    waveId,
    waveName: wave?.name,
    wavePath: wave?.path,
    waveDataPath: wave?.dataPath,
    waveTag: wave?.tagName,
    waveExists: Boolean(wave?.exists),
    waveLevel: fields.WvLevel ?? 100,
    wavePan: fields.WvPan ?? 15,
    playMode: fields.PlayMode ?? -1,
    outputAssign: fields.OutAsgn ?? 0,
    muteGroup: fields.MuteGrp ?? 0,
    tempoSync: fields.TempoSync ?? 0,
    midiChannel: fields.PadMidiCh ?? -1,
    noteNumber: fields.NoteNum ?? -1,
    midiCtrl: fields.MidiCtrl ?? 0,
    loop: fields.Loop ?? 0,
    triggerType: fields.TrigType ?? 0,
    gateTime: fields.GateTime ?? -1,
    dynamics: fields.Dynamics ?? 0,
    voiceAssign: fields.VoiceAsgn ?? 0,
    reverse: fields.Reverse ?? 0,
    subWaveId,
    subWaveLevel: fields.SubWvLevel ?? 100,
    subWavePan: fields.SubWvPan ?? 15,
    sourceFields: fields
  }
}

function parseWavePrm(prmPath: string, id: number, dataRoot: string, tags: TagModel[]): WaveModel {
  const raw = text(prmPath)
  const name = decodeRolandName(raw)
  const relPath = tagValue(raw, 'Path') ?? ''
  const tagIndex = Number(tagValue(raw, 'Tag') ?? -1)
  const parts = relPath.replaceAll('\\', '/').split('/')
  const dataPath = parts.length > 1 ? path.join(dataRoot, ...parts) : ''
  const exists = Boolean(dataPath && fs.existsSync(dataPath))
  const tagName = tags.find((t) => t.index === tagIndex)?.name
  const stat = exists ? fs.statSync(dataPath) : undefined
  return {
    id,
    bank: Math.floor(id / 100),
    slot: id % 100,
    name,
    path: relPath,
    tagIndex,
    tagName,
    dataPath,
    exists,
    sizeBytes: stat?.size,
    sourcePrmPath: prmPath
  }
}

function parseTags(filePath: string): TagModel[] {
  const raw = text(filePath)
  const sections = [...raw.matchAll(/<TagPrm>([\s\S]*?)<\/TagPrm>/g)].map((m) => m[1])
  return sections.map((section, index) => ({
    index,
    name: decodeRolandName(section),
    order: numericEntries(section).Order ?? index
  }))
}

export function parseProject(rootPath: string): ProjectModel {
  const inputRoot = path.resolve(rootPath)
  const candidates = [
    inputRoot,
    path.join(inputRoot, 'SPD-SX'),
    path.join(inputRoot, 'Roland', 'SPD-SX'),
    path.join(inputRoot, 'Roland')
  ]

  let spdRoot = candidates.find((candidate) =>
    path.basename(candidate).toUpperCase() === 'SPD-SX' &&
    fs.existsSync(path.join(candidate, 'KIT')) &&
    fs.existsSync(path.join(candidate, 'WAVE'))
  )

  if (!spdRoot) {
    const parent = candidates.find((candidate) =>
      fs.existsSync(path.join(candidate, 'SPD-SX', 'KIT')) &&
      fs.existsSync(path.join(candidate, 'SPD-SX', 'WAVE'))
    )
    if (parent) spdRoot = path.join(parent, 'SPD-SX')
  }

  if (!spdRoot) throw new Error(`找不到有效的 SPD-SX 備份資料夾：${inputRoot}`)

  const kitRoot = path.join(spdRoot, 'KIT')
  const wavePrmRoot = path.join(spdRoot, 'WAVE', 'PRM')
  const waveDataRoot = path.join(spdRoot, 'WAVE', 'DATA')
  const systemRoot = path.join(spdRoot, 'SYSTEM')
  const warnings: string[] = []

  if (!fs.existsSync(spdRoot)) throw new Error(`找不到 SPD-SX 資料夾：${spdRoot}`)

  const tags = fs.existsSync(path.join(systemRoot, 'tag_list.spd')) ? parseTags(path.join(systemRoot, 'tag_list.spd')) : []
  const waves = new Map<number, WaveModel>()
  for (const bankName of fs.existsSync(wavePrmRoot) ? fs.readdirSync(wavePrmRoot) : []) {
    if (!/^\d+$/.test(bankName)) continue
    const bank = Number(bankName)
    const bankPath = path.join(wavePrmRoot, bankName)
    for (const fileName of fs.readdirSync(bankPath)) {
      const m = fileName.match(/^(\d+)\.spd$/i)
      if (!m) continue
      const slot = Number(m[1])
      const id = bank * 100 + slot
      waves.set(id, parseWavePrm(path.join(bankPath, fileName), id, waveDataRoot, tags))
    }
  }

  const kitFiles = fs.existsSync(kitRoot)
    ? fs.readdirSync(kitRoot).filter((f) => /^kit\d+\.spd$/i.test(f)).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
    : []
  const kits: KitModel[] = kitFiles.map((fileName) => {
    const sourcePath = path.join(kitRoot, fileName)
    const raw = text(sourcePath)
    const kitHeader = raw.match(/<KitPrm>([\s\S]*?)<PadPrm>/)?.[1] ?? raw
    const values = numericEntries(kitHeader)
    const padSections = [...raw.matchAll(/<PadPrm>([\s\S]*?)<\/PadPrm>/g)].map((m) => m[1])
    const slot = Number(fileName.match(/\d+/)?.[0] ?? 0)
    return {
      slot,
      fileName,
      name: decodeRolandName(kitHeader),
      subtitle: [...raw.matchAll(/<SubNm\d+>(-?\d+)<\/SubNm\d+>/g)].map((m) => Number(m[1])).filter((n) => n > 0).map((n) => String.fromCharCode(n)).join(''),
      level: values.Level ?? 100,
      tempo: (values.Tempo ?? 1200) / 10,
      pads: padSections.map((section, index) => parsePad(section, index, waves)),
      rawText: raw,
      sourcePath
    }
  })

  for (const kit of kits) {
    for (const pad of kit.pads) {
      if (pad.waveId >= 0 && !waves.has(pad.waveId)) warnings.push(`Kit ${kit.slot} Pad ${pad.index + 1}: Wave ${pad.waveId} 找不到 PRM`)
    }
  }

  return {
    rootPath: spdRoot,
    kits,
    waves: [...waves.values()].sort((a, b) => a.id - b.id),
    tags,
    warnings: [...new Set(warnings)]
  }
}

export function encodeRolandName(value: string, max = 8): number[] {
  return Array.from(value.slice(0, max)).map((c) => c.charCodeAt(0)).concat(Array(Math.max(0, max - value.length)).fill(0))
}

export function replaceNumericTag(source: string, tag: string, value: number): string {
  const re = new RegExp(`(<${tag}>)\\s*-?\\d+(?:\\.\\d+)?(\\s*</${tag}>)`)
  if (!re.test(source)) return source
  return source.replace(re, `$1${value}$2`)
}

export function replaceRolandName(source: string, value: string, prefix = 'Nm', max = 8): string {
  let out = source
  const codes = encodeRolandName(value, max)
  codes.forEach((code, index) => {
    const tag = `${prefix}${index}`
    out = out.replace(new RegExp(`(<${tag}>)\\s*-?\\d+(\\s*</${tag}>)`), `$1${code}$2`)
  })
  return out
}

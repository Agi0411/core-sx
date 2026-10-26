import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseProject, replaceNumericTag, replaceRolandName } from '../shared/spdParser.js'
import type { KitModel, ProjectModel, DeviceStatus } from '../shared/models.js'
import { closeAllMidi, closeMidiInput, closeMidiOutput, getMidiStatus, listMidiPorts, openMidiInput, openMidiOutput, setVirtualPort, sendIdentityRequest, sendMidi, sendNote, sendProgramChange } from './midi.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// App icon (build/icon.png). Packaged macOS builds take theirs from the .icns inside the bundle;
// this is for `npm run dev` (Dock) and for Windows / Linux windows.
const appIconPath = path.join(app.getAppPath(), 'build', 'icon.png')
const hasAppIcon = fs.existsSync(appIconPath)

function createWindow() {
  const win = new BrowserWindow({
    ...(hasAppIcon ? { icon: appIconPath } : {}),
    width: 1480,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#0e1116',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // keep MIDI + audio running when Core SX is behind your DAW
      backgroundThrottling: false
    }
  })
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL)
  else win.loadFile(path.join(__dirname, '../../dist/index.html'))
}

function normalizeInput(input: string): string {
  return input.replace(/^file:\/\//, '')
}

function extractZip(zipPath: string): string {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'spd-sx-editor-'))
  execFileSync('/usr/bin/unzip', ['-q', zipPath, '-d', temp])
  return temp
}

function applyKitUpdates(kit: KitModel) {
  let raw = fs.readFileSync(kit.sourcePath, 'utf8')
  raw = replaceRolandName(raw, kit.name, 'Nm', 8)
  raw = replaceNumericTag(raw, 'Level', kit.level)
  raw = replaceNumericTag(raw, 'Tempo', Math.round(kit.tempo * 10))

  const padRe = /<PadPrm>[\s\S]*?<\/PadPrm>/g
  let padIndex = 0
  raw = raw.replace(padRe, (section) => {
    const pad = kit.pads[padIndex++]
    if (!pad) return section
    const replacements: Array<[string, number]> = [
      ['Wv', pad.waveId], ['WvLevel', pad.waveLevel], ['WvPan', pad.wavePan], ['PlayMode', pad.playMode],
      ['OutAsgn', pad.outputAssign], ['MuteGrp', pad.muteGroup], ['TempoSync', pad.tempoSync], ['PadMidiCh', pad.midiChannel],
      ['NoteNum', pad.noteNumber], ['MidiCtrl', pad.midiCtrl], ['Loop', pad.loop], ['TrigType', pad.triggerType], ['GateTime', pad.gateTime],
      ['Dynamics', pad.dynamics], ['VoiceAsgn', pad.voiceAssign], ['Reverse', pad.reverse], ['SubWv', pad.subWaveId],
      ['SubWvLevel', pad.subWaveLevel], ['SubWvPan', pad.subWavePan]
    ]
    return replacements.reduce((acc, [tag, value]) => replaceNumericTag(acc, tag, value), section)
  })
  fs.writeFileSync(kit.sourcePath, raw, 'utf8')
}

function copyRecursive(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '__MACOSX' || entry.name === '.DS_Store') continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyRecursive(s, d)
    else fs.copyFileSync(s, d)
  }
}



function safeWaveFileName(value: string) {
  const base = path.basename(value).replace(/[\/:*?"<>|]/g, '_').trim() || 'sample.wav'
  return base.toLowerCase().endsWith('.wav') ? base : `${base}.wav`
}

function firstFreeWaveId(project: ProjectModel) {
  const used = new Set(project.waves.map((w) => w.id))
  for (let id = 0; id < 500; id++) if (!used.has(id)) return id
  throw new Error('SPD-SX Wave 插槽已達 500 個上限。')
}

function tagPrmText(name: string, order: number) {
  const codes = Array.from(name.slice(0, 12)).map((c) => c.charCodeAt(0))
  const lines = Array.from({ length: 12 }, (_, i) => `\t\t<Nm${i}>${codes[i] || 0}</Nm${i}>`).join('\n')
  return `<TagPrm>\n${lines}\n\t\t<Order>${order}</Order>\n\t</TagPrm>\n`
}

function appendTag(rootPath: string, name: string) {
  const tagPath = path.join(rootPath, 'SYSTEM', 'tag_list.spd')
  if (!fs.existsSync(tagPath)) throw new Error('找不到 SYSTEM/tag_list.spd')
  let raw = fs.readFileSync(tagPath, 'utf8')
  const tags = [...raw.matchAll(/<TagPrm>([\s\S]*?)<\/TagPrm>/g)]
  const existing = tags.map((m) => decodeNameFromSection(m[1])).findIndex((v) => v.toLowerCase() === name.trim().toLowerCase())
  if (existing >= 0) return existing
  const order = tags.length
  raw = raw.replace(/<\/TagList>\s*$/i, `${tagPrmText(name.trim(), order)}<\/TagList>\n`)
  fs.writeFileSync(tagPath, raw, 'utf8')
  return order
}

function decodeNameFromSection(section: string) {
  const nums = [...section.matchAll(/<Nm\d+>\s*(-?\d+)\s*<\/Nm\d+>/g)].map((m) => Number(m[1]))
  return nums.filter((n) => n > 0).map((n) => String.fromCharCode(n)).join('').replace(/\0/g, '').trim()
}

function makeEmptyKitFromTemplate(template: KitModel, slot: number): KitModel {
  const padRe = /<PadPrm>[\s\S]*?<\/PadPrm>/g
  let raw = template.rawText
  raw = replaceRolandName(raw, `Kit ${String(slot).padStart(3, '0')}`, 'Nm', 8)
  raw = replaceNumericTag(raw, 'Level', 100)
  raw = replaceNumericTag(raw, 'Tempo', 1200)
  raw = raw.replace(padRe, (section) => {
    const defaults: Array<[string, number]> = [
      ['Wv', -1], ['WvLevel', 100], ['WvPan', 15], ['PlayMode', -1], ['OutAsgn', 0], ['MuteGrp', 0],
      ['TempoSync', 0], ['PadMidiCh', -1], ['MidiCtrl', 0], ['Loop', 0], ['TrigType', 0], ['GateTime', -1],
      ['Dynamics', 0], ['VoiceAsgn', 0], ['Reverse', 0], ['SubWv', -1], ['SubWvLevel', 100], ['SubWvPan', 15]
    ]
    return defaults.reduce((acc, [tag, value]) => replaceNumericTag(acc, tag, value), section)
  })
  return {
    ...template,
    slot,
    fileName: `kit${String(slot).padStart(3, '0')}.spd`,
    name: `Kit ${String(slot).padStart(3, '0')}`,
    subtitle: '',
    level: 100,
    tempo: 120,
    pads: template.pads.map((p, index) => ({ ...p, index, waveId: -1, waveName: undefined, wavePath: undefined, waveDataPath: undefined, waveTag: undefined, waveExists: false, waveLevel: 100, wavePan: 15, playMode: -1, subWaveId: -1, noteNumber: p.noteNumber >= 0 ? p.noteNumber : 60 + index })),
    rawText: raw,
    sourcePath: template.sourcePath,
    isNew: true
  }
}


let lastDeviceStatus: DeviceStatus = { connected: false, mode: 'DISCONNECTED', reason: '等待 SPD-SX 連接' }

function findSpdRootOnMac(): DeviceStatus {
  if (process.platform !== 'darwin') {
    return { connected: false, mode: 'DISCONNECTED', reason: `目前只啟用 macOS 偵測（${process.platform}）` }
  }

  // 1) 優先偵測 WAVE MGR：只要掛載磁碟裡存在 SPD-SX 的資料結構，
  //    就判定為 Editor 模式。
  const volumesDir = '/Volumes'
  if (fs.existsSync(volumesDir)) {
    try {
      for (const entry of fs.readdirSync(volumesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const volumePath = path.join(volumesDir, entry.name)
        const candidates = [
          path.join(volumePath, 'Roland', 'SPD-SX'),
          path.join(volumePath, 'SPD-SX')
        ]
        for (const rootPath of candidates) {
          if (fs.existsSync(path.join(rootPath, 'KIT')) && fs.existsSync(path.join(rootPath, 'WAVE'))) {
            return { connected: true, mode: 'WAVE_MGR', rootPath, volumePath, volumeName: entry.name, detectedAt: new Date().toISOString() }
          }
        }
      }
    } catch (e) {
      // 掛載掃描失敗時繼續檢查 MIDI，不把整台 App 視為斷線。
    }
  }

  // 2) 沒有儲存磁碟時，再看 CoreMIDI。這代表 SPD-SX 已經進入 AUDIO/MIDI。
  try {
    const midi = listMidiPorts()
    if (midi.likelySpd.length > 0) {
      return { connected: true, mode: 'AUDIO_MIDI', detectedAt: new Date().toISOString(), reason: `偵測到 MIDI：${midi.likelySpd.join(', ')}` }
    }
    if (midi.inputs.length || midi.outputs.length) {
      return { connected: false, mode: 'UNKNOWN', detectedAt: new Date().toISOString(), reason: '偵測到 MIDI，但沒有辨識出 SPD-SX' }
    }
  } catch (e) {
    return { connected: false, mode: 'UNKNOWN', reason: e instanceof Error ? `CoreMIDI 偵測失敗：${e.message}` : 'CoreMIDI 偵測失敗' }
  }

  return { connected: false, mode: 'DISCONNECTED', reason: '未偵測到 SPD-SX 的 WAVE MGR 或 AUDIO/MIDI 連線' }
}

function broadcastDeviceStatus(next: DeviceStatus) {
  const changed = JSON.stringify({ connected: lastDeviceStatus.connected, rootPath: lastDeviceStatus.rootPath, volumePath: lastDeviceStatus.volumePath, mode: lastDeviceStatus.mode }) !==
    JSON.stringify({ connected: next.connected, rootPath: next.rootPath, volumePath: next.volumePath, mode: next.mode })
  lastDeviceStatus = next
  if (!changed) return
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('device:status', next)
}

function syncKitsToDevice(project: ProjectModel, deviceRoot: string) {
  const kitDir = path.join(deviceRoot, 'KIT')
  fs.mkdirSync(kitDir, { recursive: true })
  let kitsSynced = 0
  for (const kit of project.kits) {
    const targetKit = path.join(kitDir, kit.fileName)
    const localKit: KitModel = { ...kit, sourcePath: targetKit }
    fs.writeFileSync(targetKit, kit.rawText, 'utf8')
    applyKitUpdates(localKit)
    kitsSynced += 1
  }
  return kitsSynced
}

function syncWavesToDevice(projectRoot: string, deviceRoot: string, wavePaths: string[]) {
  let wavesSynced = 0
  for (const wavePath of wavePaths) {
    if (!path.isAbsolute(wavePath) || !fs.existsSync(wavePath)) continue
    const rel = path.relative(projectRoot, wavePath)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
    const target = path.join(deviceRoot, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(wavePath, target)
    wavesSynced += 1
  }
  return wavesSynced
}

ipcMain.handle('device:status', async () => {
  const next = findSpdRootOnMac()
  lastDeviceStatus = next
  return next
})

let devicePollTimer: NodeJS.Timeout | undefined
function startDevicePolling() {
  if (devicePollTimer) clearInterval(devicePollTimer)
  devicePollTimer = setInterval(() => broadcastDeviceStatus(findSpdRootOnMac()), 1200)
  broadcastDeviceStatus(findSpdRootOnMac())
}

ipcMain.handle('device:syncProject', async (_event, args: { project: ProjectModel; wavePaths?: string[] }) => {
  const device = findSpdRootOnMac()
  if (!device.connected || !device.rootPath) throw new Error(device.reason || '找不到 SPD-SX')
  const project = args.project
  const kitsSynced = syncKitsToDevice(project, device.rootPath)
  const wavesSynced = syncWavesToDevice(project.rootPath, device.rootPath, args.wavePaths || [])
  return { synced: true, path: device.rootPath, kitsSynced, wavesSynced }
})


ipcMain.handle('wave:add', async (_event, args: { project: ProjectModel; tagIndex: number }) => {
  const project = args.project
  if (!project.rootPath) throw new Error('目前沒有開啟專案。')
  const result = await dialog.showOpenDialog({ title: '新增 Wave Sample', properties: ['openFile'], filters: [{ name: 'WAV Audio', extensions: ['wav', 'wave'] }] })
  if (result.canceled || !result.filePaths[0]) return null
  const source = result.filePaths[0]
  const id = firstFreeWaveId(project)
  const bank = Math.floor(id / 100)
  const slot = id % 100
  const bankName = String(bank).padStart(2, '0')
  const fileName = safeWaveFileName(source)
  const dataDir = path.join(project.rootPath, 'WAVE', 'DATA', bankName)
  const prmDir = path.join(project.rootPath, 'WAVE', 'PRM', bankName)
  fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(prmDir, { recursive: true })
  const targetData = path.join(dataDir, fileName)
  const targetPrm = path.join(prmDir, `${String(slot).padStart(2, '0')}.spd`)
  fs.copyFileSync(source, targetData)
  const encoded = Array.from(fileName.replace(/\.[^.]+$/, '').slice(0, 12)).map((c) => c.charCodeAt(0))
  const nameLines = Array.from({ length: 12 }, (_, i) => `\t<Nm${i}>${encoded[i] || 0}</Nm${i}>`).join('\n')
  const prm = `<WvPrm>\n${nameLines}\n\t<Path>${bankName}/${fileName.replace(/\\/g, '/')}</Path>\n\t<Tag>${args.tagIndex >= 0 ? args.tagIndex : 0}</Tag>\n</WvPrm>\n`
  fs.writeFileSync(targetPrm, prm, 'utf8')
  return parseProject(project.rootPath)
})

ipcMain.handle('wave:addMany', async (_event, args: { project: ProjectModel; sources: string[]; tagIndex: number }) => {
  const project = args.project
  if (!project.rootPath) throw new Error('目前沒有開啟專案。')
  const allowed = new Set(['.wav', '.wave'])
  const sources = Array.from(new Set((args.sources || []).filter(Boolean)))
  if (!sources.length) return project
  let nextProject = project
  for (const source of sources) {
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue
    const ext = path.extname(source).toLowerCase()
    if (!allowed.has(ext)) continue
    const current = parseProject(nextProject.rootPath)
    const id = firstFreeWaveId(current)
    const bank = Math.floor(id / 100)
    const slot = id % 100
    const bankName = String(bank).padStart(2, '0')
    const fileName = safeWaveFileName(source)
    const dataDir = path.join(nextProject.rootPath, 'WAVE', 'DATA', bankName)
    const prmDir = path.join(nextProject.rootPath, 'WAVE', 'PRM', bankName)
    fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(prmDir, { recursive: true })
    const targetData = path.join(dataDir, fileName)
    const targetPrm = path.join(prmDir, `${String(slot).padStart(2, '0')}.spd`)
    fs.copyFileSync(source, targetData)
    const encoded = Array.from(fileName.replace(/\.[^.]+$/, '').slice(0, 12)).map((c) => c.charCodeAt(0))
    const nameLines = Array.from({ length: 12 }, (_, i) => `\t<Nm${i}>${encoded[i] || 0}</Nm${i}>`).join('\n')
    const prm = `<WvPrm>\n${nameLines}\n\t<Path>${bankName}/${fileName.replace(/\\/g, '/')}</Path>\n\t<Tag>${args.tagIndex >= 0 ? args.tagIndex : 0}</Tag>\n</WvPrm>\n`
    fs.writeFileSync(targetPrm, prm, 'utf8')
    nextProject = parseProject(nextProject.rootPath)
  }
  return nextProject
})

ipcMain.handle('wave:delete', async (_event, args: { project: ProjectModel; waveId: number }) => {
  const project = args.project
  const wave = project.waves.find((w) => w.id === args.waveId)
  if (!wave) throw new Error('找不到指定 Wave')
  const used = project.kits.some((kit) => kit.pads.some((p) => p.waveId === wave.id || p.subWaveId === wave.id))
  if (used) throw new Error(`Wave ${wave.id} 目前仍被 Pad 使用，請先解除指派再刪除。`)
  if (wave.sourcePrmPath && fs.existsSync(wave.sourcePrmPath)) fs.unlinkSync(wave.sourcePrmPath)
  if (wave.dataPath && fs.existsSync(wave.dataPath)) fs.unlinkSync(wave.dataPath)
  return parseProject(project.rootPath)
})

ipcMain.handle('tag:add', async (_event, args: { project: ProjectModel; name: string }) => {
  const name = String(args.name || '').trim()
  if (!name) throw new Error('分類名稱不可為空。')
  const index = appendTag(args.project.rootPath, name)
  return parseProject(args.project.rootPath)
})

ipcMain.handle('project:deleteKit', async (_event, args: { project: ProjectModel; slot: number }) => {
  const project = args.project
  if (!project.rootPath) throw new Error('目前沒有開啟 SPD-SX 專案。')
  const target = project.kits.find((k) => k.slot === args.slot)
  if (!target) throw new Error(`找不到 KIT ${String(args.slot).padStart(3,'0')}`)
  const file = path.join(project.rootPath, 'KIT', target.fileName || `kit${String(args.slot).padStart(3,'0')}.spd`)
  if (fs.existsSync(file)) fs.unlinkSync(file)
  return parseProject(project.rootPath)
})

ipcMain.handle('project:createKit', async (_event, project: ProjectModel) => {
  const used = new Set(project.kits.map((kit) => kit.slot))
  let slot = 0
  while (used.has(slot) && slot < 100) slot += 1
  if (slot >= 100) throw new Error('SPD-SX Kit 已達 100 組上限。')
  const template = project.kits[0]
  if (!template) throw new Error('目前專案沒有可用的 Kit 範本。')
  return makeEmptyKitFromTemplate(template, slot)
})

ipcMain.handle('project:openDevice', async () => {
  const device = findSpdRootOnMac()
  if (!device.connected || !device.rootPath) throw new Error(device.reason || '找不到 SPD-SX 儲存裝置。請確認 SPD-SX 的 USB MODE = WAVE MGR。')
  return parseProject(device.rootPath)
})

ipcMain.handle('project:open', async () => {
  const result = await dialog.showOpenDialog({
    title: '開啟 SPD-SX 備份',
    properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'SPD-SX Backup', extensions: ['zip'] }]
  })
  if (result.canceled || !result.filePaths[0]) return null
  const selected = normalizeInput(result.filePaths[0])
  let parseRoot = selected
  let tempRoot: string | undefined
  if (fs.statSync(selected).isFile() && selected.toLowerCase().endsWith('.zip')) {
    tempRoot = extractZip(selected)
    parseRoot = tempRoot
  }
  const project = parseProject(parseRoot)
  return { ...project, tempRoot }
})

ipcMain.handle('project:export', async (_event, project: ProjectModel) => {
  const result = await dialog.showOpenDialog({
    title: '選擇 SPD-SX 匯出資料夾',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }

  const source = project.rootPath
  const destParent = result.filePaths[0]
  const stamp = new Date().toISOString().replace(/[.:]/g, '-').replace('T', '_').replace('Z', '')
  const dest = path.join(destParent, `SPD-SX-Editor-${stamp}`)
  const exportedSpdRoot = path.join(dest, 'Roland', 'SPD-SX')
  copyRecursive(source, exportedSpdRoot)

  for (const kit of project.kits) {
    const targetKit = path.join(exportedSpdRoot, 'KIT', kit.fileName)
    if (!fs.existsSync(targetKit) && kit.isNew) {
      fs.writeFileSync(targetKit, kit.rawText, 'utf8')
    }
    if (fs.existsSync(targetKit)) {
      const localKit: KitModel = { ...kit, sourcePath: targetKit }
      applyKitUpdates(localKit)
    }
  }
  shell.showItemInFolder(dest)
  return { canceled: false, path: dest }
})


const COMPUTER_AUDIO_EXTENSIONS = new Set([
  '.wav', '.wave', '.aif', '.aiff', '.aifc', '.mp3', '.ogg', '.oga', '.opus',
  '.m4a', '.mp4', '.aac', '.flac', '.webm', '.weba'
])

function listAudioFilesInDir(dirPath: string) {
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(e => e.isFile() && COMPUTER_AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map(e => {
      const filePath = path.join(dirPath, e.name)
      return { name: e.name, path: filePath, size: fs.statSync(filePath).size, extension: path.extname(e.name).toLowerCase().slice(1) }
    })
    .sort((a,b)=>a.name.localeCompare(b.name, undefined, { numeric:true, sensitivity:'base' }))
}

function scanAudioLibrary(rootPath: string) {
  if (!rootPath || !path.isAbsolute(rootPath) || !fs.existsSync(rootPath)) throw new Error('音源資料夾不存在。')
  const groups: Array<{ name: string; path: string; files: ReturnType<typeof listAudioFilesInDir> }> = []
  const seenNames = new Set<string>()
  const queue: string[] = [rootPath]
  while (queue.length) {
    const dir = queue.shift()!
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    const audio = listAudioFilesInDir(dir)
    if (audio.length) {
      const rel = path.relative(rootPath, dir)
      const baseName = rel ? path.basename(dir) : path.basename(rootPath)
      let name = baseName || 'Audio'
      if (seenNames.has(name)) name = rel ? rel.split(path.sep).join(' / ') : `${name} / Root`
      let suffix = 2
      const original = name
      while (seenNames.has(name)) name = `${original} ${suffix++}`
      seenNames.add(name)
      groups.push({ name, path: dir, files: audio })
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '__MACOSX' || entry.name.startsWith('.')) continue
      queue.push(path.join(dir, entry.name))
    }
  }
  groups.sort((a,b)=>a.name.localeCompare(b.name, undefined, { numeric:true, sensitivity:'base' }))
  return { rootPath, groups, supportedExtensions: Array.from(COMPUTER_AUDIO_EXTENSIONS).map(x=>x.slice(1)) }
}

ipcMain.handle('sound:chooseFolder', async () => {
  const result = await dialog.showOpenDialog({ title: '選擇 SPD Pad 音源資料夾', properties: ['openDirectory'] })
  return result.canceled ? null : (result.filePaths[0] || null)
})

ipcMain.handle('sound:scanLibrary', async (_event, rootPath: string) => scanAudioLibrary(rootPath))

// Read packaged UI sound effects. In development they live under public/sounds;
// in production electron-builder places them under process.resourcesPath/sounds.
ipcMain.handle('sound:readBuiltin', async (_event, style: string, fileName: string) => {
  const safeStyle = String(style || '').replace(/[^a-zA-Z0-9_-]/g, '')
  const safeName = path.basename(String(fileName || ''))
  if (!safeStyle || !safeName || safeName !== String(fileName || '')) return null
  const base = app.isPackaged ? path.join(process.resourcesPath, 'sounds') : path.join(__dirname, '../../public/sounds')
  const filePath = path.join(base, safeStyle, safeName)
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null
  const stat = fs.statSync(filePath)
  if (stat.size > 8 * 1024 * 1024) return null
  return fs.readFileSync(filePath)
})

ipcMain.handle('sound:listFiles', async (_event, dirPath: string) => listAudioFilesInDir(dirPath))

ipcMain.handle('sound:read', async (_event, filePath: string) => {
  if (!filePath || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) return null
  const stat = fs.statSync(filePath)
  if (stat.size > 128 * 1024 * 1024) throw new Error('音訊檔案超過 128 MB。')
  return fs.readFileSync(filePath)
})

ipcMain.handle('wave:read', async (_event, filePath: string) => {
  if (!filePath || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) return null
  const stat = fs.statSync(filePath)
  if (stat.size > 128 * 1024 * 1024) throw new Error('音訊檔案超過 128 MB，預覽時拒絕一次載入整個檔案。')
  return fs.readFileSync(filePath)
})


ipcMain.handle('wave:write', async (_event, args: { filePath: string; bytes: Uint8Array }) => {
  if (!args.filePath || !path.isAbsolute(args.filePath)) throw new Error('Wave 路徑無效')
  fs.writeFileSync(args.filePath, Buffer.from(args.bytes))
  return { written: true, path: args.filePath }
})

ipcMain.handle('wave:save', async (_event, args: { defaultName: string; bytes: Uint8Array }) => {
  const result = await dialog.showSaveDialog({
    title: '匯出編輯後的 Wave',
    defaultPath: args.defaultName || 'edited-wave.wav',
    filters: [{ name: 'WAV Audio', extensions: ['wav'] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  fs.writeFileSync(result.filePath, Buffer.from(args.bytes))
  shell.showItemInFolder(result.filePath)
  return { canceled: false, path: result.filePath }
})


ipcMain.handle('midi:ports', () => listMidiPorts())
ipcMain.handle('midi:status', () => getMidiStatus())
ipcMain.handle('midi:openInput', (_event, portIndex: number) => openMidiInput(Number(portIndex)))
ipcMain.handle('midi:openOutput', (_event, portIndex: number) => openMidiOutput(Number(portIndex)))
ipcMain.handle('midi:closeInput', () => { closeMidiInput(); return getMidiStatus() })
ipcMain.handle('midi:closeOutput', () => { closeMidiOutput(); return getMidiStatus() })
ipcMain.handle('midi:virtual', (_event, enabled: boolean) => setVirtualPort(!!enabled))
ipcMain.handle('midi:send', (_event, bytes: number[]) => sendMidi(bytes))
ipcMain.handle('midi:programChange', (_event, args: { channel: number; program: number }) => sendProgramChange(args.channel, args.program))
ipcMain.handle('midi:note', (_event, args: { channel: number; note: number; velocity?: number }) => sendNote(args.channel, args.note, args.velocity ?? 110))
ipcMain.handle('midi:identityRequest', (_event, deviceId?: number) => sendIdentityRequest(deviceId ?? 0x10))
ipcMain.handle('app:version', () => app.getVersion())

app.whenReady().then(() => {
  if (process.platform === 'darwin' && !app.isPackaged && hasAppIcon) app.dock?.setIcon(nativeImage.createFromPath(appIconPath))
  createWindow()
  startDevicePolling()
  app.on('will-quit', () => { closeAllMidi() })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

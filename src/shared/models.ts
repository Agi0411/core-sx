export interface PadModel {
  index: number
  waveId: number
  waveName?: string
  wavePath?: string
  waveTag?: string
  waveExists: boolean
  waveDataPath?: string
  waveLevel: number
  wavePan: number
  playMode: number
  outputAssign: number
  muteGroup: number
  tempoSync: number
  midiChannel: number
  noteNumber: number
  midiCtrl: number
  loop: number
  triggerType: number
  gateTime: number
  dynamics: number
  voiceAssign: number
  reverse: number
  subWaveId: number
  subWaveLevel: number
  subWavePan: number
  sourceFields: Record<string, number>
}

export interface KitModel {
  slot: number
  fileName: string
  name: string
  subtitle: string
  level: number
  tempo: number
  pads: PadModel[]
  rawText: string
  sourcePath: string
  isNew?: boolean
}

export interface WaveModel {
  id: number
  bank: number
  slot: number
  name: string
  path: string
  tagIndex: number
  tagName?: string
  dataPath?: string
  exists: boolean
  sizeBytes?: number
  sourcePrmPath?: string
  isNew?: boolean
}

export interface WaveformEditState {
  start: number
  end: number
  fadeIn: number
  fadeOut: number
  normalize: boolean
  pitch: number
  fadeInCurve: number
  fadeOutCurve: number
  playMode?: 'gate' | 'oneShot'
  reverse?: boolean
}


export interface TagModel {
  index: number
  name: string
  order: number
}

export interface ProjectModel {
  rootPath: string
  kits: KitModel[]
  waves: WaveModel[]
  tags: TagModel[]
  warnings: string[]
}

export interface DeviceStatus {
  connected: boolean
  rootPath?: string
  volumePath?: string
  volumeName?: string
  mode: 'WAVE_MGR' | 'AUDIO_MIDI' | 'UNKNOWN' | 'DISCONNECTED'
  detectedAt?: string
  reason?: string
}

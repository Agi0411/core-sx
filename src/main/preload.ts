import { contextBridge, ipcRenderer } from 'electron'
import type { ProjectModel, DeviceStatus } from '../shared/models.js'

contextBridge.exposeInMainWorld('spd', {
  openProject: (): Promise<ProjectModel | null> => ipcRenderer.invoke('project:open'),
  openDevice: (): Promise<ProjectModel> => ipcRenderer.invoke('project:openDevice'),
  exportProject: (project: ProjectModel) => ipcRenderer.invoke('project:export', project),
  createKit: (project: ProjectModel) => ipcRenderer.invoke('project:createKit', project),
  deleteKit: (project: ProjectModel, slot: number) => ipcRenderer.invoke('project:deleteKit', { project, slot }),
  addWave: (project: ProjectModel, tagIndex: number) => ipcRenderer.invoke('wave:add', { project, tagIndex }),
  addWaves: (project: ProjectModel, sources: string[], tagIndex: number) => ipcRenderer.invoke('wave:addMany', { project, sources, tagIndex }),
  deleteWave: (project: ProjectModel, waveId: number) => ipcRenderer.invoke('wave:delete', { project, waveId }),
  addTag: (project: ProjectModel, name: string) => ipcRenderer.invoke('tag:add', { project, name }),
  version: (): Promise<string> => ipcRenderer.invoke('app:version'),
  readWave: (filePath: string): Promise<Uint8Array | null> => ipcRenderer.invoke('wave:read', filePath),
  sound: {
    chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('sound:chooseFolder'),
    listFiles: (dirPath: string): Promise<Array<{ name: string; path: string; size: number; extension: string }>> => ipcRenderer.invoke('sound:listFiles', dirPath),
    scanLibrary: (rootPath: string) => ipcRenderer.invoke('sound:scanLibrary', rootPath),
    readFile: (filePath: string): Promise<Uint8Array | null> => ipcRenderer.invoke('sound:read', filePath),
    readBuiltin: (style: string, fileName: string): Promise<Uint8Array | null> => ipcRenderer.invoke('sound:readBuiltin', style, fileName),
  },
  saveWave: (args: { defaultName: string; bytes: Uint8Array }): Promise<{ canceled: boolean; path?: string }> => ipcRenderer.invoke('wave:save', args),
  writeWave: (args: { filePath: string; bytes: Uint8Array }): Promise<{ written: boolean; path: string }> => ipcRenderer.invoke('wave:write', args),
  getDeviceStatus: (): Promise<DeviceStatus> => ipcRenderer.invoke('device:status'),
  onDeviceStatus: (listener: (status: DeviceStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DeviceStatus) => listener(status)
    ipcRenderer.on('device:status', handler)
    return () => ipcRenderer.removeListener('device:status', handler)
  },
  syncProject: (project: ProjectModel, wavePaths: string[] = []) => ipcRenderer.invoke('device:syncProject', { project, wavePaths }),
  midi: {
    ports: () => ipcRenderer.invoke('midi:ports'),
    status: () => ipcRenderer.invoke('midi:status'),
    openInput: (portIndex: number) => ipcRenderer.invoke('midi:openInput', portIndex),
    openOutput: (portIndex: number) => ipcRenderer.invoke('midi:openOutput', portIndex),
    closeInput: () => ipcRenderer.invoke('midi:closeInput'),
    closeOutput: () => ipcRenderer.invoke('midi:closeOutput'),
    virtual: (enabled: boolean) => ipcRenderer.invoke('midi:virtual', enabled),
    send: (bytes: number[]) => ipcRenderer.invoke('midi:send', bytes),
    programChange: (channel: number, program: number) => ipcRenderer.invoke('midi:programChange', { channel, program }),
    note: (channel: number, note: number, velocity = 110) => ipcRenderer.invoke('midi:note', { channel, note, velocity }),
    identityRequest: (deviceId = 0x10) => ipcRenderer.invoke('midi:identityRequest', deviceId),
    onStatus: (listener: (status: import('../shared/midi-types.js').MidiStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: import('../shared/midi-types.js').MidiStatus) => listener(status)
      ipcRenderer.on('midi:status', handler)
      return () => ipcRenderer.removeListener('midi:status', handler)
    },
    onMessage: (listener: (message: import('../shared/midi-types.js').MidiMessageLog) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: import('../shared/midi-types.js').MidiMessageLog) => listener(message)
      ipcRenderer.on('midi:message', handler)
      return () => ipcRenderer.removeListener('midi:message', handler)
    }
  }
})

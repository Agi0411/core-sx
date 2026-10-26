import type { ProjectModel, DeviceStatus } from './models'

declare global {
  interface Window {
    spd: {
      openProject: () => Promise<ProjectModel | null>
      openDevice: () => Promise<ProjectModel>
      exportProject: (project: ProjectModel) => Promise<{ canceled: boolean; path?: string }>
      createKit: (project: ProjectModel) => Promise<import('./models').KitModel>
      deleteKit: (project: ProjectModel, slot: number) => Promise<ProjectModel>
      addWave: (project: ProjectModel, tagIndex: number) => Promise<ProjectModel | null>
      addWaves: (project: ProjectModel, sources: string[], tagIndex: number) => Promise<ProjectModel>
      deleteWave: (project: ProjectModel, waveId: number) => Promise<ProjectModel>
      addTag: (project: ProjectModel, name: string) => Promise<ProjectModel>
      version: () => Promise<string>
      readWave: (filePath: string) => Promise<Uint8Array | null>
      sound: {
        chooseFolder: () => Promise<string | null>
        listFiles: (dirPath: string) => Promise<Array<{ name: string; path: string; size: number; extension: string }>>
        scanLibrary: (rootPath: string) => Promise<{ rootPath: string; supportedExtensions: string[]; groups: Array<{ name: string; path: string; files: Array<{ name: string; path: string; size: number; extension: string }> }> }>
        readFile: (filePath: string) => Promise<Uint8Array | null>
      }
      saveWave: (args: { defaultName: string; bytes: Uint8Array }) => Promise<{ canceled: boolean; path?: string }>;
      writeWave: (args: { filePath: string; bytes: Uint8Array }) => Promise<{ written: boolean; path: string }>;
      getDeviceStatus: () => Promise<DeviceStatus>;
      onDeviceStatus: (listener: (status: DeviceStatus) => void) => () => void;
      syncProject: (project: ProjectModel, wavePaths?: string[]) => Promise<{ synced: boolean; path?: string; kitsSynced: number; wavesSynced: number; warning?: string }>
      midi: {
        ports: () => Promise<import('./midi-types').MidiPorts>
        status: () => Promise<import('./midi-types').MidiStatus>
        openInput: (portIndex: number) => Promise<import('./midi-types').MidiPortInfo>
        openOutput: (portIndex: number) => Promise<import('./midi-types').MidiPortInfo>
        closeInput: () => Promise<import('./midi-types').MidiStatus>
        closeOutput: () => Promise<import('./midi-types').MidiStatus>
        virtual: (enabled: boolean) => Promise<import('./midi-types').MidiStatus>
        send: (bytes: number[]) => Promise<number[]>
        programChange: (channel: number, program: number) => Promise<number[]>
        note: (channel: number, note: number, velocity?: number) => Promise<void>
        identityRequest: (deviceId?: number) => Promise<number[]>
        onStatus: (listener: (status: import('./midi-types').MidiStatus) => void) => () => void
        onMessage: (listener: (message: import('./midi-types').MidiMessageLog) => void) => () => void
      }
    }
  }
}

export {}

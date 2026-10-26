export interface MidiPortInfo { index: number; name: string }
export interface MidiPorts { inputs: MidiPortInfo[]; outputs: MidiPortInfo[]; likelySpd: string[] }
export interface MidiStatus { inputOpen: boolean; outputOpen: boolean; virtualOpen: boolean; virtualName?: string; virtualError?: string; inputPort?: MidiPortInfo; outputPort?: MidiPortInfo }
export interface MidiMessageLog { direction: 'in'|'out'; deltaTime: number; bytes: number[]; hex: string; port?: MidiPortInfo; virtual?: boolean }

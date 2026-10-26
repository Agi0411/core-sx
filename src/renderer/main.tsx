import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { FX_DEFS, FX_GROUPS, MAX_FX_SLOTS, FX_METERS, bakeFx, hasActiveFx, newSlot, withDefaults, formatParam, paramToUnit, unitToParam, eqResponseDb, fxSignature, type FxSlot, type FxType, type ParamSpec } from './fx'
import type { DeviceStatus, KitModel, PadModel, ProjectModel, WaveModel, WaveformEditState } from '../shared/models'

type PageId = 'editor' | 'spdPad' | 'midi' | 'settings'
type AudioSourceTab = { id: string; name: string; path: string; rootPath?: string }
type AudioFileInfo = { name: string; path: string; size: number; extension: string; duration?: number }
type SpdKitPreset = { id:string; name:string; createdAt:string; updatedAt:string; assignments:SpdPadAssignment[]; learnMap:number[]; editSettings:Record<string, WaveformEditState> }
type PadLayer = { filePath?: string; fileName?: string; sourceId?: string; volume: number; pan: number; fx?: FxSlot[] };
type SpdPadAssignment = { filePath?: string; fileName?: string; sourceId?: string; main: PadLayer; sub: PadLayer; midiNote: number; midiChannel?: number }
import type { MidiMessageLog, MidiPortInfo, MidiPorts, MidiStatus } from '../shared/midi-types'
import './styles.css'
import './sx-design.css'
import logoTile from './assets/logo-tile.png'

const emptyProject: ProjectModel = { rootPath: '', kits: [], waves: [], tags: [], warnings: [] }
const playModes: Record<number, string> = { [-1]: 'Default', 0: 'One Shot', 1: 'Shot', 2: 'Loop' }
function clone<T>(value: T): T { return structuredClone(value) }
function encodeKitNameRaw(raw:string,name:string){
  const codes=Array.from(name.slice(0,8)).map(c=>c.charCodeAt(0))
  let i=0
  return raw.replace(/<Nm(\d+)>-?\d+<\/Nm\1>/g,(m)=>{ const idx=i++; return idx<8?`<Nm${idx}>${codes[idx]||0}</Nm${idx}>`:m })
}
function replaceKitTag(raw:string,tag:string,value:number){ const re=new RegExp(`<${tag}>-?\\d+(<\/${tag}>)`); return re.test(raw)?raw.replace(re,`<${tag}>${value}$1`):raw }
function blankKitFromTemplate(template:KitModel,slot:number,rootPath:string):KitModel{
  const fileName=`kit${String(slot).padStart(3,'0')}.spd`
  const name=`Kit ${String(slot).padStart(3,'0')}`
  let raw=encodeKitNameRaw(template.rawText,name)
  raw=replaceKitTag(raw,'Level',100)
  raw=replaceKitTag(raw,'Tempo',1200)
  const padRe=/<PadPrm>[\s\S]*?<\/PadPrm>/g
  raw=raw.replace(padRe,section=>{
    const defaults:[string,number][]=[['Wv',-1],['WvLevel',100],['WvPan',15],['PlayMode',-1],['OutAsgn',0],['MuteGrp',0],['TempoSync',0],['PadMidiCh',-1],['MidiCtrl',0],['NoteNum',60],['Loop',0],['TrigType',0],['GateTime',-1],['Dynamics',0],['VoiceAsgn',0],['Reverse',0],['SubWv',-1],['SubWvLevel',100],['SubWvPan',15]]
    return defaults.reduce((acc,[tag,val])=>replaceKitTag(acc,tag,val),section)
  })
  const pads=template.pads.map(p=>({...p,waveId:-1,waveName:undefined,wavePath:undefined,waveDataPath:undefined,waveExists:false,waveLevel:100,wavePan:15,playMode:-1,outputAssign:0,muteGroup:0,tempoSync:0,midiChannel:-1,midiCtrl:0,noteNumber:p.noteNumber||60,loop:0,triggerType:0,gateTime:-1,dynamics:0,voiceAssign:0,reverse:0,subWaveId:-1,subWaveLevel:100,subWavePan:15}))
  return {...clone(template),slot,fileName,name,subtitle:'',level:100,tempo:120,pads,rawText:raw,sourcePath:`${rootPath}/KIT/${fileName}`,isNew:true}
}

function renderEditedBuffer(buffer:AudioBuffer, e:WaveformEditState):AudioBuffer{
  const out=new AudioBuffer({length:buffer.length,numberOfChannels:buffer.numberOfChannels,sampleRate:buffer.sampleRate})
  const rs=Math.max(0,Math.floor(clamp(e.start,0,0.999)*buffer.length))
  const re=Math.min(buffer.length,Math.max(rs+1,Math.floor(clamp(e.end,e.start+0.001,1)*buffer.length)))
  const len=Math.max(1,re-rs)
  for(let ch=0;ch<buffer.numberOfChannels;ch++){
    const dst=out.getChannelData(ch)
    // Reverse mirrors the WHOLE waveform first; START / END then select a range on that mirrored waveform
    const src=e.reverse?Float32Array.from(buffer.getChannelData(ch)).reverse():buffer.getChannelData(ch)
    dst.set(src)
    let selected=Float32Array.from(src.subarray(rs,re))
    const pitchRate=Math.pow(2,e.pitch/12)
    if(Math.abs(e.pitch)>0.001){const pitched=new Float32Array(len);for(let i=0;i<len;i++){const pos=Math.min(len-1,i*pitchRate),i0=Math.floor(pos),i1=Math.min(len-1,i0+1),frac=pos-i0;pitched[i]=(selected[i0]||0)*(1-frac)+(selected[i1]||0)*frac}selected=pitched}
    const fi=Math.min(len,Math.floor(e.fadeIn/Math.max(buffer.duration,.001)*len)),fo=Math.min(len,Math.floor(e.fadeOut/Math.max(buffer.duration,.001)*len))
    for(let i=0;i<len;i++){let v=selected[i];if(fi&&i<fi)v*=Math.pow(i/Math.max(1,fi-1),Math.max(.05,e.fadeInCurve*2));if(fo&&i>=len-fo)v*=Math.pow((len-1-i)/Math.max(1,fo-1),Math.max(.05,e.fadeOutCurve*2));dst[rs+i]=v}
  }
  if(e.normalize){let peak=0;for(let ch=0;ch<out.numberOfChannels;ch++){const d=out.getChannelData(ch);for(let i=rs;i<re;i++)peak=Math.max(peak,Math.abs(d[i]))}if(peak>1e-5){const mul=.98/peak;for(let ch=0;ch<out.numberOfChannels;ch++){const d=out.getChannelData(ch);for(let i=rs;i<re;i++)d[i]*=mul}}}
  return out
}
// ---- Audio engine: ONE shared AudioContext, selectable output device, optional per-PAD channel routing ----
type AudioPref={deviceId:string;routing:'stereo'|'perPad';pairs:number[];monitorId:string}
type AudioDevice={id:string;label:string;virtual:boolean}
const AUDIO_PREF_KEY='core-sx-audio-output'
const VIRTUAL_RE=/blackhole|loopback|soundflower|aggregate|multi-output|virtual|ishowu|vb-?cable|audio hijack|jack|logic/i
function readAudioPref():AudioPref{const dflt:AudioPref={deviceId:'default',routing:'stereo',pairs:Array.from({length:10},(_,i)=>i),monitorId:''};try{const r=JSON.parse(localStorage.getItem(AUDIO_PREF_KEY)||'null');if(!r)return dflt;return{deviceId:typeof r.deviceId==='string'&&r.deviceId?r.deviceId:'default',routing:r.routing==='perPad'?'perPad':'stereo',pairs:Array.isArray(r.pairs)&&r.pairs.length===10?r.pairs.map((n:unknown)=>Math.max(0,Math.floor(Number(n)||0))):dflt.pairs,monitorId:typeof r.monitorId==='string'?r.monitorId:''}}catch{return dflt}}
/** one stereo bus per channel pair → ChannelMerger → destination (also used by the offline routing test) */
function buildPadRouting(ctx:BaseAudioContext,channels:number){const pairs=Math.max(1,Math.floor(channels/2));const merger=ctx.createChannelMerger(pairs*2);merger.connect(ctx.destination);const buses=Array.from({length:pairs},(_,k)=>{const g=ctx.createGain();g.channelCount=2;g.channelCountMode='explicit';g.channelInterpretation='speakers';const sp=ctx.createChannelSplitter(2);g.connect(sp);sp.connect(merger,0,k*2);sp.connect(merger,1,k*2+1);return g});return{merger,buses,pairs}}
const audioEngine={
  mctx:null as AudioContext|null,mmaster:null as GainNode|null,
  ctx:null as AudioContext|null,master:null as GainNode|null,merger:null as ChannelMergerNode|null,buses:[] as GainNode[],maxCh:2,pref:readAudioPref(),error:'',watching:false,booting:null as Promise<AudioContext>|null,subs:new Set<()=>void>(),
  emit(){this.subs.forEach(f=>f())},
  subscribe(f:()=>void){this.subs.add(f);return()=>{this.subs.delete(f)}},
  save(){try{localStorage.setItem(AUDIO_PREF_KEY,JSON.stringify(this.pref))}catch{}},
  async get(resume=true):Promise<AudioContext>{
    if(!this.ctx||this.ctx.state==='closed'){if(!this.booting)this.booting=this.boot().finally(()=>{this.booting=null});await this.booting}
    const ctx=this.ctx as AudioContext
    if(resume&&ctx.state==='suspended')await Promise.race([ctx.resume().catch(()=>{}),new Promise(r=>setTimeout(r,500))])
    if(resume&&this.mctx&&this.mctx.state==='suspended')void this.mctx.resume().catch(()=>{})
    return ctx
  },
  async boot():Promise<AudioContext>{
    const ctx=new AudioContext({latencyHint:'interactive'});this.ctx=ctx;this.master=ctx.createGain()
    await this.applySink(false);this.watch()
    if(this.pref.monitorId)await this.openMonitor()
    return ctx
  },
  /** second output: every pad hit is also played through this device (e.g. your speakers while the main output feeds a DAW) */
  async openMonitor(){
    const id=this.pref.monitorId
    if(!id||id===this.pref.deviceId){await this.closeMonitor();if(id===this.pref.deviceId)this.pref.monitorId='';return}
    try{
      if(!this.mctx||this.mctx.state==='closed'){this.mctx=new AudioContext({latencyHint:'interactive'});this.mmaster=this.mctx.createGain();this.mmaster.connect(this.mctx.destination)}
      const any=this.mctx as any;if(typeof any.setSinkId==='function')await any.setSinkId(id==='default'?'':id)
      void this.mctx.resume().catch(()=>{})
    }catch(e){this.error=tr('輸出裝置切換失敗：{0}',(e as Error)?.message||'setSinkId');this.pref.monitorId='';await this.closeMonitor()}
  },
  async closeMonitor(){const c=this.mctx;this.mctx=null;this.mmaster=null;try{await c?.close()}catch{}},
  monitor():{ctx:AudioContext;node:GainNode}|null{return this.mctx&&this.mmaster&&this.mctx.state!=='closed'?{ctx:this.mctx,node:this.mmaster}:null},
  async setMonitor(id:string){this.pref.monitorId=id;this.error='';await this.get(false);await this.openMonitor();this.save();this.emit()},
  async applySink(emit=true){
    const ctx=this.ctx;if(!ctx)return
    const anyCtx=ctx as any,want=this.pref.deviceId==='default'?'':this.pref.deviceId,cur=typeof anyCtx.sinkId==='string'?anyCtx.sinkId:(anyCtx.sinkId&&anyCtx.sinkId.deviceId)||''
    this.error=''
    if(typeof anyCtx.setSinkId==='function'&&cur!==want){try{await anyCtx.setSinkId(want)}catch(e){this.error=tr('輸出裝置切換失敗：{0}',(e as Error)?.message||'setSinkId');if(want){this.pref.deviceId='default';try{await anyCtx.setSinkId('')}catch{}}}}
    this.maxCh=ctx.destination.maxChannelCount||2;this.rebuild()
    if(this.pref.monitorId&&this.pref.monitorId===this.pref.deviceId){this.pref.monitorId='';await this.closeMonitor()}
    this.save();if(emit)this.emit()
  },
  rebuild(){
    const ctx=this.ctx;if(!ctx||!this.master)return
    try{this.master.disconnect()}catch{};try{this.merger?.disconnect()}catch{};this.buses.forEach(b=>{try{b.disconnect()}catch{}});this.buses=[];this.merger=null
    const perPad=this.pref.routing==='perPad'&&this.maxCh>=4
    try{if(perPad){const n=Math.min(this.maxCh,32);ctx.destination.channelCount=n;ctx.destination.channelInterpretation='discrete';const r=buildPadRouting(ctx,n);this.buses=r.buses;this.merger=r.merger}else{ctx.destination.channelCount=Math.min(2,this.maxCh);ctx.destination.channelInterpretation='speakers'}}catch{this.buses=[]}
    this.master.connect(this.buses.length?this.buses[0]:ctx.destination)
  },
  /** where a PAD (or the editor preview) should connect its output */
  input(pad?:number):AudioNode{if(this.buses.length&&pad!=null){const k=(this.pref.pairs[pad]??pad)%this.buses.length;return this.buses[k]}return this.master as GainNode},
  async setDevice(id:string){this.pref.deviceId=id||'default';await this.get(false);await this.applySink()},
  async setRouting(mode:'stereo'|'perPad'){this.pref.routing=mode;this.rebuild();this.save();this.emit()},
  setPair(pad:number,pair:number){this.pref.pairs=this.pref.pairs.map((v,i)=>i===pad?pair:v);this.save();this.emit()},
  latencyMs(){const c=this.ctx;return c?Math.round(((c.baseLatency||0)+((c as any).outputLatency||0))*1000):0},
  async devices():Promise<{list:AudioDevice[];hidden:boolean}>{
    const dflt:AudioDevice={id:'default',label:tr('系統預設輸出'),virtual:false}
    try{const all=await navigator.mediaDevices.enumerateDevices();const outs=all.filter(d=>d.kind==='audiooutput'&&d.deviceId!=='communications');const hidden=outs.length>0&&outs.some(d=>!d.label);let n=0
      const list=outs.map(d=>{n++;if(d.deviceId==='default')return{id:'default',label:d.label?`${tr('系統預設輸出')} · ${d.label.replace(/^Default\s*-\s*/i,'')}`:tr('系統預設輸出'),virtual:false};return{id:d.deviceId,label:d.label||`${tr('輸出裝置')} ${n}`,virtual:VIRTUAL_RE.test(d.label||'')}})
      if(!list.some(d=>d.id==='default'))list.unshift(dflt);return{list,hidden}}catch{return{list:[dflt],hidden:false}}
  },
  async requestLabels(){try{const st=await navigator.mediaDevices.getUserMedia({audio:true});st.getTracks().forEach(t=>t.stop());return true}catch{return false}},
  watch(){if(this.watching||!navigator.mediaDevices?.addEventListener)return;this.watching=true;navigator.mediaDevices.addEventListener('devicechange',async()=>{const {list}=await this.devices();if(this.pref.deviceId!=='default'&&!list.some(d=>d.id===this.pref.deviceId)){this.pref.deviceId='default';await this.applySink();this.error=tr('先前選擇的輸出裝置已中斷，已切回系統預設')}if(this.pref.monitorId&&!list.some(d=>d.id===this.pref.monitorId)){this.pref.monitorId='';await this.closeMonitor();this.save();this.error=tr('監聽輸出裝置已中斷，已關閉監聽')}this.emit()})},
  async testTone(pad=0){const ctx=await this.get();const t=ctx.currentTime+0.02,g=ctx.createGain(),o=ctx.createOscillator();o.type='sine';o.frequency.setValueAtTime(523.25,t);o.frequency.setValueAtTime(783.99,t+0.16);g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.22,t+0.02);g.gain.setValueAtTime(0.22,t+0.28);g.gain.exponentialRampToValueAtTime(0.0005,t+0.5);o.connect(g).connect(this.input(pad));o.start(t);o.stop(t+0.55)}
}
try{if(localStorage.getItem('core-sx-debug')==='1')(window as any).__coreSx={audioEngine,buildPadRouting}}catch{}
function openSettings(tab:string){window.dispatchEvent(new CustomEvent('core-sx-nav',{detail:{page:'settings',tab}}))}
// ---- UI-wide globals (set by <App/> on every render; read by tr() and the fit logic) ----
const UI={lang:'zh-TW',fs:1,settingsTab:'',padNotes:[] as number[],lastDaw:''}
const L10N:Record<string,{en:string;ja:string;ko:string}>={
  'Core SX 是單擊取樣：Note Off 不會截斷聲音；力度會套用 PAD 靈敏度設定。':{en:'Core SX plays one-shot samples: Note Off never cuts a sound, and velocity follows the PAD sensitivity setting.',ja:'Core SX はワンショット再生です。Note Off で音は途切れず、ベロシティには PAD 感度の設定が適用されます。',ko:'Core SX는 원샷 샘플을 재생합니다. Note Off로 소리가 끊기지 않으며, 벨로시티에는 PAD 감도 설정이 적용됩니다.'},
  'DAW（Logic Pro 等）':{en:'DAW (Logic Pro etc.)',ja:'DAW（Logic Pro など）',ko:'DAW(Logic Pro 등)'},
  'External Instrument 的 Audio Input 選你的虛擬音訊裝置聲道；Core SX 上方的輸出裝置也要選同一個裝置。':{en:'Set the External Instrument’s Audio Input to a channel of your virtual audio device, and choose the same device as the output in Core SX above.',ja:'External Instrument の Audio Input に仮想オーディオデバイスのチャンネルを選び、上の Core SX の出力デバイスにも同じデバイスを選びます。',ko:'External Instrument의 Audio Input을 가상 오디오 장치의 채널로 지정하고, 위의 Core SX 출력 장치도 같은 장치로 선택하세요.'},
  '✓ 其他 App 現在可以把 MIDI 送到「{0}」':{en:'✓ Other apps can now send MIDI to “{0}”',ja:'✓ 他のアプリから「{0}」に MIDI を送れます',ko:'✓ 이제 다른 앱이 “{0}”으로 MIDI를 보낼 수 있습니다'},
  '同時監聽到':{en:'Also play through',ja:'同時にモニター出力',ko:'동시에 모니터링'},
  '在 Logic Pro 建立軟體樂器軌，插入 External Instrument，MIDI Destination 選「Core SX」。':{en:'In Logic Pro, create a Software Instrument track, insert External Instrument and set MIDI Destination to “Core SX”.',ja:'Logic Pro でソフトウェア音源トラックを作成し、External Instrument を挿入して MIDI Destination に「Core SX」を選びます。',ko:'Logic Pro에서 소프트웨어 악기 트랙을 만들고 External Instrument를 삽입한 뒤 MIDI Destination을 “Core SX”로 선택하세요.'},
  '如果錄到的聲音比 MIDI 稍晚，請調整 Logic 的錄音延遲或該軌的延遲補償。':{en:'If the recorded audio lands slightly after the MIDI, adjust Logic’s recording delay or the track’s delay compensation.',ja:'録音された音が MIDI よりわずかに遅れる場合は、Logic の録音ディレイまたはトラックのディレイ補正を調整してください。',ko:'녹음된 소리가 MIDI보다 조금 늦으면 Logic의 녹음 지연 또는 트랙의 지연 보정을 조정하세요.'},
  '尚未收到來自 DAW 的 MIDI。':{en:'No MIDI received from a DAW yet.',ja:'DAW からの MIDI はまだ受信していません。',ko:'아직 DAW에서 받은 MIDI가 없습니다.'},
  '已關閉':{en:'Off',ja:'オフ',ko:'꺼짐'},
  '把 Core SX 當作 External Instrument':{en:'Use Core SX as an External Instrument',ja:'Core SX を External Instrument として使う',ko:'Core SX를 External Instrument로 사용하기'},
  '最近收到：{0}':{en:'Last received: {0}',ja:'最後に受信：{0}',ko:'마지막 수신: {0}'},
  '每個 PAD 發聲時會同時送到這個裝置（例如你的喇叭），主輸出可以專心送給 DAW。':{en:'Every PAD hit is also played through this device (for example your speakers), so the main output can feed the DAW.',ja:'PAD を鳴らすたびに、このデバイス（たとえばスピーカー）にも同時に出力されるので、メイン出力は DAW 専用にできます。',ko:'PAD를 칠 때마다 이 장치(예: 스피커)로도 동시에 출력되므로 메인 출력은 DAW 전용으로 쓸 수 있습니다.'},
  '每個 PAD 預設對應音符 C1–A1（36–45，Logic 的 C3 = 60）；也可以在 PAD 上按 Learn，再從 Logic 彈一個音來指定。':{en:'Each PAD defaults to notes C1–A1 (36–45; Logic’s C3 = 60). You can also press Learn on a PAD and play a note from Logic to assign it.',ja:'各 PAD は既定で C1〜A1（36〜45。Logic の C3 = 60）に対応します。PAD の Learn を押して Logic から音を鳴らして割り当てることもできます。',ko:'각 PAD는 기본적으로 C1–A1(36–45, Logic의 C3 = 60) 음에 대응합니다. PAD의 Learn을 누르고 Logic에서 음을 연주해 지정할 수도 있습니다.'},
  '無法建立虛擬連接埠：{0}':{en:'Could not create the virtual port: {0}',ja:'仮想ポートを作成できません：{0}',ko:'가상 포트를 만들 수 없습니다: {0}'},
  '監聽輸出裝置已中斷，已關閉監聽':{en:'The monitor output device was disconnected — monitoring turned off',ja:'モニター出力デバイスが切断されたため、モニターをオフにしました',ko:'모니터 출력 장치의 연결이 끊어져 모니터링을 껐습니다'},
  '虛擬 MIDI 連接埠「Core SX」':{en:'Virtual MIDI port “Core SX”',ja:'仮想 MIDI ポート「Core SX」',ko:'가상 MIDI 포트 “Core SX”'},
  '關閉':{en:'Off',ja:'オフ',ko:'끄기'},
  '預設已開啟虛擬 MIDI 連接埠「Core SX」，Logic Pro 的 MIDI 目的地清單會直接看到它，不需要設定 IAC。':{en:'The virtual MIDI port “Core SX” is on by default — Logic Pro lists it as a MIDI destination right away, no IAC setup needed.',ja:'仮想 MIDI ポート「Core SX」は既定でオンです。Logic Pro の MIDI 出力先に直接表示されるので、IAC の設定は不要です。',ko:'가상 MIDI 포트 “Core SX”는 기본으로 켜져 있어 Logic Pro의 MIDI 대상 목록에 바로 나타나며 IAC 설정이 필요 없습니다.'},
  'Core SX 無法自己變成一個音訊裝置，需要先安裝虛擬音訊裝置，例如免費的 BlackHole，或 Loopback。':{en:'Core SX cannot appear as an audio device by itself. Install a virtual audio device first — for example the free BlackHole, or Loopback.',ja:'Core SX 自体はオーディオデバイスとして認識されません。先に無料の BlackHole や Loopback などの仮想オーディオデバイスをインストールしてください。',ko:'Core SX는 스스로 오디오 장치가 될 수 없습니다. 먼저 무료 BlackHole이나 Loopback 같은 가상 오디오 장치를 설치하세요.'},
  '先前選擇的輸出裝置已中斷，已切回系統預設':{en:'The previously selected output device was disconnected — switched back to the system default',ja:'以前選択した出力デバイスが切断されたため、システム既定に戻しました',ko:'이전에 선택한 출력 장치의 연결이 끊어져 시스템 기본값으로 되돌렸습니다'},
  '加入效果器':{en:'Add Effect',ja:'エフェクトを追加',ko:'이펙트 추가'},
  '動態':{en:'Dynamics',ja:'ダイナミクス',ko:'다이내믹스'},
  '匯出 WAV 時會包含效果器處理後的聲音（含殘響／延遲尾巴）':{en:'Exported WAV files include the processed sound (with reverb / delay tails)',ja:'WAV の書き出しにはエフェクト処理後の音（リバーブ／ディレイの余韻を含む）が含まれます',ko:'WAV 내보내기에는 이펙트가 적용된 소리(리버브/딜레이 꼬리 포함)가 포함됩니다'},
  '參數改變後會自動烘焙，發聲延遲與沒有效果器時相同':{en:'Parameters are baked automatically, so latency is the same as without effects',ja:'パラメーターを変更すると自動でベイクされるため、発音の遅延はエフェクトなしと同じです',ko:'매개변수를 바꾸면 자동으로 렌더링되어 이펙트가 없을 때와 지연 시간이 같습니다'},
  '啟用':{en:'Enable',ja:'有効にする',ko:'켜기'},
  '在 Logic Pro：設定 → 音訊 → 輸入裝置選同一個虛擬裝置，音軌輸入來源選對應聲道。':{en:'In Logic Pro: Settings → Audio → choose the same virtual device as Input Device, then pick the matching channel as each track’s input.',ja:'Logic Pro：設定 → オーディオ → 入力デバイスに同じ仮想デバイスを選び、トラックの入力ソースに対応するチャンネルを選びます。',ko:'Logic Pro: 설정 → 오디오 → 입력 장치로 같은 가상 장치를 선택하고, 트랙 입력 소스로 해당 채널을 고르세요.'},
  '在這裡把輸出選成該虛擬裝置。':{en:'Select that virtual device as the output here.',ja:'ここで出力にその仮想デバイスを選択します。',ko:'여기서 출력을 해당 가상 장치로 선택하세요.'},
  '失真':{en:'Distortion',ja:'ディストーション',ko:'디스토션'},
  '尚未加入效果器':{en:'No effects yet',ja:'エフェクトはまだありません',ko:'아직 이펙트가 없습니다'},
  '延遲':{en:'Latency',ja:'レイテンシー',ko:'지연'},
  '延遲與殘響':{en:'Delay & Reverb',ja:'ディレイ＆リバーブ',ko:'딜레이 & 리버브'},
  '從左側「加入效果器」開始，可拖曳調整順序':{en:'Start with “Add Effect” on the left — drag effects to reorder',ja:'左の「エフェクトを追加」から始めましょう。ドラッグで順序を変更できます',ko:'왼쪽의 “이펙트 추가”로 시작하세요. 드래그해서 순서를 바꿀 수 있습니다'},
  '想一邊錄一邊聽，請在「音訊 MIDI 設定」建立「多重輸出裝置」或「聚集裝置」。':{en:'To listen while recording, create a Multi-Output or Aggregate Device in “Audio MIDI Setup”.',ja:'録音しながらモニターするには、「Audio MIDI 設定」で「マルチ出力装置」または「集積装置」を作成します。',ko:'녹음하면서 들으려면 “오디오 MIDI 설정”에서 “다중 출력 장치” 또는 “통합 장치”를 만드세요.'},
  '拖曳左側效果器可調整順序；左側圓點是旁通開關':{en:'Drag effects in the list to reorder; the dot on the left is the bypass switch',ja:'リストのエフェクトをドラッグして順序を変更。左の丸はバイパススイッチです',ko:'목록의 이펙트를 드래그해 순서를 바꾸세요. 왼쪽 점은 바이패스 스위치입니다'},
  '效果器':{en:'Effects',ja:'エフェクト',ko:'이펙트'},
  '效果器只作用在電腦端發聲（SPD Pad 模式）；Editor 模式由 SPD-SX 本體發聲':{en:'Effects only apply to sound played by the computer (SPD Pad mode); in Editor mode the SPD-SX itself plays the sound',ja:'エフェクトはコンピューターで再生する音（SPD Pad モード）にのみ作用します。Editor モードでは SPD-SX 本体が発音します',ko:'이펙트는 컴퓨터에서 재생하는 소리(SPD Pad 모드)에만 적용됩니다. Editor 모드에서는 SPD-SX 본체가 소리를 냅니다'},
  '旁通':{en:'Bypass',ja:'バイパス',ko:'바이패스'},
  '旋鈕：上下拖曳調整（Shift 微調）、滾輪、雙擊重設':{en:'Knob: drag up/down (Shift for fine), scroll wheel, double-click to reset',ja:'ノブ：上下ドラッグで調整（Shift で微調整）、ホイール、ダブルクリックでリセット',ko:'노브: 위아래 드래그(Shift로 미세 조정), 휠, 더블클릭으로 초기화'},
  '每個 PAD 獨立聲道':{en:'Separate channels per PAD',ja:'PAD ごとに独立したチャンネル',ko:'PAD별 독립 채널'},
  '沒有偵測到虛擬音訊裝置。要把聲音送進 Logic Pro，請先安裝 BlackHole 或 Loopback。':{en:'No virtual audio device detected. To send sound into Logic Pro, install BlackHole or Loopback first.',ja:'仮想オーディオデバイスが見つかりません。Logic Pro に音を送るには、先に BlackHole または Loopback をインストールしてください。',ko:'가상 오디오 장치가 감지되지 않았습니다. Logic Pro로 소리를 보내려면 먼저 BlackHole이나 Loopback을 설치하세요.'},
  '測試音':{en:'Test sound',ja:'テスト音',ko:'테스트음'},
  '目前看不到裝置名稱（macOS 需要你允許才會提供）。':{en:'Device names are hidden right now (macOS only provides them after you allow it).',ja:'現在デバイス名は表示されていません（macOS は許可後に提供します）。',ko:'현재 장치 이름이 보이지 않습니다(macOS는 허용해야 제공합니다).'},
  '目前裝置只有 {0} 聲道。需要 4 聲道以上的裝置（例如 BlackHole 16ch）才能分 PAD 輸出，現在仍以立體聲輸出。':{en:'This device has only {0} channels. You need a device with 4+ channels (e.g. BlackHole 16ch) for per-PAD output — stereo is used for now.',ja:'このデバイスは {0} チャンネルのみです。PAD 別出力には 4 チャンネル以上のデバイス（例：BlackHole 16ch）が必要です。現在はステレオで出力しています。',ko:'이 장치는 {0}채널뿐입니다. PAD별 출력에는 4채널 이상의 장치(예: BlackHole 16ch)가 필요하며, 지금은 스테레오로 출력합니다.'},
  '移除':{en:'Remove',ja:'削除',ko:'제거'},
  '立體聲混音':{en:'Stereo mix',ja:'ステレオミックス',ko:'스테레오 믹스'},
  '等化與濾波':{en:'EQ & Filter',ja:'EQ＆フィルター',ko:'EQ & 필터'},
  '系統預設輸出':{en:'System default output',ja:'システム既定の出力',ko:'시스템 기본 출력'},
  '編輯':{en:'Edit',ja:'編集',ko:'편집'},
  '聲道':{en:'ch',ja:'ch',ko:'ch'},
  '虛擬裝置':{en:'Virtual device',ja:'仮想デバイス',ko:'가상 장치'},
  '複製':{en:'Duplicate',ja:'複製',ko:'복제'},
  '調變':{en:'Modulation',ja:'モジュレーション',ko:'모듈레이션'},
  '輸入到 Logic Pro 等 App':{en:'Send into Logic Pro and other apps',ja:'Logic Pro などのアプリに入力する',ko:'Logic Pro 등의 앱으로 보내기'},
  '輸出到':{en:'Output to',ja:'出力先',ko:'출력 대상'},
  '輸出方式':{en:'Output mode',ja:'出力方式',ko:'출력 방식'},
  '輸出裝置':{en:'Output device',ja:'出力デバイス',ko:'출력 장치'},
  '輸出裝置切換失敗：{0}':{en:'Could not switch output device: {0}',ja:'出力デバイスを切り替えられません：{0}',ko:'출력 장치를 전환하지 못했습니다: {0}'},
  '選用多聲道裝置（如 BlackHole 16ch）並開啟「每個 PAD 獨立聲道」，每個 PAD 就會進到不同的音軌。':{en:'Use a multi-channel device (e.g. BlackHole 16ch) and turn on “Separate channels per PAD” — each PAD then arrives on its own track.',ja:'BlackHole 16ch などのマルチチャンネルデバイスを使い、「PAD ごとに独立したチャンネル」をオンにすると、各 PAD が別々のトラックに入ります。',ko:'BlackHole 16ch 같은 다채널 장치를 사용하고 “PAD별 독립 채널”을 켜면 각 PAD가 서로 다른 트랙으로 들어갑니다.'},
  '重新整理':{en:'Refresh',ja:'更新',ko:'새로고침'},
  '重設參數':{en:'Reset parameters',ja:'パラメーターをリセット',ko:'매개변수 초기화'},
  '音訊輸出':{en:'Audio output',ja:'オーディオ出力',ko:'오디오 출력'},
  '音訊輸出裝置':{en:'Audio output device',ja:'オーディオ出力デバイス',ko:'오디오 출력 장치'},
  '音訊輸出設定…':{en:'Audio Output Settings…',ja:'オーディオ出力設定…',ko:'오디오 출력 설정…'},
  '預設':{en:'Presets',ja:'プリセット',ko:'프리셋'},
  '顯示裝置名稱':{en:'Show device names',ja:'デバイス名を表示',ko:'장치 이름 표시'},
  '點「加入效果器」選擇效果，每個 MAIN / SUB 最多 {0} 個':{en:'Use “Add Effect” to pick an effect — up to {0} per MAIN / SUB',ja:'「エフェクトを追加」で選択します。MAIN / SUB ごとに最大 {0} 個',ko:'“이펙트 추가”로 선택하세요. MAIN / SUB마다 최대 {0}개'},
  '(空白 Kit)':{en:'(Empty Kit)',ja:'(空のKit)',ko:'(빈 Kit)'},
  '8bit 像素顆粒大小':{en:'8bit pixel size',ja:'8bit ピクセルサイズ',ko:'8bit 픽셀 크기'},
  'AUDIO/MIDI · SPD 作為控制器':{en:'AUDIO/MIDI · SPD as controller',ja:'AUDIO/MIDI · SPD をコントローラーとして使用',ko:'AUDIO/MIDI · SPD를 컨트롤러로 사용'},
  'Avenir / 圓潤':{en:'Avenir / Rounded',ja:'Avenir / 丸ゴシック',ko:'Avenir / 둥근체'},
  'Editor PAD 已全部重置':{en:'All Editor PADs reset',ja:'Editor の全 PAD をリセットしました',ko:'Editor의 모든 PAD를 초기화했습니다'},
  'Identity Request 失敗':{en:'Identity Request failed',ja:'Identity Request に失敗しました',ko:'Identity Request 실패'},
  'KIT {0} 已有內容，是否覆蓋？':{en:'KIT {0} already has content. Overwrite?',ja:'KIT {0} には既に内容があります。上書きしますか？',ko:'KIT {0}에 이미 내용이 있습니다. 덮어쓸까요?'},
  'KIT {0} 目前是空白，無需刪除':{en:'KIT {0} is empty — nothing to delete',ja:'KIT {0} は空のため削除不要です',ko:'KIT {0}은(는) 비어 있어 삭제할 필요가 없습니다'},
  'MIDI Input 失敗':{en:'MIDI Input failed',ja:'MIDI Input に失敗しました',ko:'MIDI Input 실패'},
  'MIDI Input 失敗：{0}':{en:'MIDI Input failed: {0}',ja:'MIDI Input に失敗しました：{0}',ko:'MIDI Input 실패: {0}'},
  'MIDI Input 已連接：{0}':{en:'MIDI Input connected: {0}',ja:'MIDI Input 接続済み：{0}',ko:'MIDI Input 연결됨: {0}'},
  'MIDI Output 失敗':{en:'MIDI Output failed',ja:'MIDI Output に失敗しました',ko:'MIDI Output 실패'},
  'MIDI Output 失敗：{0}':{en:'MIDI Output failed: {0}',ja:'MIDI Output に失敗しました：{0}',ko:'MIDI Output 실패: {0}'},
  'MIDI Output 已連接：{0}':{en:'MIDI Output connected: {0}',ja:'MIDI Output 接続済み：{0}',ko:'MIDI Output 연결됨: {0}'},
  'MIDI 掃描失敗':{en:'MIDI scan failed',ja:'MIDI のスキャンに失敗しました',ko:'MIDI 검색 실패'},
  'Program Change 失敗':{en:'Program Change failed',ja:'Program Change に失敗しました',ko:'Program Change 실패'},
  'Reverse 開啟後，波形會依播放方向反轉顯示':{en:'With Reverse on, the waveform is shown in playback direction (mirrored)',ja:'Reverse をオンにすると、波形は再生方向に反転して表示されます',ko:'Reverse를 켜면 파형이 재생 방향으로 반전되어 표시됩니다'},
  'SPD Pad {0} {1} 尚未指定音源':{en:'SPD Pad {0} {1} has no audio assigned',ja:'SPD Pad {0} {1} に音源が割り当てられていません',ko:'SPD Pad {0} {1}에 음원이 지정되지 않았습니다'},
  'SPD Pad {0} 尚未指定音源':{en:'SPD Pad {0} has no audio assigned',ja:'SPD Pad {0} に音源が割り当てられていません',ko:'SPD Pad {0}에 음원이 지정되지 않았습니다'},
  'SPD Pad 已全部重置':{en:'All SPD Pads reset',ja:'SPD Pad をすべてリセットしました',ko:'SPD Pad를 모두 초기화했습니다'},
  'SysEx 傳送失敗':{en:'SysEx send failed',ja:'SysEx の送信に失敗しました',ko:'SysEx 전송 실패'},
  'SysEx 十六進位資料格式錯誤':{en:'Invalid SysEx hex data',ja:'SysEx の16進データ形式が正しくありません',ko:'SysEx 16진수 데이터 형식 오류'},
  'SysEx 已送出':{en:'SysEx sent',ja:'SysEx を送信しました',ko:'SysEx를 전송했습니다'},
  'SysEx 必須以 F0 開頭、F7 結尾':{en:'SysEx must start with F0 and end with F7',ja:'SysEx は F0 で始まり F7 で終わる必要があります',ko:'SysEx는 F0으로 시작하고 F7로 끝나야 합니다'},
  'Waveform 已變更 · 停止操作 {0} 秒後自動套用並同步':{en:'Waveform changed · auto-apply & sync {0}s after you stop',ja:'Waveform を変更しました · 操作停止の {0} 秒後に自動適用して同期します',ko:'Waveform 변경됨 · 조작을 멈추고 {0}초 후 자동 적용 및 동기화'},
  'Waveform 載入失敗':{en:'Failed to load waveform',ja:'Waveform の読み込みに失敗しました',ko:'Waveform 로드 실패'},
  'Waveform 載入失敗：{0}':{en:'Failed to load waveform: {0}',ja:'Waveform の読み込みに失敗しました：{0}',ko:'Waveform 로드 실패: {0}'},
  '↺ 重置系統設定':{en:'↺ Reset settings',ja:'↺ 設定をリセット',ko:'↺ 설정 초기화'},
  '▣ Kit 資料庫':{en:'▣ Kit Library',ja:'▣ Kit ライブラリ',ko:'▣ Kit 라이브러리'},
  '✓ KIT {0} 已刪除':{en:'✓ KIT {0} deleted',ja:'✓ KIT {0} を削除しました',ko:'✓ KIT {0} 삭제됨'},
  '✓ KIT {0} 已同步儲存到 SPD-SX':{en:'✓ KIT {0} saved and synced to SPD-SX',ja:'✓ KIT {0} を SPD-SX に保存・同期しました',ko:'✓ KIT {0}을(를) SPD-SX에 저장 및 동기화했습니다'},
  '✓ KIT {0} 已複製到 {1}':{en:'✓ KIT {0} copied to {1}',ja:'✓ KIT {0} を {1} にコピーしました',ko:'✓ KIT {0}을(를) {1}(으)로 복사했습니다'},
  '✓ KIT {0} 已重新命名':{en:'✓ KIT {0} renamed',ja:'✓ KIT {0} の名前を変更しました',ko:'✓ KIT {0} 이름이 변경되었습니다'},
  '✓ SPD-SX AUDIO/MIDI 已連線 · 自動進入 Instrument Mode':{en:'✓ SPD-SX AUDIO/MIDI connected · entering Instrument Mode',ja:'✓ SPD-SX AUDIO/MIDI に接続 · Instrument Mode に自動で切り替えます',ko:'✓ SPD-SX AUDIO/MIDI 연결됨 · Instrument Mode로 자동 전환'},
  '✓ SPD-SX WAVE MGR 已連線 · 自動進入 Core SX':{en:'✓ SPD-SX WAVE MGR connected · entering Core SX',ja:'✓ SPD-SX WAVE MGR に接続 · Core SX に自動で切り替えます',ko:'✓ SPD-SX WAVE MGR 연결됨 · Core SX로 자동 전환'},
  '✓ 套用':{en:'✓ Apply',ja:'✓ 適用',ko:'✓ 적용'},
  '✓ 已儲存 Kit：{0}':{en:'✓ Kit saved: {0}',ja:'✓ Kit を保存しました：{0}',ko:'✓ Kit 저장됨: {0}'},
  '✓ 已同步 {0} Kits{1} → {2}':{en:'✓ Synced {0} Kits{1} → {2}',ja:'✓ {0} Kits{1} を同期しました → {2}',ko:'✓ {0} Kits{1} 동기화됨 → {2}'},
  '✓ 已覆蓋 Kit：{0}':{en:'✓ Kit overwritten: {0}',ja:'✓ Kit を上書きしました：{0}',ko:'✓ Kit 덮어씀: {0}'},
  '✓ 已載入 Kit：{0}':{en:'✓ Kit loaded: {0}',ja:'✓ Kit を読み込みました：{0}',ko:'✓ Kit 불러옴: {0}'},
  '上下拖曳調整 · 方向鍵微調（Shift 加大）· 雙擊重設':{en:'Drag up/down · Arrow keys to fine-tune (Shift for larger steps) · Double-click to reset',ja:'上下ドラッグで調整 · 矢印キーで微調整（Shift で大きく）· ダブルクリックでリセット',ko:'위아래 드래그 · 방향키로 미세 조정(Shift로 크게) · 더블클릭으로 초기화'},
  '亮色':{en:'Light',ja:'ライト',ko:'라이트'},
  '亮銀':{en:'Bright Silver',ja:'ブライトシルバー',ko:'밝은 실버'},
  '位置':{en:'Position',ja:'位置',ko:'위치'},
  '使用說明':{en:'Help',ja:'使い方',ko:'사용 방법'},
  '停止 {0}s':{en:'Idle {0}s',ja:'操作停止 {0}s',ko:'정지 {0}s'},
  '儲存 Kit':{en:'Save Kit',ja:'Kit を保存',ko:'Kit 저장'},
  '先選取 PAD，再將音檔拖到 PAD 的 MAIN / SUB':{en:'Select a PAD, then drag an audio file onto its MAIN / SUB',ja:'PAD を選択し、音源をその PAD の MAIN / SUB にドラッグします',ko:'PAD를 선택한 뒤 오디오 파일을 해당 PAD의 MAIN / SUB로 드래그하세요'},
  '全部':{en:'All',ja:'すべて',ko:'전체'},
  '分類':{en:'Category',ja:'分類',ko:'분류'},
  '刪除 Kit':{en:'Delete Kit',ja:'Kit を削除',ko:'Kit 삭제'},
  '刪除 Kit 失敗':{en:'Failed to delete Kit',ja:'Kit の削除に失敗しました',ko:'Kit 삭제 실패'},
  '刪除 Kit「{0}」？':{en:'Delete Kit “{0}”?',ja:'Kit「{0}」を削除しますか？',ko:'Kit “{0}”을(를) 삭제할까요?'},
  '刪除 Sample':{en:'Delete Sample',ja:'Sample を削除',ko:'Sample 삭제'},
  '刪除 Wave 失敗':{en:'Failed to delete Wave',ja:'Wave の削除に失敗しました',ko:'Wave 삭제 실패'},
  '刪除 {0}':{en:'Delete {0}',ja:'{0} を削除',ko:'{0} 삭제'},
  '午夜藍':{en:'Midnight Blue',ja:'ミッドナイトブルー',ko:'미드나이트 블루'},
  '取消':{en:'Cancel',ja:'キャンセル',ko:'취소'},
  '古銅金':{en:'Antique Bronze',ja:'アンティークブロンズ',ko:'앤티크 브론즈'},
  '另存新 Kit':{en:'Save as new Kit',ja:'新しい Kit として保存',ko:'새 Kit로 저장'},
  '可一次選擇多個 WAV，或直接把檔案拖進此區域。':{en:'Select multiple WAV files at once, or drag files into this area.',ja:'複数の WAV をまとめて選択するか、このエリアにファイルをドラッグしてください。',ko:'WAV 파일을 여러 개 선택하거나 이 영역으로 파일을 끌어다 놓으세요.'},
  '可先選風格與推薦配色，再自行調整 RGB / HEX；設定會在右下角按「套用」後生效。':{en:'Pick a style and a suggested palette first, then fine-tune RGB / HEX. Changes take effect after pressing “Apply” at the bottom right.',ja:'先にスタイルとおすすめ配色を選び、RGB / HEX で微調整できます。右下の「適用」を押すと反映されます。',ko:'먼저 스타일과 추천 색상을 고른 뒤 RGB / HEX로 세부 조정하세요. 오른쪽 아래 “적용”을 누르면 반영됩니다.'},
  '同步中…':{en:'Syncing…',ja:'同期中…',ko:'동기화 중…'},
  '同步失敗':{en:'Sync failed',ja:'同期に失敗しました',ko:'동기화 실패'},
  '同步失敗：{0}':{en:'Sync failed: {0}',ja:'同期に失敗しました：{0}',ko:'동기화 실패: {0}'},
  '否':{en:'No',ja:'いいえ',ko:'아니요'},
  '在淡化曲線上上下拖曳，可調整曲線形狀':{en:'Drag a fade curve up or down to change its shape',ja:'フェードカーブを上下にドラッグして形状を調整できます',ko:'페이드 곡선을 위아래로 드래그해 모양을 조절하세요'},
  '在音檔上按右鍵：快速指定 MAIN / SUB → PAD':{en:'Right-click an audio file to assign it quickly: MAIN / SUB → PAD',ja:'音源を右クリック：MAIN / SUB → PAD にすばやく割り当て',ko:'오디오 파일을 우클릭: MAIN / SUB → PAD로 빠르게 지정'},
  '大 115%':{en:'Large 115%',ja:'大 115%',ko:'크게 115%'},
  '太空銀':{en:'Space Silver',ja:'スペースシルバー',ko:'스페이스 실버'},
  '字體':{en:'Font',ja:'フォント',ko:'글꼴'},
  '小 90%':{en:'Small 90%',ja:'小 90%',ko:'작게 90%'},
  '尚未開啟 SPD-SX 備份':{en:'No SPD-SX backup opened',ja:'SPD-SX のバックアップが開かれていません',ko:'SPD-SX 백업이 열려 있지 않습니다'},
  '尚無儲存的 Kit':{en:'No saved Kits yet',ja:'保存済みの Kit はありません',ko:'저장된 Kit가 없습니다'},
  '已使用':{en:'In use',ja:'使用中',ko:'사용 중'},
  '已儲存並同步到 SPD-SX':{en:'Saved and synced to SPD-SX',ja:'保存して SPD-SX に同期しました',ko:'저장하고 SPD-SX에 동기화했습니다'},
  '已刪除 Kit：{0}':{en:'Kit deleted: {0}',ja:'Kit を削除しました：{0}',ko:'Kit 삭제됨: {0}'},
  '已刪除 Wave {0} · {1}':{en:'Wave {0} deleted · {1}',ja:'Wave {0} を削除しました · {1}',ko:'Wave {0} 삭제됨 · {1}'},
  '已刪除並同步到 SPD-SX':{en:'Deleted and synced to SPD-SX',ja:'削除して SPD-SX に同期しました',ko:'삭제하고 SPD-SX에 동기화했습니다'},
  '已匯出編輯後 Wave：{0}':{en:'Edited Wave exported: {0}',ja:'編集後の Wave を書き出しました：{0}',ko:'편집한 Wave를 내보냈습니다: {0}'},
  '已匯出：{0}':{en:'Exported: {0}',ja:'書き出しました：{0}',ko:'내보냄: {0}'},
  '已新增 KIT {0}':{en:'KIT {0} added',ja:'KIT {0} を追加しました',ko:'KIT {0} 추가됨'},
  '已新增 Sample · {0} Waves':{en:'Sample added · {0} Waves',ja:'Sample を追加しました · {0} Waves',ko:'Sample 추가됨 · {0} Waves'},
  '已新增 Sample · {0} 個':{en:'Sample added · {0}',ja:'Sample を追加しました · {0} 件',ko:'Sample 추가됨 · {0}개'},
  '已新增分類：{0}':{en:'Category added: {0}',ja:'分類を追加しました：{0}',ko:'분류 추가됨: {0}'},
  '已清除 {0} {1}':{en:'Cleared {0} {1}',ja:'{0} の {1} をクリアしました',ko:'{0} {1} 비움'},
  '已清除 {0} 全部音源':{en:'Cleared all audio from {0}',ja:'{0} の音源をすべてクリアしました',ko:'{0}의 모든 음원을 비웠습니다'},
  '已變更 · 停止操作 {0} 秒後自動同步':{en:'Changed · auto-sync {0}s after you stop',ja:'変更しました · 操作停止の {0} 秒後に自動同期します',ko:'변경됨 · 조작을 멈추고 {0}초 후 자동 동기화'},
  '已載入 {0} Kits / {1} Waves':{en:'Loaded {0} Kits / {1} Waves',ja:'{0} Kits / {1} Waves を読み込みました',ko:'{0} Kits / {1} Waves 불러옴'},
  '已載入音源資料夾：{0} · {1} 分類':{en:'Audio folder loaded: {0} · {1} categories',ja:'音源フォルダを読み込みました：{0} · {1} 分類',ko:'음원 폴더 불러옴: {0} · {1}개 분류'},
  '已送出 MIDI Identity Request，等待 SPD-SX 回覆':{en:'MIDI Identity Request sent — waiting for SPD-SX to reply',ja:'MIDI Identity Request を送信しました。SPD-SX の応答を待っています',ko:'MIDI Identity Request를 전송했습니다. SPD-SX 응답 대기 중'},
  '已送出 MIDI Program Change · CH {0} · Program {1}':{en:'MIDI Program Change sent · CH {0} · Program {1}',ja:'MIDI Program Change を送信しました · CH {0} · Program {1}',ko:'MIDI Program Change 전송됨 · CH {0} · Program {1}'},
  '已連接 {0} · {1} Kits / {2} Waves':{en:'Connected {0} · {1} Kits / {2} Waves',ja:'{0} に接続しました · {1} Kits / {2} Waves',ko:'{0} 연결됨 · {1} Kits / {2} Waves'},
  '已選取音源：{0}（拖曳到 MAIN / SUB 才會指派）':{en:'Selected: {0} (drag it to MAIN / SUB to assign)',ja:'選択中の音源：{0}（MAIN / SUB にドラッグして割り当て）',ko:'선택한 음원: {0} (MAIN / SUB로 드래그해야 지정됩니다)'},
  '已選擇空白 KIT {0}，可直接編輯':{en:'Empty KIT {0} selected — ready to edit',ja:'空の KIT {0} を選択しました。そのまま編集できます',ko:'빈 KIT {0}을(를) 선택했습니다. 바로 편집할 수 있습니다'},
  '底色':{en:'Background',ja:'背景色',ko:'배경색'},
  '強調色':{en:'Accent',ja:'アクセント色',ko:'강조색'},
  '復原':{en:'Undo',ja:'元に戻す',ko:'실행 취소'},
  '找不到 Wave 音訊檔案':{en:'Wave audio file not found',ja:'Wave の音声ファイルが見つかりません',ko:'Wave 오디오 파일을 찾을 수 없습니다'},
  '找不到音訊檔案':{en:'Audio file not found',ja:'音声ファイルが見つかりません',ko:'오디오 파일을 찾을 수 없습니다'},
  '拖入音源':{en:'Drop audio',ja:'音源をドロップ',ko:'음원 놓기'},
  '拖入音源，或在音源上按右鍵指定':{en:'Drop audio here, or right-click an audio file to assign',ja:'音源をドロップするか、音源を右クリックして割り当てます',ko:'음원을 끌어다 놓거나 음원을 우클릭해 지정하세요'},
  '拖曳 START / END 把手調整播放範圍':{en:'Drag the START / END handles to set the playback range',ja:'START / END ハンドルをドラッグして再生範囲を調整',ko:'START / END 핸들을 드래그해 재생 범위를 조절'},
  '拖曳上方的方塊把手調整淡入／淡出長度':{en:'Drag the square handles at the top to set fade-in / fade-out length',ja:'上部の四角いハンドルをドラッグしてフェードイン／アウトの長さを調整',ko:'위쪽 사각 핸들을 드래그해 페이드 인/아웃 길이를 조절'},
  '拖曳白色 Start / End 手柄；拖曳黃色 Fade 手柄調整長度；滑鼠移到 Fade 曲線上會變成上下指標，可直接編輯曲線。':{en:'Drag the white Start / End handles; drag the yellow Fade handles to set length; hover a fade curve to edit it vertically.',ja:'白い Start / End ハンドルと黄色い Fade ハンドルをドラッグして調整。Fade カーブ上では上下にドラッグして形状を編集できます。',ko:'흰색 Start / End 핸들과 노란색 Fade 핸들을 드래그해 조절하세요. Fade 곡선 위에서는 위아래로 드래그해 모양을 편집할 수 있습니다.'},
  '拖曳音檔到 PAD 的 MAIN / SUB：指派音源':{en:'Drag an audio file onto a PAD’s MAIN / SUB to assign it',ja:'音源を PAD の MAIN / SUB にドラッグして割り当て',ko:'오디오 파일을 PAD의 MAIN / SUB로 드래그해 지정'},
  '推薦配色':{en:'Suggested palettes',ja:'おすすめ配色',ko:'추천 색상'},
  '搜尋 Wave / ID / Path...':{en:'Search Wave / ID / Path...',ja:'Wave / ID / パスを検索...',ko:'Wave / ID / 경로 검색...'},
  '搜尋音源名稱…':{en:'Search audio…',ja:'音源名を検索…',ko:'음원 이름 검색…'},
  '播放失敗':{en:'Playback failed',ja:'再生に失敗しました',ko:'재생 실패'},
  '播放失敗：{0}':{en:'Playback failed: {0}',ja:'再生に失敗しました：{0}',ko:'재생 실패: {0}'},
  '數值欄位：上下拖曳或用方向鍵微調（Shift 加大），雙擊重設':{en:'Value fields: drag up/down or use arrow keys to fine-tune (Shift for larger steps); double-click to reset',ja:'数値欄：上下ドラッグまたは矢印キーで微調整（Shift で大きく）、ダブルクリックでリセット',ko:'값 입력란: 위아래 드래그 또는 방향키로 미세 조정(Shift로 크게), 더블클릭으로 초기화'},
  '文字大小':{en:'Text size',ja:'文字サイズ',ko:'글자 크기'},
  '新增 Kit 失敗':{en:'Failed to add Kit',ja:'Kit の追加に失敗しました',ko:'Kit 추가 실패'},
  '新增 Sample 失敗':{en:'Failed to add Sample',ja:'Sample の追加に失敗しました',ko:'Sample 추가 실패'},
  '新增 Wave 分類名稱：':{en:'New Wave category name:',ja:'新しい Wave 分類名：',ko:'새 Wave 분류 이름:'},
  '新增分類失敗':{en:'Failed to add category',ja:'分類の追加に失敗しました',ko:'분류 추가 실패'},
  '新增標籤…':{en:'Add tag…',ja:'タグを追加…',ko:'태그 추가…'},
  '是':{en:'Yes',ja:'はい',ko:'예'},
  '暗色（預設）':{en:'Dark (default)',ja:'ダーク（既定）',ko:'다크(기본)'},
  '暮紫':{en:'Dusk Violet',ja:'ダスクバイオレット',ko:'더스크 바이올렛'},
  '未偵測到 SPD-SX 的 WAVE MGR 或 AUDIO/MIDI 連線':{en:'No WAVE MGR or AUDIO/MIDI connection detected for SPD-SX',ja:'SPD-SX の WAVE MGR または AUDIO/MIDI 接続が検出されません',ko:'SPD-SX의 WAVE MGR 또는 AUDIO/MIDI 연결이 감지되지 않았습니다'},
  '未偵測到 SPD-SX；請先連接並切換至 WAVE MGR。':{en:'SPD-SX not detected. Connect it and switch to WAVE MGR.',ja:'SPD-SX が検出されません。接続して WAVE MGR に切り替えてください。',ko:'SPD-SX가 감지되지 않았습니다. 연결 후 WAVE MGR로 전환하세요.'},
  '森林綠':{en:'Forest Green',ja:'フォレストグリーン',ko:'포레스트 그린'},
  '標準 100%':{en:'Standard 100%',ja:'標準 100%',ko:'표준 100%'},
  '標籤':{en:'Tags',ja:'タグ',ko:'태그'},
  '沒有符合條件的 Wave':{en:'No matching Waves',ja:'条件に一致する Wave がありません',ko:'조건에 맞는 Wave가 없습니다'},
  '沒有符合條件的音源':{en:'No matching audio',ja:'条件に一致する音源がありません',ko:'조건에 맞는 음원이 없습니다'},
  '深海青':{en:'Deep Sea Teal',ja:'ディープシーティール',ko:'딥씨 틸'},
  '清除':{en:'Clear',ja:'クリア',ko:'지우기'},
  '清除 MAIN':{en:'Clear MAIN',ja:'MAIN をクリア',ko:'MAIN 지우기'},
  '清除 SUB':{en:'Clear SUB',ja:'SUB をクリア',ko:'SUB 지우기'},
  '清除全部':{en:'Clear all',ja:'すべてクリア',ko:'모두 지우기'},
  '清除搜尋後可切換分類':{en:'Clear the search to switch category',ja:'検索をクリアすると分類を切り替えられます',ko:'검색을 지우면 분류를 전환할 수 있습니다'},
  '漸層':{en:'Gradient',ja:'グラデーション',ko:'그라데이션'},
  '漸層終點':{en:'Gradient end',ja:'グラデーション終点',ko:'그라데이션 끝'},
  '漸層起點':{en:'Gradient start',ja:'グラデーション始点',ko:'그라데이션 시작'},
  '瀏覽 / 拖曳 WAV 檔案至此':{en:'Browse / drop WAV files here',ja:'参照 / WAV ファイルをここにドロップ',ko:'찾아보기 / WAV 파일을 여기로 끌어다 놓기'},
  '特大 130%':{en:'X-Large 130%',ja:'特大 130%',ko:'매우 크게 130%'},
  '玫瑰金':{en:'Rose Gold',ja:'ローズゴールド',ko:'로즈 골드'},
  '琥珀':{en:'Amber',ja:'アンバー',ko:'앰버'},
  '白底黑線':{en:'White / black lines',ja:'白地に黒線',ko:'흰 배경 / 검정 선'},
  '白金':{en:'Platinum',ja:'プラチナ',ko:'플래티넘'},
  '目前 PAD 沒有可預覽的 Wave':{en:'This PAD has no Wave to preview',ja:'この PAD にはプレビューできる Wave がありません',ko:'이 PAD에는 미리 들을 Wave가 없습니다'},
  '目前 Wave 沒有可編輯的 WAV 檔':{en:'This Wave has no editable WAV file',ja:'この Wave には編集できる WAV がありません',ko:'이 Wave에는 편집할 WAV 파일이 없습니다'},
  '目前 Wave 沒有資料路徑，無法套用':{en:'This Wave has no data path and cannot be applied',ja:'この Wave にはデータパスがなく、適用できません',ko:'이 Wave에는 데이터 경로가 없어 적용할 수 없습니다'},
  '目前專案沒有可用的 Kit 範本':{en:'No Kit template is available in this project',ja:'このプロジェクトには使用できる Kit テンプレートがありません',ko:'이 프로젝트에는 사용할 수 있는 Kit 템플릿이 없습니다'},
  '石墨':{en:'Graphite',ja:'グラファイト',ko:'그래파이트'},
  '確定刪除 KIT {0}？':{en:'Delete KIT {0}?',ja:'KIT {0} を削除しますか？',ko:'KIT {0}을(를) 삭제할까요?'},
  '確定刪除 Wave {0}「{1}」？\n\n若此 Wave 正被 Pad 使用，系統會拒絕刪除。':{en:'Delete Wave {0} “{1}”?\n\nIf this Wave is used by a Pad, deletion will be refused.',ja:'Wave {0}「{1}」を削除しますか？\n\nこの Wave が Pad で使用中の場合は削除できません。',ko:'Wave {0} “{1}”을(를) 삭제할까요?\n\n이 Wave가 Pad에서 사용 중이면 삭제가 거부됩니다.'},
  '確定（同步）':{en:'Confirm (sync)',ja:'確定（同期）',ko:'확인(동기화)'},
  '確認':{en:'Confirm',ja:'確認',ko:'확인'},
  '確認儲存覆蓋':{en:'Confirm overwrite',ja:'上書きを確認',ko:'덮어쓰기 확인'},
  '確認覆蓋目前 Kit？':{en:'Overwrite the current Kit?',ja:'現在の Kit を上書きしますか？',ko:'현재 Kit를 덮어쓸까요?'},
  '空白':{en:'Empty',ja:'空',ko:'비어 있음'},
  '等寬 / 像素感':{en:'Monospace / pixel',ja:'等幅 / ピクセル風',ko:'고정폭 / 픽셀풍'},
  '等待 SPD-SX 連接':{en:'Waiting for SPD-SX…',ja:'SPD-SX の接続を待っています',ko:'SPD-SX 연결 대기 중'},
  '米白':{en:'Paper White',ja:'ペーパーホワイト',ko:'페이퍼 화이트'},
  '系統字體':{en:'System font',ja:'システムフォント',ko:'시스템 글꼴'},
  '系統預設':{en:'System default',ja:'システム既定',ko:'시스템 기본'},
  '紅底黑線':{en:'Red / black lines',ja:'赤地に黒線',ko:'빨강 배경 / 검정 선'},
  '純色':{en:'Solid',ja:'単色',ko:'단색'},
  '純金':{en:'Pure Gold',ja:'ピュアゴールド',ko:'퓨어 골드'},
  '線條色':{en:'Line color',ja:'線の色',ko:'선 색상'},
  '複製 Kit':{en:'Duplicate Kit',ja:'Kit を複製',ko:'Kit 복제'},
  '複製到哪一個 Kit？':{en:'Copy to which Kit?',ja:'どの Kit にコピーしますか？',ko:'어느 Kit로 복사할까요?'},
  '覆蓋當前 Kit':{en:'Overwrite current Kit',ja:'現在の Kit を上書き',ko:'현재 Kit 덮어쓰기'},
  '請先連接 SPD-SX 的 WAVE MGR':{en:'Connect SPD-SX in WAVE MGR mode first',ja:'先に SPD-SX を WAVE MGR で接続してください',ko:'먼저 SPD-SX를 WAVE MGR로 연결하세요'},
  '請先開啟 SPD-SX 備份':{en:'Open an SPD-SX backup first',ja:'先に SPD-SX のバックアップを開いてください',ko:'먼저 SPD-SX 백업을 여세요'},
  '請先開啟 SPD-SX 或備份':{en:'Open an SPD-SX or a backup first',ja:'先に SPD-SX またはバックアップを開いてください',ko:'먼저 SPD-SX 또는 백업을 여세요'},
  '請選擇 000–099':{en:'Choose 000–099',ja:'000–099 を選択',ko:'000–099 선택'},
  '請選擇儲存方式。':{en:'Choose how to save.',ja:'保存方法を選択してください。',ko:'저장 방식을 선택하세요.'},
  '讀取 SPD-SX 失敗':{en:'Failed to read SPD-SX',ja:'SPD-SX の読み込みに失敗しました',ko:'SPD-SX 읽기 실패'},
  '讀取中…':{en:'Loading…',ja:'読み込み中…',ko:'불러오는 중…'},
  '超大 150%':{en:'XX-Large 150%',ja:'超特大 150%',ko:'최대 150%'},
  '這會更新目前載入的儲存 Kit；若尚未載入，將以目前硬體 Kit 名稱建立。':{en:'This updates the Kit that is currently loaded. If none is loaded, a new one is created using the hardware Kit name.',ja:'現在読み込まれている保存済み Kit を更新します。未読み込みの場合は、本体の Kit 名で新規作成します。',ko:'현재 불러온 저장 Kit를 업데이트합니다. 불러온 Kit가 없으면 본체의 Kit 이름으로 새로 만듭니다.'},
  '重做':{en:'Redo',ja:'やり直す',ko:'다시 실행'},
  '重新命名':{en:'Rename',ja:'名前を変更',ko:'이름 변경'},
  '霓虹洋紅':{en:'Neon Magenta',ja:'ネオンマゼンタ',ko:'네온 마젠타'},
  '霓虹紅':{en:'Neon Red',ja:'ネオンレッド',ko:'네온 레드'},
  '霓虹紫':{en:'Neon Violet',ja:'ネオンバイオレット',ko:'네온 바이올렛'},
  '霓虹綠':{en:'Neon Green',ja:'ネオングリーン',ko:'네온 그린'},
  '霓虹藍':{en:'Neon Blue',ja:'ネオンブルー',ko:'네온 블루'},
  '霓虹黃':{en:'Neon Yellow',ja:'ネオンイエロー',ko:'네온 옐로'},
  '音源掃描失敗':{en:'Audio scan failed',ja:'音源のスキャンに失敗しました',ko:'음원 검색 실패'},
  '音源掃描失敗：{0}':{en:'Audio scan failed: {0}',ja:'音源のスキャンに失敗しました：{0}',ko:'음원 검색 실패: {0}'},
  '預覽失敗':{en:'Preview failed',ja:'プレビューに失敗しました',ko:'미리 듣기 실패'},
  '預覽失敗：{0}':{en:'Preview failed: {0}',ja:'プレビューに失敗しました：{0}',ko:'미리 듣기 실패: {0}'},
  '預設（六色）':{en:'Default (six colors)',ja:'既定（6色）',ko:'기본(6색)'},
  '顏色選擇':{en:'Colors',ja:'カラー選択',ko:'색상 선택'},
  '風格':{en:'Style',ja:'スタイル',ko:'스타일'},
  '黑底白線':{en:'Black / white lines',ja:'黒地に白線',ko:'검정 배경 / 흰 선'},
  '黑底紅線':{en:'Black / red lines',ja:'黒地に赤線',ko:'검정 배경 / 빨간 선'},
  '點擊空白處關閉。':{en:'Click an empty area to close.',ja:'空白部分をクリックすると閉じます。',ko:'빈 곳을 클릭하면 닫힙니다.'},
  '點擊音檔只會選取，不會自動指派':{en:'Clicking an audio file only selects it — it is never assigned automatically',ja:'音源のクリックは選択のみで、自動では割り当てられません',ko:'오디오 파일을 클릭하면 선택만 되며 자동으로 지정되지 않습니다'},
  '點擊音檔：選取並預覽':{en:'Click an audio file to select and preview it',ja:'音源をクリック：選択してプレビュー',ko:'오디오 파일 클릭: 선택 및 미리 듣기'},
  '點擊預覽 · 拖曳到 PAD · 雙擊指派 · × 刪除':{en:'Click to preview · drag to a PAD · double-click to assign · × delete',ja:'クリックでプレビュー · PAD へドラッグ · ダブルクリックで割り当て · × で削除',ko:'클릭: 미리 듣기 · PAD로 드래그 · 더블클릭: 지정 · × 삭제'},
  '點選 PAD 的 MAIN / SUB，或從右側拖入音源':{en:'Click a PAD’s MAIN / SUB, or drag audio in from the right',ja:'PAD の MAIN / SUB をクリックするか、右側から音源をドラッグしてください',ko:'PAD의 MAIN / SUB를 클릭하거나 오른쪽에서 음원을 끌어다 놓으세요'},
  '＋ 儲存 Kit':{en:'＋ Save Kit',ja:'＋ Kit を保存',ko:'＋ Kit 저장'},
  '＋ 新增分類':{en:'＋ New category',ja:'＋ 分類を追加',ko:'＋ 분류 추가'},
  '💾 儲存 Kit':{en:'💾 Save Kit',ja:'💾 Kit を保存',ko:'💾 Kit 저장'}
}
function tr(zh:string,...args:(string|number|null|undefined)[]){const e=L10N[zh];const l=UI.lang;const base=l==='en'?(e?.en??zh):l==='ja'?(e?.ja??zh):l==='ko'?(e?.ko??zh):zh;return args.length?base.replace(/\{(\d+)\}/g,(_m,i)=>String(args[Number(i)]??'')):base}

// ---- "?" help button + popover (rendered into .app-shell so it inherits the theme) ----
function HelpTip(props:{title?:string;lines:string[]}){
  const [open,setOpen]=useState(false)
  const btn=useRef<HTMLButtonElement>(null),pop=useRef<HTMLDivElement>(null)
  const [pos,setPos]=useState<{x:number;y:number}|null>(null)
  useLayoutEffect(()=>{if(!open){setPos(null);return}const b=btn.current?.getBoundingClientRect(),p=pop.current?.getBoundingClientRect();if(!b||!p)return;const x=clamp(b.right-p.width,8,Math.max(8,window.innerWidth-p.width-8));let y=b.bottom+8;if(y+p.height>window.innerHeight-8)y=Math.max(8,b.top-p.height-8);setPos({x,y})},[open])
  useEffect(()=>{if(!open)return;const down=(e:MouseEvent)=>{const t=e.target as Node;if(!pop.current?.contains(t)&&!btn.current?.contains(t))setOpen(false)};const key=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false)};const close=()=>setOpen(false);document.addEventListener('mousedown',down,true);document.addEventListener('keydown',key);window.addEventListener('resize',close);return()=>{document.removeEventListener('mousedown',down,true);document.removeEventListener('keydown',key);window.removeEventListener('resize',close)}},[open])
  const host=(document.querySelector('.app-shell') as HTMLElement|null)||document.body
  return <>
    <button ref={btn} type="button" className={`sx-help${open?' is-open':''}`} aria-label={props.title||tr('使用說明')} aria-expanded={open} title={props.title||tr('使用說明')} onClick={e=>{e.stopPropagation();setOpen(o=>!o)}}>?</button>
    {open&&createPortal(<div ref={pop} className="sx-help-pop" role="dialog" style={{left:pos?.x??-9999,top:pos?.y??-9999,visibility:pos?'visible':'hidden'}}>{<strong>{props.title||tr('使用說明')}</strong>}<ul>{props.lines.map((l,i)=><li key={i}>{l}</li>)}</ul></div>,host)}
  </>
}

// ---- cascading context menu: submenus open on hover (hover-intent), keyboard friendly ----
type MenuItem={label?:React.ReactNode;onSelect?:()=>void;danger?:boolean;sub?:MenuItem[];hint?:string;divider?:boolean;checked?:boolean}
function MenuPanel(props:{items:MenuItem[];title?:string;sub?:boolean;onClose:()=>void}){
  const [open,setOpen]=useState<number|null>(null)
  const timer=useRef(0),ref=useRef<HTMLDivElement>(null)
  const [shift,setShift]=useState({flip:false,dy:0})
  useLayoutEffect(()=>{if(!props.sub||!ref.current)return;const r=ref.current.getBoundingClientRect();let flip=false,dy=0;if(r.right>window.innerWidth-8)flip=true;if(r.bottom>window.innerHeight-8)dy=window.innerHeight-8-r.bottom;if(r.top+dy<8)dy=8-r.top;setShift({flip,dy})},[])
  useEffect(()=>()=>window.clearTimeout(timer.current),[])
  const hasCheck=props.items.some(i=>i.checked!==undefined)
  const enter=(i:number,hasSub:boolean)=>{window.clearTimeout(timer.current);timer.current=window.setTimeout(()=>setOpen(hasSub?i:null),hasSub?60:180)}
  return <div ref={ref} className={`sx-menu${props.sub?' is-sub':''}${shift.flip?' is-flip':''}`} style={props.sub&&shift.dy?{transform:`translateY(${shift.dy}px)`}:undefined} role="menu">
    {props.title&&<div className="sx-menu-title">{props.title}</div>}
    {props.items.map((it,i)=>it.divider?<div key={i} className="sx-menu-sep" role="separator"/>:<div key={i} className="sx-menu-row" onMouseEnter={()=>enter(i,!!it.sub)}>
      <button type="button" role="menuitem" aria-haspopup={it.sub?'menu':undefined} aria-expanded={it.sub?open===i:undefined} className={`sx-menu-item${it.danger?' is-danger':''}${open===i?' is-open':''}`} onClick={()=>{if(it.sub){setOpen(o=>o===i?null:i)}else{it.onSelect?.();props.onClose()}}}>{hasCheck&&<span className="sx-menu-check">{it.checked?'✓':''}</span>}<span className="sx-menu-label">{it.label}</span>{it.hint&&<em>{it.hint}</em>}{it.sub&&<i aria-hidden="true">›</i>}</button>
      {it.sub&&open===i&&<MenuPanel sub items={it.sub} onClose={props.onClose}/>}
    </div>)}
  </div>
}
function ContextMenu(props:{x:number;y:number;title?:string;items:MenuItem[];onClose:()=>void}){
  const ref=useRef<HTMLDivElement>(null)
  const [pos,setPos]=useState({x:props.x,y:props.y})
  useLayoutEffect(()=>{const r=ref.current?.getBoundingClientRect();if(!r)return;setPos({x:clamp(props.x,8,Math.max(8,window.innerWidth-r.width-8)),y:clamp(props.y,8,Math.max(8,window.innerHeight-r.height-8))});ref.current?.focus({preventScroll:true})},[props.x,props.y])
  useEffect(()=>{const down=(e:MouseEvent)=>{if(!ref.current?.contains(e.target as Node))props.onClose()};const close=()=>props.onClose();document.addEventListener('mousedown',down,true);window.addEventListener('blur',close);window.addEventListener('resize',close);return()=>{document.removeEventListener('mousedown',down,true);window.removeEventListener('blur',close);window.removeEventListener('resize',close)}},[])
  const onKey=(e:React.KeyboardEvent)=>{
    const root=ref.current;if(!root)return
    if(e.key==='Escape'){e.preventDefault();props.onClose();return}
    const active=document.activeElement as HTMLElement|null
    const panel=(active?.closest('.sx-menu') as HTMLElement|null)||(root.querySelector('.sx-menu') as HTMLElement)
    const items=Array.from(panel.querySelectorAll(':scope>.sx-menu-row>.sx-menu-item')) as HTMLElement[]
    const idx=active?items.indexOf(active):-1
    if(e.key==='ArrowDown'){e.preventDefault();items[(idx+1)%items.length]?.focus()}
    else if(e.key==='ArrowUp'){e.preventDefault();items[(idx<=0?items.length:idx)-1]?.focus()}
    else if(e.key==='ArrowRight'&&active?.getAttribute('aria-haspopup')){e.preventDefault();if(active.getAttribute('aria-expanded')!=='true')active.click();requestAnimationFrame(()=>(active.parentElement?.querySelector(':scope>.sx-menu .sx-menu-item') as HTMLElement|null)?.focus())}
    else if(e.key==='ArrowLeft'&&panel.classList.contains('is-sub')){e.preventDefault();const parentBtn=panel.parentElement?.querySelector(':scope>.sx-menu-item') as HTMLElement|null;parentBtn?.click();parentBtn?.focus()}
  }
  const host=(document.querySelector('.app-shell') as HTMLElement|null)||document.body
  return createPortal(<div ref={ref} className="sx-menu-root" tabIndex={-1} style={{left:pos.x,top:pos.y}} onKeyDown={onKey} onContextMenu={e=>e.preventDefault()} onClick={e=>e.stopPropagation()}><MenuPanel title={props.title} items={props.items} onClose={props.onClose}/></div>,host)
}

// ---- FitPage: guarantees a page never needs vertical scrolling.
//      1) pick the lowest layout density that fits  2) otherwise scale the page down (virtual viewport) ----
function FitPage(props:{kind:'pads'|'flow';children:React.ReactNode}){
  const wrap=useRef<HTMLDivElement>(null)
  useLayoutEffect(()=>{
    const w=wrap.current;if(!w)return
    const page=w.firstElementChild as HTMLElement|null;if(!page)return
    let raf=0,timer=0,busy=false
    const left=()=>page.querySelector('.sx-left') as HTMLElement|null
    const overflows=()=>{
      const l=left()
      if(props.kind==='pads'&&l)return l.scrollHeight-l.clientHeight>1||l.scrollWidth-l.clientWidth>1
      const els=[page,...Array.from(page.querySelectorAll('*'))] as HTMLElement[]
      for(const e of els){if(e.closest('[data-scroll-ok]'))continue;const cs=getComputedStyle(e);if(cs.display==='none')continue;const oy=cs.overflowY;if((oy==='auto'||oy==='scroll'||oy==='hidden')&&e.clientHeight>8&&e.scrollHeight-e.clientHeight>2&&cs.textOverflow!=='ellipsis')return true}
      return false
    }
    const apply=(s:number,W:number,H:number)=>{if(s>=.999){page.style.width='100%';page.style.height='100%';page.style.transform='none'}else{page.style.width=`${W/s}px`;page.style.height=`${H/s}px`;page.style.transform=`scale(${s})`}}
    const contentH=(l:HTMLElement)=>{const k=Array.from(l.children) as HTMLElement[];if(!k.length)return 0;return k[k.length-1].offsetTop+k[k.length-1].offsetHeight-k[0].offsetTop}
    const run=()=>{
      if(busy)return;busy=true
      try{
        const W=w.clientWidth,H=w.clientHeight;if(W<80||H<80)return
        let s=1;apply(1,W,H)
        const l=left()
        if(props.kind==='pads'&&l){
          const stageMin=150;let ok=false,level=0
          for(level=0;level<=3;level++){l.dataset.density=String(level);l.style.setProperty('--sx-stage-h',stageMin+'px');if(!overflows()){ok=true;break}}
          if(!ok){l.dataset.density='3';for(s=.96;s>=.6;s-=.04){apply(s,W,H);if(!overflows()){ok=true;break}}if(!ok)s=.6}
          const cs=getComputedStyle(l),avail=l.clientHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom),slack=avail-contentH(l)
          l.style.setProperty('--sx-stage-h',clamp(stageMin+slack,stageMin,Math.max(300,(H/s)*.42))+'px')
        }else{for(s=1;s>=.6;s-=.04){apply(s,W,H);if(!overflows())break}}
      }finally{busy=false}
    }
    const schedule=()=>{window.clearTimeout(timer);timer=window.setTimeout(()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(run)},60)}
    run()
    const ro=new ResizeObserver(schedule);ro.observe(w)
    const mo=new MutationObserver(schedule);mo.observe(page,{childList:true,subtree:true,attributes:true,attributeFilter:['class']})
    document.fonts?.ready?.then(schedule)
    return()=>{ro.disconnect();mo.disconnect();window.clearTimeout(timer);cancelAnimationFrame(raf)}
  },[props.kind,UI.fs,UI.lang])
  return <div className="sx-fitwrap" ref={wrap}>{props.children}</div>
}

// ---- rotary knob (Logic / macOS style) ----
function Knob(props:{spec:ParamSpec;value:number;label?:string;onChange:(v:number)=>void}){
  const {spec,value}=props,t=paramToUnit(spec,value),bipolar=spec.min<0&&spec.max>0&&!spec.log,t0=bipolar?paramToUnit(spec,0):0
  const ang=(u:number)=>-135+270*u,pt=(r:number,a:number)=>[28+r*Math.sin(a*Math.PI/180),28-r*Math.cos(a*Math.PI/180)]
  const arc=(a0:number,a1:number,r:number)=>{const [x0,y0]=pt(r,a0),[x1,y1]=pt(r,a1);return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${Math.abs(a1-a0)>180?1:0} ${a1>=a0?1:0} ${x1.toFixed(2)} ${y1.toFixed(2)}`}
  const ref=useRef<HTMLDivElement>(null),latest=useRef(props);latest.current=props
  const set=(u:number)=>latest.current.onChange(unitToParam(latest.current.spec,u))
  useEffect(()=>{const el=ref.current;if(!el)return;const wheel=(e:WheelEvent)=>{e.preventDefault();const L=latest.current;set(paramToUnit(L.spec,L.value)-e.deltaY/(e.shiftKey?5000:1100))};el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel)},[])
  const down=(e:React.PointerEvent<HTMLDivElement>)=>{e.preventDefault();const el=e.currentTarget;el.focus();el.setPointerCapture(e.pointerId);const y0=e.clientY,u0=paramToUnit(spec,latest.current.value)
    const move=(ev:PointerEvent)=>set(u0+(y0-ev.clientY)/(ev.shiftKey?800:170)),up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',up)}
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',up)}
  const key=(e:React.KeyboardEvent)=>{const d=e.key==='ArrowUp'||e.key==='ArrowRight'?1:e.key==='ArrowDown'||e.key==='ArrowLeft'?-1:0;if(e.key==='Home'){e.preventDefault();set(0)}else if(e.key==='End'){e.preventDefault();set(1)}else if(d){e.preventDefault();set(t+d*(e.shiftKey?0.1:0.01))}}
  const a=ang(t),[ix0,iy0]=pt(6,a),[ix1,iy1]=pt(13.5,a),text=formatParam(spec,value)
  return <div ref={ref} className="sx-knob" role="slider" tabIndex={0} aria-label={props.label||spec.label} aria-valuemin={spec.min} aria-valuemax={spec.max} aria-valuenow={Number(value.toFixed(3))} aria-valuetext={text} title={tr('旋鈕：上下拖曳調整（Shift 微調）、滾輪、雙擊重設')} onPointerDown={down} onKeyDown={key} onDoubleClick={()=>props.onChange(spec.def)}>
    <span className="sx-knob-label">{props.label||spec.label}</span>
    <svg viewBox="0 0 56 56" className="sx-knob-dial" aria-hidden="true"><path className="trk" d={arc(-135,135,23)}/>{Math.abs(t-t0)>0.002&&<path className="val" d={arc(ang(t0),a,23)}/>}<circle className="cap" cx="28" cy="28" r="16.5"/><line className="ind" x1={ix0.toFixed(2)} y1={iy0.toFixed(2)} x2={ix1.toFixed(2)} y2={iy1.toFixed(2)}/></svg>
    <span className="sx-knob-value">{text}</span>
  </div>
}
// ---- channel EQ: response curve with draggable band nodes ----
function EqPanel(props:{slot:FxSlot;onParams:(patch:Record<string,number>)=>void}){
  const p=withDefaults('eq',props.slot.p),[band,setBand]=useState(1),wrap=useRef<HTMLDivElement>(null),[w,setW]=useState(520),H=118
  useEffect(()=>{const el=wrap.current;if(!el)return;const fit=()=>setW(Math.max(220,el.clientWidth));fit();const ro=new ResizeObserver(fit);ro.observe(el);return()=>ro.disconnect()},[])
  const bands=[{n:'LOW',f:'lf',g:'lg',q:''},{n:'LOW MID',f:'m1f',g:'m1g',q:'m1q'},{n:'HIGH MID',f:'m2f',g:'m2g',q:'m2q'},{n:'HIGH',f:'hf',g:'hg',q:''}]
  const spec=(k:string)=>FX_DEFS.eq.params.find(x=>x.key===k) as ParamSpec
  const xf=(f:number)=>Math.log(f/20)/Math.log(1000)*w,fx=(x:number)=>20*Math.pow(1000,clamp(x/w,0,1)),gy=(g:number)=>H/2-(g/18)*(H/2-9),yg=(y:number)=>-(y-H/2)/(H/2-9)*18
  const pts:string[]=[];for(let x=0;x<=w;x+=3)pts.push(`${x},${gy(clamp(eqResponseDb(p,fx(x)),-18,18)).toFixed(1)}`)
  const line='M'+pts.join(' L'),area=`${line} L${w},${gy(0)} L0,${gy(0)} Z`
  const drag=(i:number)=>(e:React.PointerEvent<SVGCircleElement>)=>{e.preventDefault();e.stopPropagation();setBand(i);const svg=(e.currentTarget.ownerSVGElement as SVGSVGElement),b=bands[i];e.currentTarget.setPointerCapture(e.pointerId)
    const move=(ev:PointerEvent)=>{const r=svg.getBoundingClientRect(),x=ev.clientX-r.left,y=ev.clientY-r.top;props.onParams({[b.f]:clamp(fx(x),spec(b.f).min,spec(b.f).max),[b.g]:clamp(yg(y),-18,18)})}
    const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',up)}
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',up)}
  const wheel=(i:number)=>(e:React.WheelEvent)=>{const b=bands[i];if(!b.q)return;const sp=spec(b.q);props.onParams({[b.q]:unitToParam(sp,paramToUnit(sp,p[b.q])-e.deltaY/900)})}
  const cur=bands[band],grid=[100,1000,10000]
  return <div className="sx-eq">
    <div className="sx-eq-plot" ref={wrap}><svg width={w} height={H} role="img" aria-label="EQ">
      {[-12,-6,0,6,12].map(g=><line key={g} className={g===0?'zero':'grid'} x1="0" x2={w} y1={gy(g)} y2={gy(g)}/>)}
      {grid.map(f=><g key={f}><line className="grid" y1="0" y2={H} x1={xf(f)} x2={xf(f)}/><text x={xf(f)+4} y={H-4}>{f>=1000?`${f/1000}k`:f}</text></g>)}
      <path className="area" d={area}/><path className="curve" d={line}/>
      {bands.map((b,i)=><circle key={b.n} className={`node${i===band?' on':''}`} cx={xf(p[b.f])} cy={gy(p[b.g])} r={i===band?8:6.5} onPointerDown={drag(i)} onWheel={wheel(i)} onDoubleClick={()=>props.onParams({[b.g]:0})}/>)}
    </svg></div>
    <div className="sx-eq-bands" role="tablist">{bands.map((b,i)=><button key={b.n} type="button" role="tab" aria-selected={i===band} className={i===band?'on':''} onClick={()=>setBand(i)}>{b.n}</button>)}</div>
    <div className="sx-fx-knobs"><Knob spec={spec(cur.f)} label="FREQ" value={p[cur.f]} onChange={v=>props.onParams({[cur.f]:v})}/><Knob spec={spec(cur.g)} label="GAIN" value={p[cur.g]} onChange={v=>props.onParams({[cur.g]:v})}/>{cur.q&&<Knob spec={spec(cur.q)} label="Q" value={p[cur.q]} onChange={v=>props.onParams({[cur.q]:v})}/>}</div>
  </div>
}
function fxGroupLabel(id:string){return id==='dynamics'?tr('動態'):id==='eq'?tr('等化與濾波'):id==='distortion'?tr('失真'):id==='modulation'?tr('調變'):tr('延遲與殘響')}
// ---- effect rack: insert slots (Logic-style channel strip) + the selected effect's panel ----
function FxRack(props:{slots:FxSlot[];onChange:(s:FxSlot[])=>void;bakeKey:string;srcSig:string;makeSource:()=>{buffer:AudioBuffer;start:number;end:number}|null}){
  const slotsRef=useRef(props.slots);slotsRef.current=props.slots
  const [sel,setSel]=useState<string|null>(props.slots[0]?.id||null)
  useEffect(()=>{if(sel&&!props.slots.some(x=>x.id===sel))setSel(props.slots[0]?.id||null);else if(!sel&&props.slots[0])setSel(props.slots[0].id)},[props.slots,sel])
  const [menu,setMenu]=useState<null|{x:number;y:number;kind:'add'|'slot'|'preset';id?:string}>(null)
  const [drag,setDrag]=useState<{id:string;over:string|null}|null>(null)
  const selected=props.slots.find(x=>x.id===sel)||null,def=selected?FX_DEFS[selected.type]:null
  const commit=(next:FxSlot[])=>props.onChange(next)
  const setParams=(id:string,patch:Record<string,number>)=>commit(slotsRef.current.map(x=>x.id===id?{...x,p:{...x.p,...patch}}:x))
  const toggle=(id:string)=>commit(slotsRef.current.map(x=>x.id===id?{...x,on:!x.on}:x))
  const remove=(id:string)=>commit(slotsRef.current.filter(x=>x.id!==id))
  const add=(t:FxType)=>{const n=newSlot(t);commit([...slotsRef.current,n]);setSel(n.id)}
  const duplicate=(id:string)=>{const arr=slotsRef.current,i=arr.findIndex(x=>x.id===id);if(i<0||arr.length>=MAX_FX_SLOTS)return;const c={...arr[i],id:newSlot(arr[i].type).id,p:{...arr[i].p}};commit([...arr.slice(0,i+1),c,...arr.slice(i+1)]);setSel(c.id)}
  const reorder=(from:string,to:string)=>{if(from===to)return;const arr=[...slotsRef.current],a=arr.findIndex(x=>x.id===from),b=arr.findIndex(x=>x.id===to);if(a<0||b<0)return;const [m]=arr.splice(a,1);arr.splice(b,0,m);commit(arr)}
  const openMenu=(e:React.MouseEvent,kind:'add'|'slot'|'preset',id?:string,anchor?:boolean)=>{e.preventDefault();e.stopPropagation();const r=(e.currentTarget as HTMLElement).getBoundingClientRect();setMenu({x:anchor?r.left:e.clientX,y:anchor?r.bottom+6:e.clientY,kind,id})}
  // output preview (post-FX waveform incl. tail) — also warms the cache
  const [out,setOut]=useState<AudioBuffer|null>(null),sig=fxSignature(props.slots),cvs=useRef<HTMLCanvasElement>(null)
  useEffect(()=>{if(!hasActiveFx(props.slots)){setOut(null);return}const t=window.setTimeout(()=>{try{const src=props.makeSource();if(src)setOut(bakeFx('ui:'+props.bakeKey,src.buffer,{start:src.start,end:src.end},props.slots))}catch{}},220);return()=>window.clearTimeout(t)},[sig,props.bakeKey,props.srcSig])
  useEffect(()=>{const c=cvs.current;if(!c)return;const r=c.getBoundingClientRect(),W=Math.max(10,Math.floor(r.width)),Hh=Math.max(10,Math.floor(r.height)),dpr=window.devicePixelRatio||1;c.width=W*dpr;c.height=Hh*dpr;const g=c.getContext('2d');if(!g)return;g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,W,Hh);if(!out)return;const d=out.getChannelData(0),per=Math.max(1,d.length/W),col=getComputedStyle(c).getPropertyValue('--sx-tint').trim()||'#0a84ff';g.fillStyle=col
    for(let x=0;x<W;x++){let m=0;const a=Math.floor(x*per),b=Math.min(d.length,Math.floor((x+1)*per)+1),st=Math.max(1,Math.floor((b-a)/64));for(let i=a;i<b;i+=st)m=Math.max(m,Math.abs(d[i]));const h=Math.max(1,m*(Hh-2));g.globalAlpha=.9;g.fillRect(x,(Hh-h)/2,1,h)}},[out])
  const gr=selected&&selected.type==='compressor'?FX_METERS[selected.id]??0:0
  return <div className="sx-fx">
    <aside className="sx-fx-rack" aria-label={tr('效果器')}>
      <div className="sx-fx-rack-head"><span>{tr('效果器')}</span><HelpTip lines={[tr('點「加入效果器」選擇效果，每個 MAIN / SUB 最多 {0} 個',MAX_FX_SLOTS),tr('拖曳左側效果器可調整順序；左側圓點是旁通開關'),tr('旋鈕：上下拖曳調整（Shift 微調）、滾輪、雙擊重設'),tr('參數改變後會自動烘焙，發聲延遲與沒有效果器時相同'),tr('效果器只作用在電腦端發聲（SPD Pad 模式）；Editor 模式由 SPD-SX 本體發聲'),tr('匯出 WAV 時會包含效果器處理後的聲音（含殘響／延遲尾巴）')]}/></div>
      <ul className="sx-fx-slots">{props.slots.map(x=><li key={x.id} draggable className={`sx-fx-slot${x.id===sel?' is-sel':''}${x.on?'':' is-off'}${drag?.over===x.id&&drag.id!==x.id?' is-over':''}`} onClick={()=>setSel(x.id)} onContextMenu={e=>openMenu(e,'slot',x.id)}
        onDragStart={e=>{setDrag({id:x.id,over:null});e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('application/x-sx-fx',x.id)}} onDragOver={e=>{if(drag){e.preventDefault();if(drag.over!==x.id)setDrag({...drag,over:x.id})}}} onDrop={e=>{e.preventDefault();if(drag)reorder(drag.id,x.id);setDrag(null)}} onDragEnd={()=>setDrag(null)}>
        <button type="button" className="sx-fx-power" role="switch" aria-checked={x.on} aria-label={`${FX_DEFS[x.type].label} ${x.on?'on':'off'}`} title={x.on?tr('旁通'):tr('啟用')} onClick={e=>{e.stopPropagation();toggle(x.id)}}/>
        <span className="sx-fx-name">{FX_DEFS[x.type].label}</span>
      </li>)}</ul>
      {props.slots.length<MAX_FX_SLOTS&&<button type="button" className="sx-fx-add" onClick={e=>openMenu(e,'add',undefined,true)}>＋ {tr('加入效果器')}</button>}
    </aside>
    <section className="sx-fx-panel">{selected&&def?<>
      <header className="sx-fx-panel-head"><div className="sx-fx-title"><strong>{def.label}</strong><span>{fxGroupLabel(def.group)}</span></div>
        <div className="sx-fx-tools"><button type="button" className="sx-btn" onClick={e=>openMenu(e,'preset',selected.id,true)}>{tr('預設')} ▾</button>
          <input type="checkbox" role="switch" className="sx-switch" checked={selected.on} aria-label={selected.on?tr('旁通'):tr('啟用')} onChange={()=>toggle(selected.id)}/>
          <button type="button" className="sx-icon" title={tr('移除')} aria-label={tr('移除')} onClick={()=>remove(selected.id)}>✕</button></div></header>
      <div className={`sx-fx-body${selected.on?'':' is-off'}`}>
        {selected.type==='eq'?<EqPanel slot={selected} onParams={patch=>setParams(selected.id,patch)}/>:<>
          {def.params.filter(x=>x.options).map(sp=><div key={sp.key} className="sx-seg is-opt" role="tablist" aria-label={sp.label}>{(sp.options as string[]).map((o,i)=><button key={o} type="button" role="tab" aria-selected={Math.round(withDefaults(selected.type,selected.p)[sp.key])===i} className={Math.round(withDefaults(selected.type,selected.p)[sp.key])===i?'on':''} onClick={()=>setParams(selected.id,{[sp.key]:i})}>{o}</button>)}</div>)}
          <div className="sx-fx-knobs">{def.params.filter(x=>!x.options).map(sp=><Knob key={sp.key} spec={sp} value={withDefaults(selected.type,selected.p)[sp.key]} onChange={v=>setParams(selected.id,{[sp.key]:v})}/>)}</div></>}
      </div>
      <footer className="sx-fx-foot">{selected.type==='compressor'&&<div className="sx-gr" aria-label="gain reduction"><span>GR</span><div className="bar"><i style={{width:`${clamp(-gr/24*100,0,100)}%`}}/></div><b>{gr.toFixed(1)} dB</b></div>}
        <div className="sx-out"><span>OUT</span><canvas ref={cvs}/><b>{out?`${out.duration.toFixed(2)} s`:'—'}</b></div></footer>
    </>:<div className="sx-fx-empty"><svg width="34" height="26" viewBox="0 0 34 26" aria-hidden="true"><g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 20h6l4-14 5 18 4-12 3 8h6"/></g></svg><strong>{tr('尚未加入效果器')}</strong><span>{tr('從左側「加入效果器」開始，可拖曳調整順序')}</span></div>}</section>
    {menu&&<ContextMenu x={menu.x} y={menu.y} title={menu.kind==='add'?tr('加入效果器'):menu.kind==='preset'&&selected?FX_DEFS[selected.type].label:undefined} onClose={()=>setMenu(null)} items={
      menu.kind==='add'?FX_GROUPS.map(g=>({label:fxGroupLabel(g.id),sub:g.types.map(t=>({label:FX_DEFS[t].label,onSelect:()=>add(t)}))})):
      menu.kind==='preset'&&selected?[...FX_DEFS[selected.type].presets.map(pr=>({label:pr.name,onSelect:()=>commit(slotsRef.current.map(x=>x.id===selected.id?{...x,p:{...withDefaults(x.type,undefined),...pr.p}}:x))})),{divider:true},{label:tr('重設參數'),onSelect:()=>commit(slotsRef.current.map(x=>x.id===selected.id?{...x,p:withDefaults(x.type,undefined)}:x))}]:
      [{label:slotsRef.current.find(x=>x.id===menu.id)?.on?tr('旁通'):tr('啟用'),onSelect:()=>toggle(menu.id as string)},{label:tr('複製'),onSelect:()=>duplicate(menu.id as string)},{divider:true},{label:tr('移除'),danger:true,onSelect:()=>remove(menu.id as string)}]}/>}
  </div>
}
// ---- quick output picker (SPD Pad toolbar) ----
function OutputPicker(){
  const [,tick]=useState(0),[menu,setMenu]=useState<null|{x:number;y:number;list:AudioDevice[]}>(null),btn=useRef<HTMLButtonElement>(null),[label,setLabel]=useState('')
  useEffect(()=>audioEngine.subscribe(()=>tick(n=>n+1)),[])
  const cur=audioEngine.pref.deviceId
  useEffect(()=>{let live=true;audioEngine.devices().then(({list})=>{if(live)setLabel((list.find(d=>d.id===cur)||list[0])?.label.replace(/^.*? · /,'')||'')});return()=>{live=false}},[cur,tick])
  const open=async()=>{const {list}=await audioEngine.devices(),r=btn.current?.getBoundingClientRect();setMenu({x:r?.left??0,y:(r?.bottom??0)+6,list})}
  return <>
    <button ref={btn} type="button" className="btn mini sx-out-btn" title={tr('音訊輸出裝置')} aria-haspopup="menu" onClick={()=>void open()}><svg width="15" height="13" viewBox="0 0 15 13" aria-hidden="true"><path d="M1 4.5h2.6L7 1.4v10.2L3.6 8.5H1z" fill="currentColor"/><path d="M9.6 4.1c.9.8.9 3.9 0 4.8M11.5 2.5c1.9 1.9 1.9 6.1 0 8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg><span>{label||tr('音訊輸出')}</span><i aria-hidden="true">▾</i></button>
    {menu&&<ContextMenu x={menu.x} y={menu.y} title={tr('音訊輸出裝置')} onClose={()=>setMenu(null)} items={[...menu.list.map(d=>({label:d.label,checked:d.id===cur,hint:d.virtual?tr('虛擬裝置'):undefined,onSelect:()=>{void audioEngine.setDevice(d.id)}})),{divider:true},{label:tr('音訊輸出設定…'),onSelect:()=>openSettings('audio')}]}/>}
  </>
}
// ---- Settings → Audio output ----
function AudioOutputSettings(){
  const [,tick]=useState(0),[devs,setDevs]=useState<{list:AudioDevice[];hidden:boolean}>({list:[],hidden:false})
  const refresh=async()=>setDevs(await audioEngine.devices())
  useEffect(()=>{void audioEngine.get(false).then(refresh);void refresh();return audioEngine.subscribe(()=>{tick(n=>n+1);void refresh()})},[])
  const pref=audioEngine.pref,maxCh=audioEngine.maxCh,pairs=Math.max(1,Math.floor(Math.min(maxCh,32)/2)),multi=maxCh>=4,hasVirtual=devs.list.some(d=>d.virtual)
  return <div className="sx-audio">
    <section className="sx-audio-sec">
      <header><h3>{tr('輸出裝置')}</h3><HelpTip title={tr('輸入到 Logic Pro 等 App')} lines={[tr('Core SX 無法自己變成一個音訊裝置，需要先安裝虛擬音訊裝置，例如免費的 BlackHole，或 Loopback。'),tr('在這裡把輸出選成該虛擬裝置。'),tr('在 Logic Pro：設定 → 音訊 → 輸入裝置選同一個虛擬裝置，音軌輸入來源選對應聲道。'),tr('想一邊錄一邊聽，請在「音訊 MIDI 設定」建立「多重輸出裝置」或「聚集裝置」。'),tr('選用多聲道裝置（如 BlackHole 16ch）並開啟「每個 PAD 獨立聲道」，每個 PAD 就會進到不同的音軌。')]}/></header>
      <label className="sx-audio-row"><span>{tr('輸出到')}</span><select value={devs.list.some(d=>d.id===pref.deviceId)?pref.deviceId:'default'} onChange={e=>void audioEngine.setDevice(e.target.value)}>{devs.list.map(d=><option key={d.id} value={d.id}>{d.label}{d.virtual?` · ${tr('虛擬裝置')}`:''}</option>)}</select></label>
      <div className="sx-audio-actions"><button type="button" className="sx-btn is-primary" onClick={()=>void audioEngine.testTone(0)}>▶ {tr('測試音')}</button><button type="button" className="sx-btn" onClick={()=>void refresh()}>↻ {tr('重新整理')}</button>
        <span className={`sx-audio-status${audioEngine.error?' is-err':''}`}>{audioEngine.error||`${tr('延遲')} ≈ ${audioEngine.latencyMs()} ms · ${maxCh} ${tr('聲道')}`}</span></div>
      <label className="sx-audio-row"><span>{tr('同時監聽到')}</span><select value={devs.list.some(d=>d.id===pref.monitorId)?pref.monitorId:''} onChange={e=>void audioEngine.setMonitor(e.target.value)}><option value="">{tr('關閉')}</option>{devs.list.filter(d=>d.id!==pref.deviceId&&!(pref.deviceId==='default'&&d.id==='default')).map(d=><option key={d.id} value={d.id}>{d.label}</option>)}</select></label>
      <div className="sx-audio-hint">{tr('每個 PAD 發聲時會同時送到這個裝置（例如你的喇叭），主輸出可以專心送給 DAW。')}</div>
      {devs.hidden&&<div className="sx-audio-note"><p>{tr('目前看不到裝置名稱（macOS 需要你允許才會提供）。')}</p><button type="button" className="sx-btn" onClick={()=>void audioEngine.requestLabels().then(refresh)}>{tr('顯示裝置名稱')}</button></div>}
      {!hasVirtual&&!devs.hidden&&<div className="sx-audio-note"><p>{tr('沒有偵測到虛擬音訊裝置。要把聲音送進 Logic Pro，請先安裝 BlackHole 或 Loopback。')}</p></div>}
    </section>
    <section className="sx-audio-sec">
      <header><h3>{tr('輸出方式')}</h3></header>
      <div className="sx-seg is-opt" role="tablist"><button type="button" role="tab" aria-selected={pref.routing==='stereo'} className={pref.routing==='stereo'?'on':''} onClick={()=>void audioEngine.setRouting('stereo')}>{tr('立體聲混音')}</button><button type="button" role="tab" aria-selected={pref.routing==='perPad'} className={pref.routing==='perPad'?'on':''} onClick={()=>void audioEngine.setRouting('perPad')}>{tr('每個 PAD 獨立聲道')}</button></div>
      {pref.routing==='perPad'&&!multi&&<div className="sx-audio-note is-warn"><p>{tr('目前裝置只有 {0} 聲道。需要 4 聲道以上的裝置（例如 BlackHole 16ch）才能分 PAD 輸出，現在仍以立體聲輸出。',maxCh)}</p></div>}
      {pref.routing==='perPad'&&multi&&<div className="sx-audio-pads">{Array.from({length:10},(_,i)=><label key={i} className="sx-audio-row"><span>{i===9?'KICK':`PAD ${i+1}`}</span><select value={(pref.pairs[i]??i)%pairs} onChange={e=>audioEngine.setPair(i,Number(e.target.value))}>{Array.from({length:pairs},(_,k)=><option key={k} value={k}>{k*2+1}–{k*2+2}</option>)}</select></label>)}</div>}
    </section>
    <DawSettings/>
  </div>
}
function noteName(n:number){const N=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];return `${N[((n%12)+12)%12]}${Math.floor(n/12)-2}`}   // Logic convention: C3 = 60
function DawSettings(){
  const [st,setSt]=useState<{virtualOpen:boolean;virtualName?:string;virtualError?:string}|null>(null),[on,setOn]=useState(()=>localStorage.getItem('core-sx-virtual-midi')!=='0'),[last,setLast]=useState(UI.lastDaw)
  useEffect(()=>{void window.spd.midi.status().then(setSt).catch(()=>{});const a=window.spd.midi.onStatus(setSt);const b=window.spd.midi.onMessage(m=>{if(m.virtual&&m.direction==='in'){const s=m.bytes[0]&0xff,t=s&0xf0;setLast(t===0x90&&(m.bytes[2]||0)>0?`Note ${m.bytes[1]} (${noteName(m.bytes[1])}) · Vel ${m.bytes[2]} · CH ${(s&15)+1}`:m.hex)}});return()=>{a();b()}},[])
  const toggle=(v:boolean)=>{setOn(v);localStorage.setItem('core-sx-virtual-midi',v?'1':'0');void window.spd.midi.virtual(v).then(setSt).catch(()=>{})}
  return <section className="sx-audio-sec">
    <header><h3>{tr('DAW（Logic Pro 等）')}</h3><HelpTip title={tr('把 Core SX 當作 External Instrument')} lines={[tr('預設已開啟虛擬 MIDI 連接埠「Core SX」，Logic Pro 的 MIDI 目的地清單會直接看到它，不需要設定 IAC。'),tr('在 Logic Pro 建立軟體樂器軌，插入 External Instrument，MIDI Destination 選「Core SX」。'),tr('External Instrument 的 Audio Input 選你的虛擬音訊裝置聲道；Core SX 上方的輸出裝置也要選同一個裝置。'),tr('每個 PAD 預設對應音符 C1–A1（36–45，Logic 的 C3 = 60）；也可以在 PAD 上按 Learn，再從 Logic 彈一個音來指定。'),tr('Core SX 是單擊取樣：Note Off 不會截斷聲音；力度會套用 PAD 靈敏度設定。'),tr('如果錄到的聲音比 MIDI 稍晚，請調整 Logic 的錄音延遲或該軌的延遲補償。')]}/></header>
    <label className="sx-toggle"><span>{tr('虛擬 MIDI 連接埠「Core SX」')}</span><input type="checkbox" role="switch" className="sx-switch" checked={on} onChange={e=>toggle(e.target.checked)}/></label>
    <div className={`sx-audio-status${st?.virtualError?' is-err':''}`}>{st?.virtualError?tr('無法建立虛擬連接埠：{0}',st.virtualError):st?.virtualOpen?tr('✓ 其他 App 現在可以把 MIDI 送到「{0}」',st.virtualName||'Core SX'):tr('已關閉')}</div>
    <div className="sx-audio-note"><p>{last?tr('最近收到：{0}',last):tr('尚未收到來自 DAW 的 MIDI。')}</p></div>
    <div className="sx-audio-pads">{Array.from({length:10},(_,i)=>{const n=UI.padNotes[i]??36+i;return <div key={i} className="sx-audio-row"><span>{i===9?'KICK':`PAD ${i+1}`}</span><b className="sx-audio-val">{noteName(n)} · {n}</b></div>})}</div>
  </section>
}
function panLabel(pan:number){const p=Math.round(pan);return p===0?'C':p<0?`L${-p}`:`R${p}`}
type PadLayerView={name?:string;volume:number;pan:number}
function PadCard(props:{note?:number;label:string;active:boolean;activeLayer:'main'|'sub';learning:boolean;hit:boolean;intensity:number;main:PadLayerView;sub:PadLayerView;learnLabel:string;mainLabel:string;subLabel:string;onPad:()=>void;onLayer:(l:'main'|'sub')=>void;onDropLayer:(l:'main'|'sub',path:string)=>void;onContext:(e:React.MouseEvent)=>void;onLearn:()=>void}){
  const [drop,setDrop]=useState<'main'|'sub'|null>(null)
  return <div className={`sx-pad${props.active?' is-active':''}${props.learning?' is-learning':''}${props.hit?' is-hit':''}`} style={{'--hit':props.hit?props.intensity:0} as React.CSSProperties} onClick={props.onPad} onContextMenu={props.onContext}>
    <div className="sx-pad-top"><span className="sx-pad-name" title={props.note!=null?`${props.label} · MIDI ${noteName(props.note)} (${props.note})`:undefined}>{props.label}</span><button type="button" className="sx-pad-learn" aria-pressed={props.learning} onClick={e=>{e.stopPropagation();props.onLearn()}}>{props.learning?'● ':''}{props.learnLabel}</button></div>
    {(['main','sub'] as const).map(layer=>{const v=layer==='main'?props.main:props.sub;const custom=!!v.name&&(v.volume!==100||Math.round(v.pan)!==0)
      return <button type="button" key={layer} className={`sx-layer${props.active&&props.activeLayer===layer?' is-active':''}${v.name?'':' is-empty'}${drop===layer?' is-drop':''}`} title={v.name?`${v.name} · Vol ${v.volume}% · Pan ${panLabel(v.pan)}`:tr('拖入音源，或在音源上按右鍵指定')}
        onClick={e=>{e.stopPropagation();props.onLayer(layer)}} onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';if(drop!==layer)setDrop(layer)}} onDragLeave={()=>setDrop(d=>d===layer?null:d)} onDrop={e=>{e.preventDefault();e.stopPropagation();setDrop(null);props.onDropLayer(layer,e.dataTransfer.getData('application/x-spd-audio'))}}>
        <span className="sx-layer-tag"><b>{(layer==='main'?props.mainLabel:props.subLabel).slice(0,1)}</b><i>{(layer==='main'?props.mainLabel:props.subLabel).slice(1)}</i></span>
        <span className="sx-layer-name">{v.name||tr('拖入音源')}</span>
        {custom&&<span className="sx-layer-meta">{v.volume}% · {panLabel(v.pan)}</span>}
      </button>})}
  </div>
}
function isLightColor(hex:string){const m=/^#?([0-9a-f]{6})$/i.exec((hex||'').trim());if(!m)return false;const n=parseInt(m[1],16),r=(n>>16)&255,g=(n>>8)&255,b=n&255;return (0.2126*r+0.7152*g+0.0722*b)/255>0.6}
function formatTime(sec: number) { if (!Number.isFinite(sec)) return '0:00.000'; const m = Math.floor(sec / 60); const s = sec - m * 60; return `${m}:${s.toFixed(3).padStart(6, '0')}` }
function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, n)) }
function readStoredJson<T>(key: string, fallback: T): T { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback } catch { return fallback } }

function describeMidi(bytes:number[]) {
  if (!bytes.length) return 'Empty'
  const status = bytes[0] & 0xFF
  const type = status & 0xF0
  const channel = (status & 0x0F) + 1
  if (status === 0xF0) return bytes[bytes.length-1] === 0xF7 ? 'SysEx' : 'SysEx (incomplete)'
  switch (type) {
    case 0x80: return `Note Off · CH ${channel} · Note ${bytes[1] ?? 0} · Vel ${bytes[2] ?? 0}`
    case 0x90: return `Note ${bytes[2] === 0 ? 'Off' : 'On'} · CH ${channel} · Note ${bytes[1] ?? 0} · Vel ${bytes[2] ?? 0}`
    case 0xA0: return `Poly Aftertouch · CH ${channel} · Note ${bytes[1] ?? 0} · Pressure ${bytes[2] ?? 0}`
    case 0xB0: return `Control Change · CH ${channel} · CC ${bytes[1] ?? 0} · Value ${bytes[2] ?? 0}`
    case 0xC0: return `Program Change · CH ${channel} · Program ${bytes[1] ?? 0}`
    case 0xD0: return `Channel Aftertouch · CH ${channel} · Pressure ${bytes[1] ?? 0}`
    case 0xE0: { const value=((bytes[2] ?? 0)<<7)|(bytes[1] ?? 0); return `Pitch Bend · CH ${channel} · ${value-8192}` }
    default: return 'System / Unknown MIDI'
  }
}

function hexToDecByte(hex:string) { const n=parseInt(hex,16); return Number.isFinite(n)?n:0 }

function App() {
  const [project, setProject] = useState<ProjectModel>(emptyProject)
  const [selectedKit, setSelectedKit] = useState(0)
  const [selectedPad, setSelectedPad] = useState(0)
  const [search, setSearch] = useState('')
  const [waveSearch, setWaveSearch] = useState('')
  const [waveTag, setWaveTag] = useState('ALL')
  const [status, setStatus] = useState(tr('尚未開啟 SPD-SX 備份'))
  const [isPlaying, setIsPlaying] = useState(false)
  const [waveBuffer, setWaveBuffer] = useState<AudioBuffer | null>(null)
  const [waveEdits, setWaveEdits] = useState<WaveformEditState>({ start: 0, end: 1, fadeIn: 0, fadeOut: 0, normalize: false, pitch: 0, fadeInCurve: 0.5, fadeOutCurve: 0.5, playMode: 'gate', reverse: false })
  const [zoom, setZoom] = useState(1)
  const [device, setDevice] = useState<DeviceStatus>({ connected: false, mode: 'DISCONNECTED', reason: tr('等待 SPD-SX 連接') })
  const [autoSync, setAutoSync] = useState(() => localStorage.getItem('spd-auto-sync') !== '0')
  const [syncDelaySec, setSyncDelaySec] = useState(() => Number(localStorage.getItem('spd-sync-delay') || '10'))
  const [midiAppControl, setMidiAppControl] = useState(() => localStorage.getItem('spd-midi-app-control') !== '0')
  const [activePage, setActivePage] = useState<PageId>(() => (localStorage.getItem('spd-page') as PageId) || 'editor')
  const [language, setLanguage] = useState(() => localStorage.getItem('spd-language') || 'zh-TW')
  const [musicVolume, setMusicVolume] = useState(() => Number(localStorage.getItem('spd-music-volume') || '90'))
  const [soundVolume, setSoundVolume] = useState(() => Number(localStorage.getItem('spd-sound-volume') || '55'))
  const [soundStyle, setSoundStyle] = useState(() => localStorage.getItem('spd-sound-style') || 'studio')
  const [velocitySensitivity, setVelocitySensitivity] = useState(() => Number(localStorage.getItem('spd-velocity-sensitivity') || '100'))
  const [padSensitivities, setPadSensitivities] = useState<number[]>(() => {
    const saved = readStoredJson<number[]>('spd-pad-sensitivities', Array.from({ length: 10 }, () => 100))
    const next = Array.from({ length: 10 }, (_, i) => Number(saved[i] ?? 100))
    return next.map(v => clamp(Number.isFinite(v) ? v : 100, 25, 200))
  })
  const [audioSources, setAudioSources] = useState<AudioSourceTab[]>(() => readStoredJson<AudioSourceTab[]>('spd-audio-sources', []))
  const [activeAudioSourceId, setActiveAudioSourceId] = useState<string>(() => localStorage.getItem('spd-active-audio-source') || '')
  const [audioFiles, setAudioFiles] = useState<AudioFileInfo[]>([])
  const [allAudioFiles, setAllAudioFiles] = useState<AudioFileInfo[]>([])
  const [selectedComputerFile, setSelectedComputerFile] = useState<AudioFileInfo | undefined>(undefined)
  const [selectedSpdPad, setSelectedSpdPad] = useState(0)
  const [selectedComputerLayer, setSelectedComputerLayer] = useState<'main'|'sub'>('main')
  const [spdKitPresets, setSpdKitPresets] = useState<SpdKitPreset[]>(() => readStoredJson<SpdKitPreset[]>('core-sx-spd-kit-presets', []))
  const [kitLibraryOpen, setKitLibraryOpen] = useState(false)
  const [activeSpdKitPresetId, setActiveSpdKitPresetId] = useState<string | null>(null)
  const [padHitVisual, setPadHitVisual] = useState<{ index: number; intensity: number; token: number } | null>(null)
  const [themeMode, setThemeMode] = useState(() => localStorage.getItem('core-sx-theme') || 'system')
  const [themeBg, setThemeBg] = useState(() => localStorage.getItem('core-sx-theme-bg') || '#0b0f14')
  const [themeLine, setThemeLine] = useState(() => localStorage.getItem('core-sx-theme-line') || '#2a333d')
  const [themeAccent, setThemeAccent] = useState(() => localStorage.getItem('core-sx-theme-accent') || '#dfe7ee')
  const [themeGradStart, setThemeGradStart] = useState(() => localStorage.getItem('core-sx-theme-grad-start') || '#0b0f14')
  const [themeGradEnd, setThemeGradEnd] = useState(() => localStorage.getItem('core-sx-theme-grad-end') || '#17212c')
  const [themePixelSize, setThemePixelSize] = useState(() => Number(localStorage.getItem('core-sx-theme-pixel-size') || '6'))
  const [fontSize, setFontSize] = useState(() => { const n = Number(localStorage.getItem('core-sx-font-size')); return Number.isFinite(n) && n >= 85 && n <= 160 ? n : 100 })
  const fontSizeUnit = 'percent'
  const [fontFamily, setFontFamily] = useState(() => localStorage.getItem('core-sx-font-family') || 'system')
  const [spdPadAssignments, setSpdPadAssignments] = useState<SpdPadAssignment[]>(() => {
    const defaults = Array.from({ length: 10 }, (_, i) => ({ midiNote: 36 + i, main:{volume:100,pan:0}, sub:{volume:100,pan:0} }))
    try {
      const saved = JSON.parse(localStorage.getItem('spd-pad-assignments') || 'null')
      return defaults.map((x,i) => {
        const raw = Array.isArray(saved) ? (saved[i] || {}) : {}
        const main = { volume:100, pan:0, ...(raw.main || {}) }
        const sub = { volume:100, pan:0, ...(raw.sub || {}) }
        if (!main.filePath && raw.filePath) Object.assign(main, { filePath:raw.filePath, fileName:raw.fileName, sourceId:raw.sourceId })
        return { ...x, ...raw, main, sub, filePath:main.filePath, fileName:main.fileName, sourceId:main.sourceId }
      })
    } catch { return defaults }
  })
  const [midiLearnPad, setMidiLearnPad] = useState<number | null>(null)
  const [spdPadLearnMaps, setSpdPadLearnMaps] = useState<Record<string, number[]>>(() => readStoredJson<Record<string, number[]>>('spd-pad-learn-maps', {}))
  const [soundLibraryBusy, setSoundLibraryBusy] = useState(false)
  const [midiOpen, setMidiOpen] = useState(false)
  const [midiPorts, setMidiPorts] = useState<MidiPorts>({ inputs: [], outputs: [], likelySpd: [] })
  const [midiStatus, setMidiStatus] = useState<MidiStatus>({ inputOpen: false, outputOpen: false, virtualOpen: false })
  const [midiInPort, setMidiInPort] = useState<number | null>(null)
  const [midiOutPort, setMidiOutPort] = useState<number | null>(null)
  const [midiChannel, setMidiChannel] = useState(10)
  const [midiLog, setMidiLog] = useState<MidiMessageLog[]>([])
  const [sysexHex, setSysexHex] = useState('F0 7E 10 06 01 F7')
  const [syncing, setSyncing] = useState(false)
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const waveEditTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const waveEditDirtyRef = useRef(false)
  const fiveMinTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const latestProjectRef = useRef<ProjectModel>(project)
  const canvasDragRef = useRef<{mode:'start'|'end'|'fadeIn'|'fadeOut'|'fadeInCurve'|'fadeOutCurve'|null; startX:number; startY:number}>({mode:null,startX:0,startY:0})
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const bufferCacheRef = useRef<Map<string, AudioBuffer>>(new Map())
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const browserPreviewSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const panRef = useRef<StereoPannerNode | null>(null)
  const pendingWavePathsRef = useRef<Set<string>>(new Set())
  const autoModeInitializedRef = useRef(false)
  const instrumentSourcesRef = useRef<AudioBufferSourceNode[]>([])
  const instrumentSourceByPadRef = useRef<Map<number, AudioBufferSourceNode>>(new Map())
  const instrumentGainByPadRef = useRef<Map<number, GainNode>>(new Map())
  const musicVolumeRef = useRef(musicVolume)
  const soundStyleRef = useRef(soundStyle)
  const soundVolumeRef = useRef(soundVolume)
  const computerPlaybackSettingsRef = useRef<Map<string, { playMode: 'gate' | 'oneShot'; reverse: boolean }>>(new Map())
  const computerEditedBuffersRef = useRef<Map<string, AudioBuffer>>(new Map())
  const computerEditedSettingsRef = useRef<Map<string, WaveformEditState>>(new Map())
  const editorEditedBuffersRef = useRef<Map<string, AudioBuffer>>(new Map())
  const editorEditedSettingsRef = useRef<Map<string, WaveformEditState>>(new Map())
  const pendingEditorWavePathsRef = useRef<Set<string>>(new Set())
  const uiSfxCacheRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  const lastHoverButtonRef = useRef<EventTarget | null>(null)

  useEffect(() => { latestProjectRef.current = project }, [project])
  useEffect(() => {
    const onSaveKey=(e:KeyboardEvent)=>{
      if(!(e.metaKey||e.ctrlKey)||e.key.toLowerCase()!=='s')return
      const target=e.target as HTMLElement|null;if(target&&['INPUT','TEXTAREA','SELECT'].includes(target.tagName))return
      e.preventDefault()
      if(activePage==='editor')void saveCurrentEditorKit()
      else if(activePage==='spdPad')window.dispatchEvent(new Event('core-sx-request-save-kit'))
    }
    window.addEventListener('keydown',onSaveKey);return()=>window.removeEventListener('keydown',onSaveKey)
  },[activePage,project.rootPath,device.mode,device.connected,selectedKit])
  useEffect(() => { localStorage.setItem('spd-auto-sync', autoSync ? '1' : '0') }, [autoSync])
  useEffect(() => { localStorage.setItem('spd-sync-delay', String(syncDelaySec)) }, [syncDelaySec])
  useEffect(() => { localStorage.setItem('spd-midi-app-control', midiAppControl ? '1' : '0') }, [midiAppControl])
  useEffect(() => { localStorage.setItem('spd-language', language) }, [language])
  useEffect(() => { localStorage.setItem('spd-music-volume', String(musicVolume)) }, [musicVolume])
  useEffect(() => { localStorage.setItem('spd-sound-volume', String(soundVolume)) }, [soundVolume])
  useEffect(() => { localStorage.setItem('core-sx-theme', themeMode); localStorage.setItem('core-sx-theme-bg', themeBg); localStorage.setItem('core-sx-theme-line', themeLine); localStorage.setItem('core-sx-theme-accent', themeAccent); localStorage.setItem('core-sx-theme-grad-start', themeGradStart); localStorage.setItem('core-sx-theme-grad-end', themeGradEnd); localStorage.setItem('core-sx-theme-pixel-size', String(themePixelSize)) }, [themeMode, themeBg, themeLine, themeAccent, themeGradStart, themeGradEnd, themePixelSize])
  useEffect(() => { localStorage.setItem('spd-sound-style', soundStyle) }, [soundStyle])
  useEffect(() => { localStorage.setItem('core-sx-spd-kit-presets', JSON.stringify(spdKitPresets)) }, [spdKitPresets])
  useEffect(() => { soundStyleRef.current = soundStyle }, [soundStyle])
  useEffect(() => { soundVolumeRef.current = soundVolume }, [soundVolume])
  useEffect(() => { localStorage.setItem('spd-velocity-sensitivity', String(velocitySensitivity)) }, [velocitySensitivity])
  useEffect(() => { try { localStorage.setItem('spd-pad-assignments', JSON.stringify(spdPadAssignments)) } catch {} }, [spdPadAssignments])
  useEffect(() => { const flush = () => { try { localStorage.setItem('spd-pad-assignments', JSON.stringify(assignmentsRef.current)) } catch {} }; window.addEventListener('pagehide', flush); return () => window.removeEventListener('pagehide', flush) }, [])
  useEffect(() => { localStorage.setItem('spd-pad-sensitivities', JSON.stringify(padSensitivities)) }, [padSensitivities])
  useEffect(() => { localStorage.setItem('spd-pad-learn-maps', JSON.stringify(spdPadLearnMaps)) }, [spdPadLearnMaps])
  useEffect(() => { localStorage.setItem('spd-audio-sources', JSON.stringify(audioSources)); if(activeAudioSourceId) localStorage.setItem('spd-active-audio-source', activeAudioSourceId) }, [audioSources, activeAudioSourceId])

  const dict: Record<string, Record<string,string>> = {
    'zh-TW': {
      editor:'Editor', spdPad:'SPD Pad', midi:'MIDI / SysEx', settings:'設定', openBackup:'開啟備份', sync:'同步到 SPD',
      audioSources:'SPD Pad 音源分類', addSource:'加入來源', settingsTitle:'設定', theme:'主題', language:'語言', musicVolume:'音樂音量', soundVolume:'音效音量', soundStyle:'音效風格',
      credit:'Credit', producer:'發想以及製作人', contact:'聯絡方式', delete:'刪除', all:'全部', search:'搜尋', browse:'瀏覽資料夾',
      addKit:'新增 Kit', export:'匯出 SPD-SX', readDevice:'讀取 SPD', syncNow:'同步中…', kitList:'KIT LIST', sample:'Sample', category:'分類',
      waveBrowser:'WAVE BROWSER', waveformEditor:'WAVEFORM EDITOR', padEditor:'PAD EDITOR', preview:'預覽', stop:'停止', reset:'重置', resetPad:'重置全部 PAD', main:'MAIN', sub:'SUB', settingsApplyHint:'變更後按「套用」才會生效', applySettings:'套用', velocitySensitivity:'力度靈敏度', padSensitivity:'PAD 靈敏度', exportWav:'匯出 WAV',
      applySync:'套用並同步', start:'START', end:'END', fadeIn:'FADE IN', fadeOut:'FADE OUT', pitch:'PITCH', fadeInCurve:'FADE IN CURVE', fadeOutCurve:'FADE OUT CURVE', normalize:'NORMALIZE', zoom:'ZOOM',
      spdPadTitle:'Instrument Mode', midiReady:'MIDI READY', waitingMidi:'WAITING MIDI', sourceTabs:'WAVE BROWSER', noSource:'尚未設定音源資料夾', scanning:'掃描中…', noAudio:'尚無可用音訊', assignTip:'選取 PAD → 將音檔直接拖到 PAD 的 MAIN / SUB。點擊音檔只會選取，不會自動指派。',
      padWaveEditor:'WAVEFORM EDITOR', applyPad:'套用到目前 PAD', exportAudio:'匯出 WAV', noAudioSelected:'選擇一個音訊檔開始編輯',
      general:'一般', audioFolderHint:'選取一個總資料夾後，App 會自動依子資料夾建立 SPD Pad 音源分頁。', supported:'支援格式',
      instrumentMode:'INSTRUMENT MODE', directControl:'SPD-SX Direct Control', audioMidiHint:'偵測到 AUDIO/MIDI 連線。SPD-SX 作為控制器，電腦負責發聲。',
      midiPorts:'MIDI PORTS', input:'INPUT', output:'OUTPUT', connectInput:'連接 Input', connectOutput:'連接 Output', rescanMidi:'重新掃描 MIDI',
      programChange:'PROGRAM CHANGE', channel:'CHANNEL', program:'PROGRAM', sendProgram:'送出 Program Change', liveMonitor:'LIVE MIDI MONITOR', rawSysex:'RAW SYSEX', send:'送出',
      spdControl:'SPD → APP CONTROL', enableSpdControl:'啟用 SPD 直接控制 App', portSpdIn:'SPD-SX → App', portSpdOut:'App → SPD-SX', virtualOut:'Logic Pro Virtual Out',
      pad:'PAD', kick:'KICK', note:'NOTE', learn:'LEARN', learnNow:'按下 LEARN 後敲一次 SPD Pad', playMode:'PLAY MODE', gate:'GATE（按住播放）', oneShot:'ONE SHOT（完整播放）', reverse:'REVERSE（反向播放）', noWave:'No Wave', ready:'Ready',
      emptyTitle:'Core SX', emptyDescription:'開啟 Roland 備份資料夾或 .zip，直接管理 Kits、Pads、Waves 與 Waveform。', offline:'Offline Editor · 原始備份不會被直接修改',
      languageZh:'繁體中文', languageEn:'English', languageJa:'日本語', languageKo:'한국어'
    },
    en: {
      general:'General', editor:'Editor', spdPad:'SPD Pad', midi:'MIDI / SysEx', settings:'Settings', openBackup:'Open Backup', sync:'Sync to SPD',
      audioSources:'SPD Pad Libraries', addSource:'Add Source', settingsTitle:'Settings', theme:'Theme', language:'Language', musicVolume:'Music Volume', soundVolume:'UI Sound Volume', soundStyle:'UI Sound Style',
      credit:'Credit', producer:'Created & Produced by', contact:'Contact', delete:'Delete', all:'All', search:'Search', browse:'Browse Folder', addKit:'Add Kit', export:'Export SPD-SX', readDevice:'Read SPD', syncNow:'Syncing…', kitList:'KIT LIST', sample:'Sample', category:'Category',
      waveBrowser:'WAVE BROWSER', waveformEditor:'WAVEFORM EDITOR', padEditor:'PAD EDITOR', preview:'Preview', stop:'Stop', reset:'Reset', resetPad:'Reset All Pads', main:'MAIN', sub:'SUB', settingsApplyHint:'Changes take effect after Apply.', applySettings:'Apply', velocitySensitivity:'Velocity Sensitivity', padSensitivity:'PAD Sensitivity', exportWav:'Export WAV', applySync:'Apply & Sync', start:'START', end:'END', fadeIn:'FADE IN', fadeOut:'FADE OUT', pitch:'PITCH', fadeInCurve:'FADE IN CURVE', fadeOutCurve:'FADE OUT CURVE', normalize:'NORMALIZE', zoom:'ZOOM',
      spdPadTitle:'Instrument Mode', midiReady:'MIDI READY', waitingMidi:'WAITING MIDI', sourceTabs:'WAVE BROWSER', noSource:'No audio folder selected', scanning:'Scanning…', noAudio:'No usable audio files', assignTip:'Select a PAD → drag an audio file directly onto its MAIN / SUB layer. Clicking only selects.', padWaveEditor:'WAVEFORM EDITOR', applyPad:'Apply to PAD', exportAudio:'Export WAV', noAudioSelected:'Select an audio file to edit',
      audioFolderHint:'Choose a root folder and the app will automatically create SPD Pad source tabs from its subfolders.', supported:'Supported formats', instrumentMode:'INSTRUMENT MODE', directControl:'SPD-SX Direct Control', audioMidiHint:'AUDIO/MIDI detected. SPD-SX is the controller; the computer provides the sound.', midiPorts:'MIDI PORTS', input:'INPUT', output:'OUTPUT', connectInput:'Connect Input', connectOutput:'Connect Output', rescanMidi:'Rescan MIDI', programChange:'PROGRAM CHANGE', channel:'CHANNEL', program:'PROGRAM', sendProgram:'Send Program Change', liveMonitor:'LIVE MIDI MONITOR', rawSysex:'RAW SYSEX', send:'Send', spdControl:'SPD → APP CONTROL', enableSpdControl:'Enable direct SPD control', portSpdIn:'SPD-SX → App', portSpdOut:'App → SPD-SX', virtualOut:'Logic Pro Virtual Out', pad:'PAD', kick:'KICK', note:'NOTE', learn:'LEARN', learnNow:'Press LEARN, then hit the SPD pad once.', playMode:'PLAY MODE', gate:'GATE (hold to play)', oneShot:'ONE SHOT (play full sample)', reverse:'REVERSE', noWave:'No Wave', ready:'Ready', emptyTitle:'Core SX', emptyDescription:'Open a Roland backup folder or .zip to manage Kits, Pads, Waves and Waveforms.', offline:'Offline Editor · Original backups are never modified directly', languageZh:'Traditional Chinese', languageEn:'English', languageJa:'Japanese', languageKo:'Korean'
    },
    ja: {
      general:'一般', editor:'エディター', spdPad:'SPD Pad', midi:'MIDI / SysEx', settings:'設定', openBackup:'バックアップを開く', sync:'SPDへ同期', audioSources:'SPD Pad 音源', addSource:'音源ソースを追加', settingsTitle:'設定', theme:'テーマ', language:'言語', musicVolume:'音楽音量', soundVolume:'UI効果音音量', soundStyle:'効果音スタイル', credit:'クレジット', producer:'発想・制作', contact:'連絡先', delete:'削除', all:'すべて', search:'検索', browse:'フォルダを選択', addKit:'Kitを追加', export:'SPD-SXを書き出し', readDevice:'SPDを読み込む', syncNow:'同期中…', kitList:'KIT LIST', sample:'Sample', category:'分類', waveBrowser:'WAVE BROWSER', waveformEditor:'WAVEFORM EDITOR', padEditor:'PAD EDITOR', preview:'プレビュー', stop:'停止', reset:'リセット', resetPad:'すべてのPADをリセット', main:'MAIN', sub:'SUB', settingsApplyHint:'変更は「適用」を押した後に反映されます。', applySettings:'適用', velocitySensitivity:'ベロシティ感度', padSensitivity:'PAD感度', exportWav:'WAVを書き出し', applySync:'適用して同期', start:'START', end:'END', fadeIn:'FADE IN', fadeOut:'FADE OUT', pitch:'PITCH', fadeInCurve:'FADE IN CURVE', fadeOutCurve:'FADE OUT CURVE', normalize:'NORMALIZE', zoom:'ZOOM', spdPadTitle:'Instrument Mode', midiReady:'MIDI READY', waitingMidi:'WAITING MIDI', sourceTabs:'WAVE BROWSER', noSource:'音源フォルダ未選択', scanning:'スキャン中…', noAudio:'使用可能な音声がありません', assignTip:'PADを選択 → 音源をPADのMAIN / SUBへ直接ドラッグ。クリックは選択のみ。', padWaveEditor:'WAVEFORM EDITOR', applyPad:'現在のPADへ適用', exportAudio:'WAVを書き出す', noAudioSelected:'編集する音声を選択してください', audioFolderHint:'ルートフォルダを選ぶと、サブフォルダ名からSPD Padの音源タブを自動作成します。', supported:'対応形式', instrumentMode:'INSTRUMENT MODE', directControl:'SPD-SX Direct Control', audioMidiHint:'AUDIO/MIDIを検出しました。SPD-SXをコントローラー、コンピューターを音源として使用します。', midiPorts:'MIDI PORTS', input:'INPUT', output:'OUTPUT', connectInput:'Input接続', connectOutput:'Output接続', rescanMidi:'MIDI再スキャン', programChange:'PROGRAM CHANGE', channel:'CHANNEL', program:'PROGRAM', sendProgram:'Program Change送信', liveMonitor:'LIVE MIDI MONITOR', rawSysex:'RAW SYSEX', send:'送信', spdControl:'SPD → APP CONTROL', enableSpdControl:'SPDからAppを直接操作', portSpdIn:'SPD-SX → App', portSpdOut:'App → SPD-SX', virtualOut:'Logic Pro Virtual Out', pad:'PAD', kick:'KICK', note:'NOTE', learn:'LEARN', learnNow:'LEARNを押してSPDパッドを1回叩いてください。', playMode:'PLAY MODE', gate:'GATE（押している間再生）', oneShot:'ONE SHOT（最後まで再生）', reverse:'REVERSE', noWave:'No Wave', ready:'Ready', emptyTitle:'Core SX', emptyDescription:'Rolandバックアップまたは.zipを開いてKit、Pad、Wave、Waveformを管理します。', offline:'Offline Editor · 元のバックアップは直接変更されません', languageZh:'繁体字中国語', languageEn:'英語', languageJa:'日本語', languageKo:'韓国語'
    },
    ko: {
      editor:'에디터', spdPad:'SPD Pad', midi:'MIDI / SysEx', settings:'설정', openBackup:'백업 열기', sync:'SPD로 동기화', audioSources:'SPD Pad 음원', addSource:'소스 추가', settingsTitle:'설정', theme:'테마', language:'언어', musicVolume:'음악 볼륨', soundVolume:'UI 효과음 볼륨', soundStyle:'효과음 스타일', credit:'크레딧', producer:'기획 및 제작', contact:'연락처', delete:'삭제', all:'전체', search:'검색', browse:'폴더 선택', addKit:'Kit 추가', export:'SPD-SX 내보내기', readDevice:'SPD 읽기', syncNow:'동기화 중…', kitList:'KIT LIST', sample:'Sample', category:'분류', waveBrowser:'WAVE BROWSER', waveformEditor:'WAVEFORM EDITOR', padEditor:'PAD EDITOR', preview:'미리듣기', stop:'정지', reset:'초기화', resetPad:'모든 PAD 초기화', main:'MAIN', sub:'SUB', settingsApplyHint:'변경 사항은 적용 버튼을 눌러야 반영됩니다.', applySettings:'적용', velocitySensitivity:'벨로시티 감도', padSensitivity:'PAD 감도', general:'일반', exportWav:'WAV 내보내기', applySync:'적용 및 동기화', start:'START', end:'END', fadeIn:'FADE IN', fadeOut:'FADE OUT', pitch:'PITCH', fadeInCurve:'FADE IN CURVE', fadeOutCurve:'FADE OUT CURVE', normalize:'NORMALIZE', zoom:'ZOOM', spdPadTitle:'Instrument Mode', midiReady:'MIDI READY', waitingMidi:'WAITING MIDI', sourceTabs:'WAVE BROWSER', noSource:'오디오 폴더가 선택되지 않음', scanning:'스캔 중…', noAudio:'사용 가능한 오디오가 없습니다', assignTip:'PAD 선택 → 오디오를 PAD의 MAIN / SUB에 직접 드래그해 할당합니다. 클릭은 선택만 합니다.', padWaveEditor:'WAVEFORM EDITOR', applyPad:'현재 PAD에 적용', exportAudio:'WAV 내보내기', noAudioSelected:'편집할 오디오를 선택하세요', audioFolderHint:'루트 폴더를 선택하면 하위 폴더 이름으로 SPD Pad 소스 탭을 자동 생성합니다.', supported:'지원 형식', instrumentMode:'INSTRUMENT MODE', directControl:'SPD-SX Direct Control', audioMidiHint:'AUDIO/MIDI가 연결되었습니다. SPD-SX는 컨트롤러, 컴퓨터는 음원을 담당합니다.', midiPorts:'MIDI PORTS', input:'INPUT', output:'OUTPUT', connectInput:'Input 연결', connectOutput:'Output 연결', rescanMidi:'MIDI 다시 검색', programChange:'PROGRAM CHANGE', channel:'CHANNEL', program:'PROGRAM', sendProgram:'Program Change 전송', liveMonitor:'LIVE MIDI MONITOR', rawSysex:'RAW SYSEX', send:'전송', spdControl:'SPD → APP CONTROL', enableSpdControl:'SPD로 App 직접 제어', portSpdIn:'SPD-SX → App', portSpdOut:'App → SPD-SX', virtualOut:'Logic Pro Virtual Out', pad:'PAD', kick:'KICK', note:'NOTE', learn:'LEARN', learnNow:'LEARN을 누른 후 SPD 패드를 한 번 치세요.', playMode:'PLAY MODE', gate:'GATE(누르는 동안 재생)', oneShot:'ONE SHOT(전체 재생)', reverse:'REVERSE', noWave:'No Wave', ready:'Ready', emptyTitle:'Core SX', emptyDescription:'Roland 백업 폴더 또는 .zip을 열어 Kit, Pad, Wave, Waveform을 관리합니다.', offline:'Offline Editor · 원본 백업은 직접 수정되지 않습니다', languageZh:'번체 중국어', languageEn:'영어', languageJa:'일본어', languageKo:'한국어'
    }
  }
  const t = (key:string) => (dict[language]||{})[key] ?? dict.en[key] ?? dict['zh-TW'][key] ?? key
  UI.lang=language; UI.fs=fontSize/100
  const selectedAudioSource = audioSources.find(s => s.id === activeAudioSourceId) || audioSources[0]

  const kit = project.kits[selectedKit]
  const pad = kit?.pads[selectedPad]
  const currentWave = project.waves.find(w => w.id === pad?.waveId)

  const visiblePadIndexes = useMemo(() => [0,1,2,3,4,5,6,7,8,9], [])
  const filteredKits = useMemo(() => project.kits.filter(k => `${String(k.slot).padStart(3, '0')} ${k.name}`.toLowerCase().includes(search.toLowerCase())), [project.kits, search])
  const waveTags = useMemo(() => ['ALL', ...Array.from(new Set(project.waves.map(w => w.tagName).filter(Boolean) as string[])).sort((a, b) => a.localeCompare(b))], [project.waves])
  const filteredWaves = useMemo(() => project.waves.filter(w => {
    const q = waveSearch.trim().toLowerCase()
    return (!q || `${w.name} ${w.id} ${w.path} ${w.tagName ?? ''}`.toLowerCase().includes(q)) && (waveTag === 'ALL' || w.tagName === waveTag)
  }), [project.waves, waveSearch, waveTag])

  useEffect(() => {
    let disposed = false
    void window.spd.getDeviceStatus().then(next => { if (!disposed) setDevice(next) })
    const unsubscribe = window.spd.onDeviceStatus(next => {
      setDevice(next)
      if (!next.connected) setSyncing(false)
    })
    const unsubscribeMidiStatus = window.spd.midi.onStatus(next => setMidiStatus(next))
    const unsubscribeMidiMessage = window.spd.midi.onMessage(message => setMidiLog(prev => [message, ...prev].slice(0, 120)))
    void window.spd.midi.status().then(setMidiStatus)
    const clickHandler = (event: MouseEvent) => { const el = (event.target as HTMLElement | null)?.closest?.('button'); if (el) void playUiSfx('select') }
    const overHandler = (event: MouseEvent) => { const el = (event.target as HTMLElement | null)?.closest?.('button'); if (el && lastHoverButtonRef.current !== el) { lastHoverButtonRef.current = el; void playUiSfx('hover') } }
    document.addEventListener('click', clickHandler, true); document.addEventListener('mouseover', overHandler, true)
    const wakeAudio = () => { void ensureAudioContext().catch(() => {}) }
    document.addEventListener('pointerdown', wakeAudio, true)
    return () => { disposed = true; unsubscribe(); unsubscribeMidiStatus(); unsubscribeMidiMessage(); document.removeEventListener('click', clickHandler, true); document.removeEventListener('mouseover', overHandler, true); document.removeEventListener('pointerdown', wakeAudio, true); if (syncTimerRef.current) clearTimeout(syncTimerRef.current); if (waveEditTimerRef.current) clearTimeout(waveEditTimerRef.current); if (fiveMinTimerRef.current) clearInterval(fiveMinTimerRef.current); instrumentSourcesRef.current.forEach(s=>{try{s.stop()}catch{}}); instrumentSourcesRef.current=[]; try{browserPreviewSourceRef.current?.stop()}catch{} browserPreviewSourceRef.current=null }
  }, [])

  useEffect(() => {
    if (!midiAppControl || device.mode !== 'AUDIO_MIDI') return
    const onMessage = (message: MidiMessageLog) => {
      if (message.direction !== 'in' || !message.bytes.length || message.virtual) return   // virtual-port notes are handled below
      const status = message.bytes[0] & 0xff
      const type = status & 0xf0
      const channel = (status & 0x0f) + 1
      const note = message.bytes[1] ?? -1
      const rawVelocity = message.bytes[2] ?? 0
      if ((type === 0x90 && rawVelocity > 0)) {
        if (midiLearnPad !== null) {
          const slotKey = String(kit?.slot ?? 'standalone')
          setSpdPadLearnMaps(prev => { const map = Array.from({ length: 10 }, (_, i) => prev[slotKey]?.[i] ?? spdPadAssignments[i]?.midiNote ?? (36 + i)); map[midiLearnPad] = note; return { ...prev, [slotKey]: map } })
          setSpdPadAssignments(prev => prev.map((a,i) => i===midiLearnPad ? ({...a,midiNote:note,midiChannel:channel}) : a))
          if (kit?.pads[midiLearnPad]) { updatePad({ noteNumber: note, midiChannel: channel - 1 }) }
          setStatus(`MIDI Learn：${midiLearnPad===9?'KICK':`PAD ${midiLearnPad+1}`} · Kit ${kit?.slot ?? 'Standalone'} ← CH ${channel} Note ${note}`)
          setMidiLearnPad(null)
          return
        }
        if (activePage === 'spdPad' || activePage === 'editor') {
          const slotKey = String(kit?.slot ?? 'standalone')
          const learned = spdPadLearnMaps[slotKey] || []
          const learnedIndex = learned.findIndex(n => n === note)
          const hitIndex = learnedIndex >= 0 ? learnedIndex : (activePage === 'spdPad' ? spdPadAssignments.findIndex(a => a.midiNote === note && (a.midiChannel == null || a.midiChannel === channel)) : (kit?.pads.findIndex(p => p.noteNumber === note && (p.midiChannel === -1 || p.midiChannel === channel - 1 || p.midiChannel === channel)) ?? -1))
          if (hitIndex >= 0) {
            const sensitivity = clamp(Number(padSensitivities[hitIndex] ?? velocitySensitivity), 25, 200)
            const exponent = clamp(2 - (sensitivity / 100), 0.25, 3)
            const shapedVelocity = Math.round(Math.pow(rawVelocity / 127, exponent) * 127)
            const token = Date.now() + Math.random()
            setPadHitVisual({ index: hitIndex, intensity: clamp(shapedVelocity / 127, 0.12, 1), token })
            window.setTimeout(() => setPadHitVisual(current => current?.token === token ? null : current), 240)
            void ensureAudioContext().then(()=> activePage==='spdPad' ? triggerComputerPad(hitIndex, false, shapedVelocity) : triggerEditorPad(hitIndex, shapedVelocity))
            setStatus(`SPD-SX → ${activePage==='spdPad'?'SPD Pad':'Editor'} · ${hitIndex===9?'KICK':`PAD ${hitIndex+1}`} · Vel ${shapedVelocity}`)
            return
          }
        }
        const velocitySensitivityNow = clamp(Number(padSensitivities[9] ?? velocitySensitivity),25,200)
        const exponent = clamp(2 - (velocitySensitivityNow / 100), 0.25, 3)
        const velocity = Math.round(Math.pow(rawVelocity / 127, exponent) * 127)
        if (kit) {
          const hit = kit.pads.find(p => p.noteNumber === note && (p.midiChannel === -1 || p.midiChannel === channel - 1 || p.midiChannel === channel))
          if (hit) { setSelectedPad(hit.index); void previewPad(hit); void loadWaveEditor(project.waves.find(w => w.id === hit.waveId)); setStatus(`SPD-SX → App · PAD ${hit.index === 9 ? 'KICK' : hit.index + 1}`) }
        }
      }
      // Instrument Mode is one-shot: Note Off never cuts the currently playing sample.
      if (type === 0xc0 && project.kits.length) {
        const program = message.bytes[1] ?? -1
        const idx = project.kits.findIndex(k => k.slot === program)
        if (idx >= 0) { setSelectedKit(idx); setSelectedPad(0); setStatus(`SPD-SX → App · KIT ${String(program).padStart(3, '0')}`) }
      }
    }
    const unsubscribe = window.spd.midi.onMessage(onMessage)
    return unsubscribe
  }, [midiAppControl, device.mode, kit, project.waves, project.kits, activePage, spdPadAssignments, midiLearnPad, spdPadLearnMaps, velocitySensitivity])

  useEffect(() => {
    if (device.mode === 'AUDIO_MIDI' && activePage === 'editor') setActivePage('spdPad')
    if (device.mode === 'WAVE_MGR' && activePage === 'spdPad') setActivePage('editor')
    if (device.mode !== 'WAVE_MGR') { if (syncTimerRef.current) clearTimeout(syncTimerRef.current); if (fiveMinTimerRef.current) clearInterval(fiveMinTimerRef.current) }
    if (device.mode === 'AUDIO_MIDI') {
      autoModeInitializedRef.current = true
      void (async () => {
        try {
          const ports = await refreshMidiPorts()
          const matcher = /SPD[- ]SX|SPD[- ]SX SE|SPD[- ]SX Special|Roland SPD/i
          const input = ports.inputs.find(p => matcher.test(p.name))
          const output = ports.outputs.find(p => matcher.test(p.name))
          if (input) { setMidiInPort(input.index); if (!midiStatus.inputOpen || midiStatus.inputPort?.index !== input.index) await window.spd.midi.openInput(input.index) }
          if (output) { setMidiOutPort(output.index); if (!midiStatus.outputOpen || midiStatus.outputPort?.index !== output.index) await window.spd.midi.openOutput(output.index) }
          if (input || output) setStatus(tr('✓ SPD-SX AUDIO/MIDI 已連線 · 自動進入 Instrument Mode'))
        } catch {}
      })()
    } else if (device.mode === 'WAVE_MGR' && autoModeInitializedRef.current) {
      autoModeInitializedRef.current = false
      void window.spd.midi.closeInput()
      void window.spd.midi.closeOutput()
      setMidiLog([])
      setStatus(tr('✓ SPD-SX WAVE MGR 已連線 · 自動進入 Core SX'))
    } else if (device.mode === 'AUDIO_MIDI') {
      autoModeInitializedRef.current = true
    }
  }, [device.mode])

  useEffect(() => { if (device.connected && (device.mode === 'AUDIO_MIDI' || device.mode === 'WAVE_MGR')) void playUiSfx('connect') }, [device.connected, device.mode])

  useEffect(() => {
    if (device.mode === 'WAVE_MGR' && device.rootPath && project.kits.length === 0) {
      void openDevice()
    }
  }, [device.mode, device.rootPath])

  async function refreshMidiPorts(): Promise<MidiPorts> {
    try {
      const ports = await window.spd.midi.ports()
      setMidiPorts(ports)
      if (midiOutPort === null && ports.outputs.length) {
        const suggested = ports.outputs.find(p => /SPD[- ]SX|SPD[- ]SX SE|Roland SPD/i.test(p.name)) || ports.outputs[0]
        setMidiOutPort(suggested.index)
      }
      if (midiInPort === null && ports.inputs.length) {
        const suggested = ports.inputs.find(p => /SPD[- ]SX|SPD[- ]SX SE|Roland SPD/i.test(p.name)) || ports.inputs[0]
        setMidiInPort(suggested.index)
      }
      return ports
    } catch (e) { const message = e instanceof Error ? e.message : tr('MIDI 掃描失敗'); setStatus(message); throw new Error(message) }
  }
  async function openMidiPorts() {
    await refreshMidiPorts()
    setMidiOpen(true)
  }
  async function connectMidiInput() {
    if (midiInPort === null) return
    try { await window.spd.midi.openInput(midiInPort); setStatus(tr('MIDI Input 已連接：{0}',midiPorts.inputs.find(p=>p.index===midiInPort)?.name || midiInPort)) }
    catch (e) { setStatus(e instanceof Error ? tr('MIDI Input 失敗：{0}',e.message) : tr('MIDI Input 失敗')) }
  }
  async function connectMidiOutput() {
    if (midiOutPort === null) return
    try { await window.spd.midi.openOutput(midiOutPort); setStatus(tr('MIDI Output 已連接：{0}',midiPorts.outputs.find(p=>p.index===midiOutPort)?.name || midiOutPort)) }
    catch (e) { setStatus(e instanceof Error ? tr('MIDI Output 失敗：{0}',e.message) : tr('MIDI Output 失敗')) }
  }
  async function sendProgramChange(program: number) {
    try { const pc = clamp(Math.round(program), 0, 127); await window.spd.midi.programChange(midiChannel, pc); setStatus(tr('已送出 MIDI Program Change · CH {0} · Program {1}',midiChannel,pc)) }
    catch (e) { setStatus(e instanceof Error ? e.message : tr('Program Change 失敗')) }
  }
  async function sendCurrentKitPC() {
    if (!kit) return
    await sendProgramChange(kit.slot)
  }
  async function sendIdentityRequest() {
    try { await window.spd.midi.identityRequest(0x10); setStatus(tr('已送出 MIDI Identity Request，等待 SPD-SX 回覆')) }
    catch (e) { setStatus(e instanceof Error ? e.message : tr('Identity Request 失敗')) }
  }
  async function sendSysexHex() {
    const cleaned = sysexHex.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '')
    if (!cleaned || cleaned.length % 2 !== 0) return setStatus(tr('SysEx 十六進位資料格式錯誤'))
    const bytes = cleaned.match(/.{2}/g)!.map(v => parseInt(v, 16))
    if (bytes[0] !== 0xF0 || bytes[bytes.length - 1] !== 0xF7) return setStatus(tr('SysEx 必須以 F0 開頭、F7 結尾'))
    try { await window.spd.midi.send(bytes); setStatus(tr('SysEx 已送出')) } catch (e) { setStatus(e instanceof Error ? e.message : tr('SysEx 傳送失敗')) }
  }

  async function playUiSfx(name: string) {
    const style = soundStyleRef.current
    const volume = clamp(soundVolumeRef.current / 100, 0, 1)
    const key = `${style}:${name}`
    const cached = uiSfxCacheRef.current.get(key)
    if (cached) {
      cached.volume = volume
      cached.currentTime = 0
      try { await cached.play() } catch {}
      return
    }
    for (const ext of ['mp3', 'ogg']) {
      const candidate = new Audio(`/sounds/${style}/${encodeURIComponent(name)}.${ext}`)
      candidate.preload = 'auto'
      candidate.volume = volume
      candidate.currentTime = 0
      try {
        // Play immediately from the user event. Waiting for canplaythrough would lose the browser gesture.
        await candidate.play()
        uiSfxCacheRef.current.set(key, candidate)
        return
      } catch {
        // Try the next supported extension.
      }
    }
  }
  async function loadAudioSourceFiles(source: AudioSourceTab | undefined) {
    if(!source){setAudioFiles([]);return} setSoundLibraryBusy(true); try{setAudioFiles(await window.spd.sound.listFiles(source.path));}catch(e){setStatus(e instanceof Error?tr('音源掃描失敗：{0}',e.message):tr('音源掃描失敗'));setAudioFiles([])}finally{setSoundLibraryBusy(false)}
  }
  async function chooseAudioSource() {
    const chosen=await window.spd.sound.chooseFolder();
    if(!chosen)return
    setSoundLibraryBusy(true)
    try {
      const scan = await window.spd.sound.scanLibrary(chosen)
      const categories = scan.groups.length ? scan.groups : [{ name: chosen.split('/').filter(Boolean).pop() || 'Audio', path: chosen, files: [] }]
      const resolvedItems = categories.map(group => ({ id: crypto.randomUUID(), name: group.name, path: group.path, rootPath: chosen }))
      const existingByPath = new Map<string, AudioSourceTab>(audioSources.map(item => [item.path, item] as const))
      const usableItems: AudioSourceTab[] = resolvedItems.map(item => existingByPath.get(item.path) || item)
      const merged = [...audioSources]
      for (const item of usableItems) if (!existingByPath.has(item.path)) merged.push(item)
      setAudioSources(merged)
      const first = usableItems[0]
      if (first) { setActiveAudioSourceId(first.id); setAudioFiles(scan.groups.find(g => g.path === first.path)?.files || []); setAllAudioFiles(scan.groups.flatMap(g=>g.files||[])); setStatus(tr('已載入音源資料夾：{0} · {1} 分類',chosen.split('/').filter(Boolean).pop() || chosen,usableItems.length)) }
    } catch (e) {
      setStatus(e instanceof Error ? tr('音源掃描失敗：{0}',e.message) : tr('音源掃描失敗'))
    } finally { setSoundLibraryBusy(false) }
  }
  function selectComputerFile(file:AudioFileInfo|undefined, preview=true){ if(!file){setSelectedComputerFile(undefined);return} setSelectedComputerFile(file); setStatus(tr('已選取音源：{0}（拖曳到 MAIN / SUB 才會指派）',file.name)); if(preview) void previewComputerFile(file.path, undefined, true) }

  function clearComputerLayer(index:number, layer:'main'|'sub') {
    setSpdPadAssignments(prev => prev.map((a,i) => i===index ? ({...a,[layer]:{volume:100,pan:0}, ...(layer==='main'?{filePath:undefined,fileName:undefined,sourceId:undefined}:{} )}) : a))
    if (selectedSpdPad===index && selectedComputerLayer===layer) setSelectedComputerFile(undefined)
    setStatus(tr('已清除 {0} {1}',index===9?'KICK':`PAD ${index+1}`,layer.toUpperCase()))
  }
  function clearComputerPad(index:number) {
    setSpdPadAssignments(prev => prev.map((a,i) => i===index ? ({...a,filePath:undefined,fileName:undefined,sourceId:undefined,main:{volume:100,pan:0},sub:{volume:100,pan:0}}) : a))
    if (selectedSpdPad===index) setSelectedComputerFile(undefined)
    setStatus(tr('已清除 {0} 全部音源',index===9?'KICK':`PAD ${index+1}`))
  }
  function buildSpdKitPreset(name:string, id?:string, createdAt?:string):SpdKitPreset {
    const editSettings:Record<string,WaveformEditState>={}
    for(const [k,v] of computerEditedSettingsRef.current.entries()) editSettings[k]=clone(v)
    const key=String(kit?.slot ?? 'standalone')
    const learnMap = clone(spdPadLearnMaps[key] || spdPadAssignments.map(a=>a.midiNote))
    const now=new Date().toISOString()
    return { id:id || crypto.randomUUID(), name, createdAt:createdAt || now, updatedAt:now, assignments:clone(spdPadAssignments), learnMap, editSettings }
  }
  function commitSpdKitSave(mode:'overwrite'|'new', name?:string) {
    if(mode==='overwrite' && activeSpdKitPresetId){
      const current=spdKitPresets.find(p=>p.id===activeSpdKitPresetId)
      if(current){
        const next=buildSpdKitPreset(current.name,current.id,current.createdAt)
        setSpdKitPresets(prev=>prev.map(p=>p.id===current.id?next:p))
        setStatus(tr('✓ 已覆蓋 Kit：{0}',current.name))
        return
      }
    }
    const finalName=(name||kit?.name||`Kit ${spdKitPresets.length+1}`).trim()
    if(!finalName)return
    const preset=buildSpdKitPreset(finalName)
    setSpdKitPresets(prev=>[preset,...prev])
    setActiveSpdKitPresetId(preset.id)
    setKitLibraryOpen(true)
    setStatus(tr('✓ 已儲存 Kit：{0}',finalName))
  }
  function loadSpdKitPreset(preset:SpdKitPreset) {
    setSpdPadAssignments(clone(preset.assignments))
    const key=String(kit?.slot ?? 'standalone')
    setSpdPadLearnMaps(prev=>({...prev,[key]:clone(preset.learnMap)}))
    computerEditedSettingsRef.current.clear(); computerEditedBuffersRef.current.clear(); computerPlaybackSettingsRef.current.clear()
    for(const [k,v] of Object.entries(preset.editSettings||{})) computerEditedSettingsRef.current.set(k,clone(v))
    setActiveSpdKitPresetId(preset.id); setSelectedSpdPad(0); setSelectedComputerLayer('main'); setKitLibraryOpen(false); setStatus(tr('✓ 已載入 Kit：{0}',preset.name))
  }
  function deleteSpdKitPreset(id:string) { const item=spdKitPresets.find(x=>x.id===id); if(!item)return; if(!window.confirm(tr('刪除 Kit「{0}」？',item.name)))return; setSpdKitPresets(prev=>prev.filter(x=>x.id!==id)); setStatus(tr('已刪除 Kit：{0}',item.name)) }
  async function deleteAudioSource(id:string){const next=audioSources.filter(s=>s.id!==id);setAudioSources(next);if(activeAudioSourceId===id){const replacement=next[0]?.id||'';setActiveAudioSourceId(replacement);await loadAudioSourceFiles(next[0])}}
  function reverseBuffer(ctx: AudioContext, buffer: AudioBuffer) {
    const rev=ctx.createBuffer(buffer.numberOfChannels,buffer.length,buffer.sampleRate)
    for(let ch=0;ch<buffer.numberOfChannels;ch++){const src=buffer.getChannelData(ch),dst=rev.getChannelData(ch);for(let i=0;i<src.length;i++)dst[i]=src[src.length-1-i]}
    return rev
  }
  function stopComputerPad(index:number){
    const source=instrumentSourceByPadRef.current.get(index); if(!source) return
    try{source.stop()}catch{}
    instrumentSourceByPadRef.current.delete(index)
  }
  const computerKey = (index:number, layer:'main'|'sub', filePath:string) => `${index}:${layer}:${filePath}`
  const computerDecodedCacheRef = useRef<Map<string, AudioBuffer>>(new Map())
  const defaultPlayEdits:WaveformEditState={start:0,end:1,fadeIn:0,fadeOut:0,normalize:false,pitch:0,fadeInCurve:.5,fadeOutCurve:.5,playMode:'oneShot',reverse:false}
  // Builds the audio graph for one layer and returns a start() function; nothing is audible until start() is called,
  // so MAIN and SUB of a PAD can be prepared in parallel and then started in the same tick.
  async function resolveLayerBuffer(filePath:string, index:number|undefined, layer:'main'|'sub'){
    const key=index!=null?computerKey(index,layer,filePath):filePath
    const ctx=await ensureAudioContext()
    let buffer=computerEditedBuffersRef.current.get(key)
    const saved=computerEditedSettingsRef.current.get(key)
    const edits=saved||defaultPlayEdits
    if(!buffer){
      let raw=computerDecodedCacheRef.current.get(filePath)
      if(!raw){const bytes=await window.spd.sound.readFile(filePath);if(!bytes)throw new Error(tr('找不到音訊檔案'));raw=await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer);if(computerDecodedCacheRef.current.size>=64)computerDecodedCacheRef.current.clear();computerDecodedCacheRef.current.set(filePath,raw)}
      // Saved settings but no rendered buffer yet (e.g. after loading a Kit): render it now so fades / reverse / pitch are honoured.
      buffer=saved?renderEditedBuffer(raw,saved):raw
      if(saved&&index!=null) computerEditedBuffersRef.current.set(key,buffer)
    }
    return {ctx,key,buffer,edits}
  }
  // Builds the audio graph for one layer and returns a start() function; nothing is audible until start() is called,
  // so MAIN and SUB of a PAD can be prepared in parallel and then started in the same tick.
  async function prepareComputerLayer(filePath:string, index:number|undefined, layer:'main'|'sub', velocity:number):Promise<{source:AudioBufferSourceNode;start:()=>void}>{
    const {ctx,key,buffer,edits}=await resolveLayerBuffer(filePath,index,layer)
    const assignment=index!=null?spdPadAssignments[index]:undefined; const layerData=assignment?.[layer]||{volume:100,pan:0}
    // Effects are baked (cached) — playback stays a plain buffer source, so latency is the same with or without FX.
    const fxOn=hasActiveFx(layerData.fx)
    const playBuf=fxOn?bakeFx(key,buffer,{start:edits.start,end:edits.end},layerData.fx as FxSlot[]):buffer
    const source=ctx.createBufferSource(); const gain=ctx.createGain(); const pan=ctx.createStereoPanner(); source.buffer=playBuf
    gain.gain.value=clamp((layerData.volume/100)*(musicVolume/100)*(clamp(velocity,1,127)/127),0,1); pan.pan.value=clamp(layerData.pan/100,-1,1); source.connect(gain).connect(pan).connect(audioEngine.input(index))
    const mon=audioEngine.monitor();let monSrc:AudioBufferSourceNode|null=null
    if(mon){monSrc=mon.ctx.createBufferSource();monSrc.buffer=playBuf;const mg=mon.ctx.createGain(),mp=mon.ctx.createStereoPanner();mg.gain.value=gain.gain.value;mp.pan.value=pan.pan.value;monSrc.connect(mg).connect(mp).connect(mon.node)}
    const startOffset=fxOn?0:Math.min(Math.max(0,clamp(edits.start,0,1)*playBuf.duration),Math.max(0,playBuf.duration-0.001)); const duration=fxOn?playBuf.duration:Math.max(0.02,(clamp(edits.end,0,1)-clamp(edits.start,0,1))*playBuf.duration)
    return {source,start:()=>{
      if(index!=null){instrumentSourceByPadRef.current.set(index,source); instrumentGainByPadRef.current.set(index,gain)}
      source.onended=()=>{instrumentSourcesRef.current=instrumentSourcesRef.current.filter(x=>x!==source);if(index!=null&&instrumentSourceByPadRef.current.get(index)===source){instrumentSourceByPadRef.current.delete(index);instrumentGainByPadRef.current.delete(index)}}
      source.start(0,startOffset,duration)
      instrumentSourcesRef.current.push(source)
      if(monSrc){const m=monSrc;m.onended=()=>{instrumentSourcesRef.current=instrumentSourcesRef.current.filter(x=>x!==m)};m.start(0,startOffset,duration);instrumentSourcesRef.current.push(m)}
    }}
  }
  // Pre-render every layer that has effects (idle time), so the first hit never waits for the bake.
  const fxWarmTimer=useRef(0); const assignmentsRef=useRef<SpdPadAssignment[]>([]); assignmentsRef.current=spdPadAssignments
  async function warmFx(){for(let i=0;i<10;i++)for(const layer of ['main','sub'] as const){const l=assignmentsRef.current[i]?.[layer];if(!l?.filePath||!hasActiveFx(l.fx))continue;try{const {key,buffer,edits}=await resolveLayerBuffer(l.filePath,i,layer);bakeFx(key,buffer,{start:edits.start,end:edits.end},l.fx as FxSlot[])}catch{};await new Promise(r=>setTimeout(r,0))}}
  function scheduleFxWarm(delay=120){window.clearTimeout(fxWarmTimer.current);fxWarmTimer.current=window.setTimeout(()=>{void warmFx()},delay)}
  const fxWarmSig=spdPadAssignments.map(a=>(['main','sub'] as const).map(l=>(a[l].filePath||'')+'#'+fxSignature(a[l].fx)).join('~')).join('||')
  useEffect(()=>{scheduleFxWarm(120)},[fxWarmSig])
  // ---- Notes from a DAW / other apps arrive on the virtual MIDI port "Core SX". They play the Instrument-mode pads whether or not an SPD-SX is connected and on whichever page is open. ----
  const [virtualMidi] = useState(() => localStorage.getItem('core-sx-virtual-midi') !== '0')
  useEffect(() => { void window.spd.midi.virtual(virtualMidi).catch(() => {}) }, [])
  const dawRef = useRef<any>({}); dawRef.current = { assignments: spdPadAssignments, padSensitivities, velocitySensitivity, midiLearnPad, triggerComputerPad, ensureAudioContext, setStatus, setMidiLearnPad }
  UI.padNotes = spdPadAssignments.map((a, i) => a.midiNote ?? 36 + i)
  useEffect(() => window.spd.midi.onMessage(message => {
    if (!message.virtual || message.direction !== 'in' || !message.bytes.length) return
    const R = dawRef.current, st = message.bytes[0] & 0xff, type = st & 0xf0, channel = (st & 0x0f) + 1, note = message.bytes[1] ?? -1, vel = message.bytes[2] ?? 0
    UI.lastDaw = type === 0x90 && vel > 0 ? `Note ${note} (${noteName(note)}) · Vel ${vel} · CH ${channel}` : message.hex
    if (type !== 0x90 || vel <= 0) return          // one-shot samples: Note Off never cuts a sound
    if (R.midiLearnPad !== null) {
      const pad = R.midiLearnPad as number
      setSpdPadAssignments(prev => prev.map((a, i) => i === pad ? ({ ...a, midiNote: note, midiChannel: undefined }) : a))
      R.setStatus(`MIDI Learn：${pad === 9 ? 'KICK' : `PAD ${pad + 1}`} ← Note ${note}`); R.setMidiLearnPad(null); return
    }
    const idx = (R.assignments as SpdPadAssignment[]).findIndex((a, i) => (a.midiNote ?? 36 + i) === note && (a.midiChannel == null || a.midiChannel === channel))
    if (idx < 0) return
    const sens = clamp(Number(R.padSensitivities[idx] ?? R.velocitySensitivity), 25, 200), exponent = clamp(2 - sens / 100, 0.25, 3), shaped = Math.max(1, Math.round(Math.pow(vel / 127, exponent) * 127)), token = Date.now() + Math.random()
    setPadHitVisual({ index: idx, intensity: clamp(shaped / 127, 0.12, 1), token }); window.setTimeout(() => setPadHitVisual(c => c?.token === token ? null : c), 240)
    void R.ensureAudioContext().then(() => R.triggerComputerPad(idx, false, shaped))
    R.setStatus(`DAW → ${idx === 9 ? 'KICK' : `PAD ${idx + 1}`} · Note ${note} · Vel ${shaped}`)
  }), [])
  function updateSpdFx(index:number,layer:'main'|'sub',slots:FxSlot[]){setSpdPadAssignments(prev=>prev.map((a,i)=>i===index?({...a,[layer]:{...a[layer],fx:slots}}):a))}
  useEffect(()=>{const f=(e:Event)=>{const d=(e as CustomEvent).detail||{};if(d.tab)UI.settingsTab=String(d.tab);if(d.page)setActivePage(d.page)};window.addEventListener('core-sx-nav',f);return()=>window.removeEventListener('core-sx-nav',f)},[])
  async function previewComputerFile(filePath:string, index?:number, forceOneShot=false, layer:'main'|'sub'='main', velocity=127){
    try{
      if(index == null){ try{browserPreviewSourceRef.current?.stop()}catch{} browserPreviewSourceRef.current=null }
      const {source,start}=await prepareComputerLayer(filePath,index,layer,velocity)
      if(index == null) browserPreviewSourceRef.current = source
      start()
    }catch(e){setStatus(e instanceof Error?tr('播放失敗：{0}',e.message):tr('播放失敗'))}
  }
  async function triggerComputerPad(index:number, forceOneShot=false, velocity=127){
    const a=spdPadAssignments[index]
    const layers=([['main',a?.main?.filePath],['sub',a?.sub?.filePath]] as [('main'|'sub'),string|undefined][]).filter(([,path])=>!!path)
    if(!layers.length){setStatus(tr('SPD Pad {0} 尚未指定音源',index===9?'KICK':index+1));return}
    try{
      const ready=await Promise.all(layers.map(([layer,path])=>prepareComputerLayer(path!,index,layer,velocity)))
      ready.forEach(r=>r.start())   // MAIN + SUB start together
    }catch(e){setStatus(e instanceof Error?tr('播放失敗：{0}',e.message):tr('播放失敗'))}
  }
  async function triggerComputerPadLayer(index:number, layer:'main'|'sub', forceOneShot=false, velocity=127){const path=spdPadAssignments[index]?.[layer]?.filePath; if(!path){setStatus(tr('SPD Pad {0} {1} 尚未指定音源',index===9?'KICK':index+1,layer.toUpperCase()));return} await previewComputerFile(path,index,forceOneShot,layer,velocity)}
  async function assignComputerFile(file:AudioFileInfo,index=selectedSpdPad,layer:'main'|'sub'='main'){setSpdPadAssignments(prev=>prev.map((a,i)=>i===index?({...a,[layer]:{...a[layer],filePath:file.path,fileName:file.name,sourceId:selectedAudioSource?.id},filePath:layer==='main'?file.path:a.filePath,fileName:layer==='main'?file.name:a.fileName,sourceId:layer==='main'?selectedAudioSource?.id:a.sourceId}):a));setSelectedComputerLayer(layer);setSelectedComputerFile(file);setStatus(`SPD Pad ${index===9?'KICK':index+1} ${layer.toUpperCase()} ← ${file.name}`)}
  async function selectAssignedComputerPad(index:number) {
    setSelectedSpdPad(index)
    const assigned = spdPadAssignments[index]
    const targetPath = assigned?.main?.filePath || assigned?.filePath
    if (!targetPath) { setSelectedComputerFile(undefined); return }
    const found = audioFiles.find(file => file.path === targetPath)
    setSelectedComputerFile(found || { name: assigned.main?.fileName || assigned.fileName || 'Audio', path: targetPath, size: 0, extension: targetPath.split('.').pop()?.toLowerCase() || '' })
  }
  function rememberEditedComputerBuffer(key:string, buffer:AudioBuffer, settings:{reverse:boolean;edits?:WaveformEditState}) { computerEditedBuffersRef.current.set(key, buffer); computerPlaybackSettingsRef.current.set(key, {playMode:'oneShot', reverse:settings.reverse}); if(settings.edits) computerEditedSettingsRef.current.set(key, settings.edits); scheduleFxWarm(200) }
  function resetSpdPads(){ instrumentSourceByPadRef.current.forEach((source)=>{try{source.stop()}catch{}}); instrumentSourceByPadRef.current.clear(); instrumentGainByPadRef.current.clear(); computerEditedBuffersRef.current.clear(); computerEditedSettingsRef.current.clear(); computerPlaybackSettingsRef.current.clear(); setSpdPadAssignments(prev=>prev.map(a=>({...a,filePath:undefined,fileName:undefined,sourceId:undefined,main:{volume:100,pan:0},sub:{volume:100,pan:0}}))); setSelectedComputerFile(undefined); setStatus(tr('SPD Pad 已全部重置')) }
  const instrumentPadNote=(index:number)=>{ const key=String(kit?.slot ?? 'standalone'); return spdPadLearnMaps[key]?.[index] ?? kit?.pads[index]?.noteNumber ?? spdPadAssignments[index]?.midiNote ?? (36+index) }
  const editorFileInfo = (wave?: WaveModel): AudioFileInfo|undefined => wave?.dataPath ? {name:wave.name || `Wave ${wave.id}`, path:wave.dataPath, size:wave.sizeBytes || 0, extension:(wave.dataPath.split('.').pop()||'').toLowerCase()} : undefined
  const editorKey=(index:number,layer:'main'|'sub',filePath:string)=>`editor:${kit?.slot ?? 'standalone'}:${index}:${layer}:${filePath}`
  function editorPadLayer(index:number, layer:'main'|'sub'): PadLayer {
    const p=kit?.pads[index]
    if(!p) return {volume:100,pan:0}
    if(layer==='main') return {filePath:project.waves.find(w=>w.id===p.waveId)?.dataPath,fileName:p.waveName,volume:p.waveLevel,pan:((p.wavePan-15)/15)*100}
    const sw=project.waves.find(w=>w.id===p.subWaveId)
    return {filePath:sw?.dataPath,fileName:sw?.name,volume:p.subWaveLevel,pan:((p.subWavePan-15)/15)*100}
  }
  function editorAssignments():SpdPadAssignment[]{
    return Array.from({length:10},(_,i)=>{const main=editorPadLayer(i,'main');const sub=editorPadLayer(i,'sub');return {filePath:main.filePath,fileName:main.fileName,sourceId:'editor',main,sub,midiNote:kit?.pads[i]?.noteNumber ?? (36+i),midiChannel:kit?.pads[i]?.midiChannel}})
  }
  function updateEditorPadLayer(index:number,layer:'main'|'sub',patch:Partial<PadLayer>) {
    if(!kit) return
    const next=clone(project); const p=next.kits[selectedKit].pads[index]
    const path=patch.filePath
    if(layer==='main'){
      if(path){const w=next.waves.find(w=>w.dataPath===path); if(w){p.waveId=w.id;p.waveName=w.name;p.wavePath=w.path;p.waveDataPath=w.dataPath;p.waveExists=w.exists;p.waveTag=w.tagName}}
      if('volume' in patch) p.waveLevel=Number(patch.volume??100)
      if('pan' in patch) p.wavePan=Math.round(clamp(Number(patch.pan??0),-100,100)/100*15+15)
    } else {
      if(path){const w=next.waves.find(w=>w.dataPath===path); if(w){p.subWaveId=w.id}}
      if('volume' in patch) p.subWaveLevel=Number(patch.volume??100)
      if('pan' in patch) p.subWavePan=Math.round(clamp(Number(patch.pan??0),-100,100)/100*15+15)
    }
    next.kits[selectedKit].pads[index]=p; setProject(next); scheduleAutoSync(next)
  }
  function clearEditorLayer(index:number,layer:'main'|'sub') { if(!kit)return; const next=clone(project); const p=next.kits[selectedKit].pads[index]; if(layer==='main'){p.waveId=0;p.waveName=undefined;p.wavePath=undefined;p.waveDataPath=undefined;p.waveExists=false;p.waveLevel=100;p.wavePan=15}else{p.subWaveId=0;p.subWaveLevel=100;p.subWavePan=15}; next.kits[selectedKit].pads[index]=p; setProject(next); scheduleAutoSync(next) }
  function clearEditorPad(index:number){clearEditorLayer(index,'main');clearEditorLayer(index,'sub')}
  function rememberEditorEditedBuffer(key:string, buffer:AudioBuffer, settings:{reverse:boolean;edits?:WaveformEditState}) { const [idxStr,layerStr,...rest]=key.split(':'); const idx=Number(idxStr); const layer=layerStr==='sub'?'sub':'main'; const path=rest.join(':'); if(!Number.isFinite(idx)||!path)return; const k=editorKey(idx,layer,path); editorEditedBuffersRef.current.set(k,buffer); if(settings.edits) editorEditedSettingsRef.current.set(k,clone(settings.edits)); pendingEditorWavePathsRef.current.add(path) }
  async function triggerEditorPadLayer(index:number,layer:'main'|'sub',velocity=127){
    const file=editorFileInfo(project.waves.find(w=>w.id===(layer==='main'?kit?.pads[index]?.waveId:kit?.pads[index]?.subWaveId)))
    if(!file?.path)return
    const key=editorKey(index,layer,file.path); const ctx=await ensureAudioContext(); if(ctx.state!=='running') await ctx.resume(); let buffer=editorEditedBuffersRef.current.get(key)
    if(!buffer){const bytes=await window.spd.sound.readFile(file.path);if(!bytes)return;buffer=await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer)}
    const edits=editorEditedSettingsRef.current.get(key)||{start:0,end:1,fadeIn:0,fadeOut:0,normalize:false,pitch:0,fadeInCurve:.5,fadeOutCurve:.5,playMode:'oneShot' as const,reverse:false}
    const layerMix=editorPadLayer(index,layer); const source=ctx.createBufferSource(); source.buffer=buffer; const gain=ctx.createGain(); const pan=ctx.createStereoPanner(); gain.gain.value=clamp((layerMix.volume/100)*(musicVolume/100)*(clamp(velocity,1,127)/127),0,1); pan.pan.value=clamp(layerMix.pan/100,-1,1); source.connect(gain).connect(pan).connect(audioEngine.input(index))
    const start=Math.min(Math.max(0,edits.start*buffer.duration),Math.max(0,buffer.duration-.001)); const dur=Math.max(.02,(clamp(edits.end,0,1)-clamp(edits.start,0,1))*buffer.duration); try{source.start(0,start,dur)}catch{}
    instrumentSourcesRef.current.push(source); source.onended=()=>{instrumentSourcesRef.current=instrumentSourcesRef.current.filter(x=>x!==source)}
  }
  async function triggerEditorPad(index:number,velocity=127){ await triggerEditorPadLayer(index,'main',velocity); await triggerEditorPadLayer(index,'sub',velocity) }
  function resetEditorPads(){ if(!kit)return; const next=clone(project); next.kits[selectedKit].pads=next.kits[selectedKit].pads.map(p=>({...p,waveId:0,waveName:undefined,wavePath:undefined,waveDataPath:undefined,waveExists:false,waveLevel:100,wavePan:15,subWaveId:0,subWaveLevel:100,subWavePan:15})); setProject(next); scheduleAutoSync(next); setSelectedComputerFile(undefined); setStatus(tr('Editor PAD 已全部重置')) }
  async function assignEditorWave(file:AudioFileInfo,index:number,layer:'main'|'sub'){ updateEditorPadLayer(index,layer,{filePath:file.path,fileName:file.name,sourceId:'editor'}); setSelectedPad(index); setSelectedComputerLayer(layer); setSelectedComputerFile(file); const w=project.waves.find(w=>w.dataPath===file.path); if(w) await loadWaveEditor(w) }
  async function addEditorSamples(sources:string[],tagIndex:number){ if(!project.rootPath||!sources.length)return; try{const next=await window.spd.addWaves(project,sources,tagIndex); const oldPaths=new Set(project.waves.map(w=>w.dataPath).filter(Boolean)); for(const w of next.waves){if(w.dataPath&&!oldPaths.has(w.dataPath))pendingWavePathsRef.current.add(w.dataPath)} setProject(next); setStatus(tr('已新增 Sample · {0} 個',next.waves.length-project.waves.length)); if(device.mode==='WAVE_MGR' && device.connected) await syncToDevice(next,true)}catch(e){setStatus(e instanceof Error?e.message:tr('新增 Sample 失敗'))} }
  async function flushEditorEditsBeforeSync(nextProject:ProjectModel){
    const writes=Array.from(pendingEditorWavePathsRef.current)
    if(!writes.length)return
    for(const [key,buffer] of editorEditedBuffersRef.current.entries()){
      const parts=key.split(':'); const filePath=parts.slice(4).join(':'); if(!writes.includes(filePath))continue
      try{await window.spd.writeWave({filePath,bytes:encodeWav(buffer)})}catch{}
    }
  }

  function beginMidiLearn(index:number){ setSelectedSpdPad(index); setMidiLearnPad(index); setStatus(`MIDI Learn：${index===9?'KICK':`PAD ${index+1}`} · ${t('learnNow')}`) }

  async function syncToDevice(nextProject = project, automatic = false) {
    if (!device.connected) { if (!automatic) setStatus(tr('未偵測到 SPD-SX；請先連接並切換至 WAVE MGR。')); return }
    setSyncing(true)
    try {
      await flushEditorEditsBeforeSync(nextProject)
      const wavePaths = [...pendingWavePathsRef.current, ...pendingEditorWavePathsRef.current]
      const result = await window.spd.syncProject(nextProject, wavePaths)
      pendingWavePathsRef.current.clear()
      pendingEditorWavePathsRef.current.clear()
      setStatus(tr('✓ 已同步 {0} Kits{1} → {2}',result.kitsSynced,result.wavesSynced ? ` / ${result.wavesSynced} Waves` : '',device.volumeName || 'SPD-SX'))
    } catch (e) {
      setStatus(e instanceof Error ? tr('同步失敗：{0}',e.message) : tr('同步失敗'))
    } finally {
      setSyncing(false)
    }
  }

  function scheduleAutoSync(nextProject: ProjectModel) {
    if (!autoSync || device.mode !== 'WAVE_MGR' || !device.connected || !project.rootPath) return
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => { void syncToDevice(nextProject, true) }, syncDelaySec * 1000)
    setStatus(tr('已變更 · 停止操作 {0} 秒後自動同步',syncDelaySec))
  }

  useEffect(() => {
    if (fiveMinTimerRef.current) clearInterval(fiveMinTimerRef.current)
    if (!autoSync || device.mode !== 'WAVE_MGR' || !device.connected || !project.rootPath) return
    fiveMinTimerRef.current = setInterval(() => { void syncToDevice(latestProjectRef.current, true) }, 5 * 60 * 1000)
    return () => { if (fiveMinTimerRef.current) clearInterval(fiveMinTimerRef.current) }
  }, [autoSync, device.connected, device.rootPath, project.rootPath, syncDelaySec])

  async function openDevice() {
    stopPreview(); setWaveBuffer(null)
    try {
      const next = await window.spd.openDevice()
      setProject(next); setSelectedKit(0); setSelectedPad(0)
      setStatus(tr('已連接 {0} · {1} Kits / {2} Waves',device.volumeName || 'SPD-SX',next.kits.length,next.waves.length))
    } catch (e) { setStatus(e instanceof Error ? e.message : tr('讀取 SPD-SX 失敗')) }
  }

  async function openProject() {
    stopPreview(); setWaveBuffer(null)
    const next = await window.spd.openProject(); if (!next) return
    setProject(next); setSelectedKit(0); setSelectedPad(0); setStatus(tr('已載入 {0} Kits / {1} Waves',next.kits.length,next.waves.length))
  }
  async function exportProject() { if (!project.rootPath) return; const result = await window.spd.exportProject(project); if (!result.canceled) setStatus(tr('已匯出：{0}',result.path)) }
  function updateKit(patch: Partial<KitModel>) {
    const next = clone(project)
    next.kits[selectedKit] = { ...next.kits[selectedKit], ...patch }
    setProject(next)
    scheduleAutoSync(next)
  }
  function updatePad(patch: Partial<PadModel>) {
    const next = clone(project)
    const nextPad = { ...next.kits[selectedKit].pads[selectedPad], ...patch }
    const wave = next.waves.find(w => w.id === nextPad.waveId)
    if (wave) Object.assign(nextPad, { waveName: wave.name, wavePath: wave.path, waveDataPath: wave.dataPath, waveExists: wave.exists, waveTag: wave.tagName })
    next.kits[selectedKit].pads[selectedPad] = nextPad
    setProject(next)
    scheduleAutoSync(next)
    if (isPlaying) {
      if (typeof patch.waveLevel === 'number' && gainRef.current) gainRef.current.gain.value = clamp((nextPad.waveLevel / 100) * (musicVolume / 100), 0, 1)
      if (typeof patch.wavePan === 'number' && panRef.current) panRef.current.pan.value = clamp((nextPad.wavePan - 15) / 15, -1, 1)
      if (typeof patch.loop === 'number' || typeof patch.playMode === 'number') if (sourceRef.current) sourceRef.current.loop = nextPad.loop === 1 || nextPad.playMode === 2
      if (typeof patch.reverse === 'number') void previewPad(nextPad)
    }
  }

  async function addWaveSample() {
    if (!project.rootPath) return setStatus(tr('請先開啟 SPD-SX 備份'))
    try {
      const next = await window.spd.addWave(project, waveTag === 'ALL' ? 0 : (project.tags.find(t => t.name === waveTag)?.index ?? 0))
      if (!next) return
      setProject(next)
      setWaveTag(waveTag === 'ALL' ? 'ALL' : waveTag)
      setStatus(tr('已新增 Sample · {0} Waves',next.waves.length))
    } catch (e) { setStatus(e instanceof Error ? e.message : tr('新增 Sample 失敗')) }
  }
  async function deleteWave(w: WaveModel) {
    if (!project.rootPath) return
    if (!window.confirm(tr('確定刪除 Wave {0}「{1}」？\n\n若此 Wave 正被 Pad 使用，系統會拒絕刪除。',String(w.id).padStart(3,'0'),w.name))) return
    try {
      const next = await window.spd.deleteWave(project, w.id)
      setProject(next)
      if (currentWave?.id === w.id) { stopPreview(); setWaveBuffer(null) }
      setStatus(tr('已刪除 Wave {0} · {1}',String(w.id).padStart(3,'0'),w.name))
    } catch (e) { setStatus(e instanceof Error ? e.message : tr('刪除 Wave 失敗')) }
  }
  async function addWaveCategory() {
    if (!project.rootPath) return
    const name = window.prompt(tr('新增 Wave 分類名稱：'), 'My Samples')?.trim()
    if (!name) return
    try {
      const next = await window.spd.addTag(project, name)
      setProject(next)
      setWaveTag(name)
      setStatus(tr('已新增分類：{0}',name))
    } catch (e) { setStatus(e instanceof Error ? e.message : tr('新增分類失敗')) }
  }

  async function ensureEditorKitSlot(slot:number){
    const existing=project.kits.findIndex(k=>k.slot===slot)
    if(existing>=0){setSelectedKit(existing);setSelectedPad(0);return}
    const template=project.kits[0]
    if(!template){setStatus(tr('目前專案沒有可用的 Kit 範本'));return}
    const blank=blankKitFromTemplate(template,slot,project.rootPath)
    const kits=[...project.kits,blank].sort((a,b)=>a.slot-b.slot)
    const next={...project,kits}
    setProject(next);setSelectedKit(kits.findIndex(k=>k.slot===slot));setSelectedPad(0);setKitLibraryOpen(false);setStatus(tr('已選擇空白 KIT {0}，可直接編輯',String(slot).padStart(3,'0')))
  }
  async function renameEditorKit(slot:number,name:string){
    const finalName=name.trim();if(!finalName)return
    let idx=project.kits.findIndex(k=>k.slot===slot);let next=clone(project)
    if(idx<0){const template=project.kits[0];if(!template){setStatus(tr('目前專案沒有可用的 Kit 範本'));return}next.kits=[...next.kits,blankKitFromTemplate(template,slot,project.rootPath)].sort((a,b)=>a.slot-b.slot);idx=next.kits.findIndex(k=>k.slot===slot)}
    next.kits[idx]={...next.kits[idx],name:finalName,rawText:encodeKitNameRaw(next.kits[idx].rawText,finalName),isNew:next.kits[idx].isNew};setProject(next);setSelectedKit(idx);setSelectedPad(0);setKitLibraryOpen(false);await syncToDevice(next,true);setStatus(tr('✓ KIT {0} 已重新命名',String(slot).padStart(3,'0')))
  }
  async function copyEditorKit(sourceSlot:number,targetSlot:number){
    const template=project.kits[0];if(!template)return
    const source=project.kits.find(k=>k.slot===sourceSlot) || blankKitFromTemplate(template,sourceSlot,project.rootPath)
    const existing=project.kits.findIndex(k=>k.slot===targetSlot)
    const copied=clone(source);copied.slot=targetSlot;copied.fileName=`kit${String(targetSlot).padStart(3,'0')}.spd`;copied.sourcePath=`${project.rootPath}/KIT/${copied.fileName}`;copied.rawText=encodeKitNameRaw(copied.rawText,copied.name);copied.isNew=true
    const next=clone(project)
    if(existing>=0)next.kits[existing]=copied;else next.kits=[...next.kits,copied].sort((a,b)=>a.slot-b.slot)
    setProject(next);setSelectedKit(next.kits.findIndex(k=>k.slot===targetSlot));setSelectedPad(0);setKitLibraryOpen(false);await syncToDevice(next,true);setStatus(tr('✓ KIT {0} 已複製到 {1}',String(sourceSlot).padStart(3,'0'),String(targetSlot).padStart(3,'0')))
  }
  async function deleteEditorKit(slot:number){
    if(!project.kits.some(k=>k.slot===slot)){setKitLibraryOpen(false);setStatus(tr('KIT {0} 目前是空白，無需刪除',String(slot).padStart(3,'0')));return}
    try{const next=await window.spd.deleteKit(project,slot);setProject(next);const nextIndex=next.kits.length?Math.max(0,next.kits.findIndex(k=>k.slot>=slot)):-1;setSelectedKit(nextIndex<0?Math.max(0,next.kits.length-1):nextIndex);setSelectedPad(0);setKitLibraryOpen(false);setStatus(tr('✓ KIT {0} 已刪除',String(slot).padStart(3,'0')))}catch(e){setStatus(e instanceof Error?e.message:tr('刪除 Kit 失敗'))}
  }
  async function saveCurrentEditorKit(){
    if(!project.rootPath||!kit)return setStatus(tr('請先開啟 SPD-SX 或備份'))
    if(device.mode!=='WAVE_MGR'||!device.connected)return setStatus(tr('請先連接 SPD-SX 的 WAVE MGR'))
    await syncToDevice(project,false);setStatus(tr('✓ KIT {0} 已同步儲存到 SPD-SX',String(kit.slot).padStart(3,'0')))
  }

  async function addKit() {
    if (!project.rootPath) return setStatus(tr('請先開啟 SPD-SX 備份'))
    try {
      const newKit = await window.spd.createKit(project)
      const kits = [...project.kits, newKit].sort((a,b)=>a.slot-b.slot)
      const next = { ...project, kits }
      setProject(next); setSelectedKit(kits.findIndex(k=>k.slot===newKit.slot)); setSelectedPad(0); setStatus(tr('已新增 KIT {0}',String(newKit.slot).padStart(3,'0')))
      scheduleAutoSync(next)
    } catch (e) { setStatus(e instanceof Error ? e.message : tr('新增 Kit 失敗')) }
  }
  async function ensureAudioContext() { const ctx = await audioEngine.get(); audioCtxRef.current = ctx; return ctx }
  async function loadAudioBuffer(filePath: string) { const cached = bufferCacheRef.current.get(filePath); if (cached) return cached; const bytes = await window.spd.readWave(filePath); if (!bytes) throw new Error(tr('找不到 Wave 音訊檔案')); const ctx = await ensureAudioContext(); const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); bufferCacheRef.current.set(filePath, buf); return buf }
  function stopPreview() { try { sourceRef.current?.stop() } catch {} sourceRef.current?.disconnect(); gainRef.current?.disconnect(); panRef.current?.disconnect(); sourceRef.current = null; gainRef.current = null; panRef.current = null; setIsPlaying(false) }

  async function loadWaveEditor(wave = currentWave) {
    if (!wave?.dataPath || !wave.exists) { setWaveBuffer(null); setStatus(tr('目前 Wave 沒有可編輯的 WAV 檔')); return }
    try { const buf = await loadAudioBuffer(wave.dataPath); setWaveBuffer(buf); waveEditDirtyRef.current=false; if (waveEditTimerRef.current) clearTimeout(waveEditTimerRef.current); setWaveEdits({ start: 0, end: 1, fadeIn: 0, fadeOut: 0, normalize: false, pitch: 0, fadeInCurve: 0.5, fadeOutCurve: 0.5 }); setZoom(1); setStatus(`Waveform：${wave.name}`) } catch (e) { setStatus(e instanceof Error ? tr('Waveform 載入失敗：{0}',e.message) : tr('Waveform 載入失敗')) }
  }
  useEffect(() => { void loadWaveEditor(currentWave) }, [currentWave?.id, currentWave?.dataPath])
  useEffect(() => {
    if (!waveBuffer || !currentWave?.dataPath) return
    if (!waveEditDirtyRef.current) return
    if (waveEditTimerRef.current) clearTimeout(waveEditTimerRef.current)
    waveEditTimerRef.current = setTimeout(() => { void renderEditedWave(true, true) }, 10000)
    setStatus(tr('Waveform 已變更 · 停止操作 {0} 秒後自動套用並同步',syncDelaySec))
    return () => { if (waveEditTimerRef.current) clearTimeout(waveEditTimerRef.current) }
  }, [waveEdits, waveBuffer, currentWave?.dataPath, syncDelaySec])
  useEffect(() => { drawWaveform() }, [waveBuffer, waveEdits, zoom])

  function getEditedRange() { if (!waveBuffer) return null; const start = clamp(waveEdits.start, 0, .999); const end = clamp(Math.max(waveEdits.end, start + .001), .001, 1); return { start: Math.floor(start * waveBuffer.length), end: Math.min(waveBuffer.length, Math.floor(end * waveBuffer.length)) } }
  function fadeInGain(t:number) { return Math.pow(clamp(t,0,1), Math.max(.05,waveEdits.fadeInCurve*2)) }
  function fadeOutGain(t:number) { return Math.pow(clamp(t,0,1), Math.max(.05,waveEdits.fadeOutCurve*2)) }
  function drawWaveform() {
    const canvas = canvasRef.current; if (!canvas || !waveBuffer) return
    const rect = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(rect.width * dpr)); canvas.height = Math.max(1, Math.floor(rect.height * dpr))
    const ctx = canvas.getContext('2d'); if (!ctx) return; ctx.setTransform(dpr,0,0,dpr,0,0)
    const shell=canvas.closest('.app-shell') as HTMLElement|null; const css=getComputedStyle(shell||document.documentElement); const themeBg=css.getPropertyValue('--core-bg').trim()||'#0b0f14'; const themeLine=css.getPropertyValue('--core-line').trim()||'#39424d'; const themeAccent=css.getPropertyValue('--core-accent').trim()||'#dfe7ee';
    const w = rect.width, h = rect.height; ctx.clearRect(0,0,w,h); ctx.fillStyle=themeBg; ctx.fillRect(0,0,w,h)
    const data = waveBuffer.getChannelData(0); const visibleEnd = Math.min(data.length, Math.max(Math.floor(data.length / zoom), 1)); const samplesPerPixel = Math.max(1, Math.floor(visibleEnd / w))
    const start = waveEdits.start * data.length, end = waveEdits.end * data.length
    for (let x=0; x<w; x++) { const a=Math.min(data.length-1,Math.floor(x*visibleEnd/w)); const b=Math.min(data.length,a+samplesPerPixel); let min=1,max=-1; for(let i=a;i<b;i++){const v=data[i];if(v<min)min=v;if(v>max)max=v} const inRange=a>=start&&a<=end; ctx.strokeStyle=inRange?themeAccent:themeLine;ctx.globalAlpha=inRange?.92:.3;ctx.beginPath();ctx.moveTo(x,h/2+min*h*.4);ctx.lineTo(x,h/2+max*h*.4);ctx.stroke() }
    ctx.globalAlpha=1; ctx.strokeStyle=themeLine;ctx.beginPath();ctx.moveTo(0,h/2+.5);ctx.lineTo(w,h/2+.5);ctx.stroke()
    const sx=start/data.length*w, ex=end/data.length*w;ctx.fillStyle='rgba(7,10,14,.68)';ctx.fillRect(0,0,sx,h);ctx.fillRect(ex,0,w-ex,h)
    // White Start/End handles at top
    ctx.strokeStyle='#ffffff';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(sx,0);ctx.lineTo(sx,18);ctx.moveTo(ex,0);ctx.lineTo(ex,18);ctx.stroke();
    ctx.fillStyle='#fff';ctx.beginPath();ctx.moveTo(sx,3);ctx.lineTo(sx+7,3);ctx.lineTo(sx,11);ctx.closePath();ctx.fill();ctx.beginPath();ctx.moveTo(ex,3);ctx.lineTo(ex-7,3);ctx.lineTo(ex,11);ctx.closePath();ctx.fill();
    // Yellow Fade handles at bottom and editable curves
    const spanPx=Math.max(18,ex-sx); const fadeInPx=Math.min(spanPx, Math.max(16, waveEdits.fadeIn / Math.max(waveBuffer.duration,.001) * w)); const fadeOutPx=Math.min(spanPx, Math.max(16, waveEdits.fadeOut / Math.max(waveBuffer.duration,.001) * w));
    const yellow=themeAccent; ctx.strokeStyle=yellow;ctx.lineWidth=2;
    const fiEnd=sx+fadeInPx, foStart=ex-fadeOutPx;
    ctx.beginPath();ctx.moveTo(sx,h-16);ctx.lineTo(sx,h);ctx.moveTo(fiEnd,h-16);ctx.lineTo(fiEnd,h);ctx.moveTo(foStart,h-16);ctx.lineTo(foStart,h);ctx.moveTo(ex,h-16);ctx.lineTo(ex,h);ctx.stroke();
    ctx.fillStyle=yellow;[sx,fiEnd,foStart,ex].forEach((x)=>{ctx.beginPath();ctx.moveTo(x,h-12);ctx.lineTo(x-6,h-3);ctx.lineTo(x+6,h-3);ctx.closePath();ctx.fill()})
    const drawCurve=(x0:number,len:number,kind:'in'|'out',fallback=true)=>{if(len<=0)return;ctx.strokeStyle=yellow;ctx.lineWidth=2;ctx.beginPath();for(let i=0;i<=len;i++){const t=i/len;const g=kind==='in'?Math.pow(t,Math.max(.05,waveEdits.fadeInCurve*2)):Math.pow(1-t,Math.max(.05,waveEdits.fadeOutCurve*2));const x=x0+i;const y=h-22-g*(h*.44);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.stroke()}
    drawCurve(sx,fadeInPx,'in');drawCurve(foStart,fadeOutPx,'out');
    ctx.fillStyle=themeAccent;ctx.font='12px system-ui,-apple-system,sans-serif';ctx.fillText(`START ${formatTime(waveEdits.start*waveBuffer.duration)}`, Math.min(w-110,sx+8), 14);ctx.fillText(`END ${formatTime(waveEdits.end*waveBuffer.duration)}`, Math.max(6,ex-82), 14)
  }
  function canvasRatio(clientX: number) { const c=canvasRef.current; if(!c) return 0; const r=c.getBoundingClientRect(); return clamp((clientX-r.left)/r.width,0,1) }
  function curveYAt(ratio:number, kind:'in'|'out') {
    const start=waveEdits.start, end=waveEdits.end, span=Math.max(.001,end-start)
    if(kind==='in'){const local=clamp((ratio-start)/span,0,1); return 1 - fadeInGain(local)*.52}
    const fadeStart=end-Math.max(.001,waveEdits.fadeOut/(waveBuffer?.duration||1)); const local=clamp((ratio-fadeStart)/Math.max(.001,end-fadeStart),0,1); return 1 - fadeOutGain(1-local)*.52
  }
  function waveformPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!waveBuffer) return
    const ratio=canvasRatio(e.clientX), r=e.currentTarget.getBoundingClientRect(), y=(e.clientY-r.top)/r.height
    const start=waveEdits.start,end=waveEdits.end,threshold=.024
    const fadeInLen=Math.min(.25,Math.max(.02,waveEdits.fadeIn/Math.max(waveBuffer.duration,.001)))
    const fadeOutLen=Math.min(.25,Math.max(.02,waveEdits.fadeOut/Math.max(waveBuffer.duration,.001)))
    const curveInY=curveYAt(ratio,'in'),curveOutY=curveYAt(ratio,'out')
    let mode: typeof canvasDragRef.current.mode=null
    if(y<.26 && Math.abs(ratio-start)<threshold) mode='start'
    else if(y<.26 && Math.abs(ratio-end)<threshold) mode='end'
    else if(y>.72 && Math.abs(ratio-start)<threshold) mode='fadeIn'
    else if(y>.72 && Math.abs(ratio-end)<threshold) mode='fadeOut'
    else if(Math.abs(y-curveInY)<.10 && ratio>=start && ratio<=start+fadeInLen) mode='fadeInCurve'
    else if(Math.abs(y-curveOutY)<.10 && ratio>=end-fadeOutLen && ratio<=end) mode='fadeOutCurve'
    canvasDragRef.current={mode,startX:e.clientX,startY:e.clientY}; if(mode)e.currentTarget.setPointerCapture(e.pointerId)
  }
  function waveformPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const r=e.currentTarget.getBoundingClientRect(); const ratio=canvasRatio(e.clientX); const y=(e.clientY-r.top)/Math.max(r.height,1); const mode=canvasDragRef.current.mode;
    if(!mode&&waveBuffer){
      const th=.03, top=.26, bottom=.72; const fi=Math.min(.25,Math.max(.02,waveEdits.fadeIn/Math.max(waveBuffer.duration,.001))); const fo=Math.min(.25,Math.max(.02,waveEdits.fadeOut/Math.max(waveBuffer.duration,.001)));
      const inCurve=curveYAt(ratio,'in'), outCurve=curveYAt(ratio,'out'); const nearStart=Math.abs(ratio-waveEdits.start)<th, nearEnd=Math.abs(ratio-waveEdits.end)<th;
      if((nearStart||nearEnd)&&(y<top||y>bottom)) e.currentTarget.style.cursor='ew-resize';
      else if((ratio>=waveEdits.start&&ratio<=waveEdits.start+fi&&Math.abs(y-inCurve)<.11)||(ratio>=waveEdits.end-fo&&ratio<=waveEdits.end&&Math.abs(y-outCurve)<.11)) e.currentTarget.style.cursor='ns-resize';
      else e.currentTarget.style.cursor='default';
      return;
    }
    if(!mode||!waveBuffer)return
    waveEditDirtyRef.current=true
    const dy=(e.clientY-canvasDragRef.current.startY)/Math.max(r.height,1)
    setWaveEdits(prev=>{
      if(mode==='start') return {...prev,start:Math.min(ratio,prev.end-.001)}
      if(mode==='end') return {...prev,end:Math.max(ratio,prev.start+.001)}
      if(mode==='fadeIn') return {...prev,fadeIn:clamp(ratio-prev.start,0,Math.max(.001,prev.end-prev.start-.001))*waveBuffer.duration}
      if(mode==='fadeOut') return {...prev,fadeOut:clamp(prev.end-ratio,0,Math.max(.001,prev.end-prev.start-.001))*waveBuffer.duration}
      if(mode==='fadeInCurve') return {...prev,fadeInCurve:clamp(prev.fadeInCurve-dy,0.05,0.95)}
      return {...prev,fadeOutCurve:clamp(prev.fadeOutCurve-dy,0.05,0.95)}
    })
  }
  function waveformPointerUp(e: React.PointerEvent<HTMLCanvasElement>) { canvasDragRef.current.mode=null; e.currentTarget.style.cursor='default'; try{e.currentTarget.releasePointerCapture(e.pointerId)}catch{} }

  function makeEditedBuffer(buffer: AudioBuffer) {
    const rangeStart = Math.floor(clamp(waveEdits.start, 0, .99) * buffer.length)
    const rangeEnd = Math.min(
      buffer.length,
      Math.max(rangeStart + 1, Math.floor(clamp(waveEdits.end, waveEdits.start + .001, 1) * buffer.length))
    )
    const frameCount = rangeEnd - rangeStart
    const out = new AudioBuffer({
      length: frameCount,
      numberOfChannels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
    })

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const source = buffer.getChannelData(ch).subarray(rangeStart, rangeEnd)
      out.getChannelData(ch).set(source)
    }

    for (let ch = 0; ch < out.numberOfChannels; ch++) {
      const data = out.getChannelData(ch)
      const editDuration = Math.max(out.duration, .001)
      const fadeInS = Math.min(data.length, Math.floor((waveEdits.fadeIn / editDuration) * data.length))
      const fadeOutS = Math.min(data.length, Math.floor((waveEdits.fadeOut / editDuration) * data.length))
      for (let i = 0; i < data.length; i++) {
        if (fadeInS > 0 && i < fadeInS) data[i] *= fadeInGain(i / Math.max(1, fadeInS - 1))
        if (fadeOutS > 0 && i >= data.length - fadeOutS) data[i] *= fadeOutGain((data.length - 1 - i) / Math.max(1, fadeOutS - 1))
      }
    }

    if (waveEdits.normalize) {
      let peak = 0
      for (let ch = 0; ch < out.numberOfChannels; ch++) {
        const d = out.getChannelData(ch)
        for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]))
      }
      if (peak > 1e-5) {
        const mul = .98 / peak
        for (let ch = 0; ch < out.numberOfChannels; ch++) {
          const d = out.getChannelData(ch)
          for (let i = 0; i < d.length; i++) d[i] *= mul
        }
      }
    }
    return out
  }
  async function previewPad(targetPad = pad) {
    if (!targetPad?.waveDataPath || !targetPad.waveExists) { setStatus(tr('目前 PAD 沒有可預覽的 Wave')); return }
    stopPreview(); try { const ctx=await ensureAudioContext(); const raw=await loadAudioBuffer(targetPad.waveDataPath); const useEdited=!!waveBuffer && targetPad.index===selectedPad && currentWave?.dataPath===targetPad.waveDataPath; const buffer=useEdited?makeEditedBuffer(waveBuffer!):raw; const source=ctx.createBufferSource(); const gain=ctx.createGain(); const pan=ctx.createStereoPanner(); source.buffer=buffer; source.loop=waveEdits.playMode==='gate' ? false : (targetPad.loop===1||targetPad.playMode===2); source.playbackRate.value=1; gain.gain.value=clamp((targetPad.waveLevel/100)*(musicVolume/100),0,1); pan.pan.value=clamp((targetPad.wavePan-15)/15,-1,1); source.connect(gain).connect(pan).connect(audioEngine.input(targetPad.index)); sourceRef.current=source; gainRef.current=gain; panRef.current=pan; source.onended=()=>{if(sourceRef.current===source)stopPreview()}; setIsPlaying(true); if(waveEdits.reverse || targetPad.reverse===1){source.buffer=reverseBuffer(ctx,buffer)} source.start() } catch(e){setStatus(e instanceof Error?tr('預覽失敗：{0}',e.message):tr('預覽失敗'));stopPreview()}
  }
  async function assignWave(w: WaveModel) { if(!pad)return; setSelectedPad(pad.index); updatePad({waveId:w.id,waveName:w.name,wavePath:w.path,waveDataPath:w.dataPath,waveExists:w.exists,waveTag:w.tagName}); setStatus(`PAD ${String(pad.index+1).padStart(2,'0')} ← ${w.name}`); await loadWaveEditor(w) }
  async function previewWave(w: WaveModel, maxSeconds=3) {
    await loadWaveEditor(w)
    if(!w?.dataPath || !w.exists) return
    try {
      stopPreview(); const ctx=await ensureAudioContext(); const raw=await loadAudioBuffer(w.dataPath)
      const useEdited=!!waveBuffer && currentWave?.dataPath===w.dataPath
      const buffer=useEdited?makeEditedBuffer(waveBuffer!):raw
      const source=ctx.createBufferSource(); const gain=ctx.createGain(); const pan=ctx.createStereoPanner(); source.buffer=buffer
      gain.gain.value=clamp(musicVolume/100,0,1); pan.pan.value=0; source.connect(gain).connect(pan).connect(audioEngine.input())
      sourceRef.current=source; gainRef.current=gain; panRef.current=pan; setIsPlaying(true)
      source.onended=()=>{if(sourceRef.current===source)stopPreview()}
      source.start(0,0,Math.min(Math.max(.05,maxSeconds),buffer.duration||maxSeconds))
    } catch(e){setStatus(e instanceof Error?tr('預覽失敗：{0}',e.message):tr('預覽失敗'))}
  }
  function handleWaveDragStart(e: React.DragEvent, w: WaveModel) { e.dataTransfer.setData('application/x-spd-sx-wave',String(w.id)); e.dataTransfer.effectAllowed='copy' }
  function dropWaveOnPad(e: React.DragEvent, target: PadModel) { e.preventDefault(); const id=Number(e.dataTransfer.getData('application/x-spd-sx-wave')); const w=project.waves.find(x=>x.id===id); if(!w)return; setSelectedPad(target.index); void assignWave(w) }

  async function renderEditedWave(saveToDevice = false, syncImmediately = false) {
    if(!waveBuffer||!currentWave)return
    const ctx=await ensureAudioContext(); const pitchRate=Math.pow(2,waveEdits.pitch/12); const range=getEditedRange(); if(!range)return; const outLength=Math.max(1,Math.floor((range.end-range.start)/pitchRate)); const out=ctx.createBuffer(waveBuffer.numberOfChannels,outLength,waveBuffer.sampleRate); let peak=0
    for(let ch=0;ch<waveBuffer.numberOfChannels;ch++){const input=waveBuffer.getChannelData(ch),output=out.getChannelData(ch);for(let i=0;i<outLength;i++){const src=range.start+i*pitchRate, i0=Math.floor(src), i1=Math.min(range.end-1,i0+1), frac=src-i0; let v=(input[i0]||0)*(1-frac)+(input[i1]||0)*frac; const fadeInSamples=Math.min(outLength,Math.floor((waveEdits.fadeIn/Math.max(waveBuffer.duration,.001))*outLength)), fadeOutSamples=Math.min(outLength,Math.floor((waveEdits.fadeOut/Math.max(waveBuffer.duration,.001))*outLength)); if(fadeInSamples>0&&i<fadeInSamples)v*=fadeInGain(i/Math.max(1,fadeInSamples-1)); if(fadeOutSamples>0&&i>=outLength-fadeOutSamples)v*=fadeOutGain((outLength-1-i)/Math.max(1,fadeOutSamples-1)); output[i]=v; peak=Math.max(peak,Math.abs(v))}}
    if(waveEdits.normalize&&peak>0.00001){const mul=.98/peak;for(let ch=0;ch<out.numberOfChannels;ch++){const d=out.getChannelData(ch);for(let i=0;i<d.length;i++)d[i]*=mul}}
    const bytes=encodeWav(out)
    if(saveToDevice){
      if(!currentWave.dataPath) { setStatus(tr('目前 Wave 沒有資料路徑，無法套用')); return }
      await window.spd.writeWave({filePath:currentWave.dataPath,bytes}); bufferCacheRef.current.delete(currentWave.dataPath); bufferCacheRef.current.set(currentWave.dataPath,out); setWaveBuffer(out); waveEditDirtyRef.current=false; pendingWavePathsRef.current.add(currentWave.dataPath); await syncToDevice(latestProjectRef.current, true); return
      return
    }
    const base=(currentWave.name||'edited-wave').replace(/\.[^.]+$/,''); const result=await window.spd.saveWave({defaultName:`${base}_edited.wav`,bytes}); if(!result.canceled)setStatus(tr('已匯出編輯後 Wave：{0}',result.path))
  }
  useEffect(() => {
    let cancelled=false
    if(!audioSources.length){ setAllAudioFiles([]); return }
    void Promise.all(audioSources.map(async s=>{ try { return await window.spd.sound.listFiles(s.path) } catch { return [] } })).then(groups=>{ if(!cancelled) setAllAudioFiles(groups.flat()) })
    return ()=>{cancelled=true}
  }, [audioSources])

  useEffect(() => { void loadAudioSourceFiles(selectedAudioSource) }, [activeAudioSourceId])
  useEffect(() => { const a=spdPadAssignments[selectedSpdPad]; const layerData=a?.[selectedComputerLayer]; const targetPath=layerData?.filePath || (selectedComputerLayer==='main'?a?.filePath:undefined); if(!targetPath){setSelectedComputerFile(undefined);return}; const found=audioFiles.find(file=>file.path===targetPath); setSelectedComputerFile(found || {name:layerData?.fileName || a?.fileName || 'Audio',path:targetPath,size:0,extension:targetPath.split('.').pop()?.toLowerCase()||''}) }, [selectedSpdPad, selectedComputerLayer, audioFiles, spdPadAssignments])
  useEffect(() => { if (kit) setSpdPadAssignments(prev => prev.map((a,i)=>({...a, midiNote: a.midiNote || kit.pads[i]?.noteNumber || (36+i)}))) }, [selectedKit, kit?.slot])
  useEffect(() => { instrumentGainByPadRef.current.forEach(g=>{try{g.gain.value = clamp((100/100)*(musicVolume/100),0,1)}catch{}}) }, [musicVolume])
  useEffect(() => { uiSfxCacheRef.current.forEach(a=>{ try{a.pause()}catch{} }); uiSfxCacheRef.current.clear() }, [soundStyle])
  useEffect(() => { uiSfxCacheRef.current.forEach(a=>{ a.volume=clamp(soundVolume/100,0,1) }) }, [soundVolume])
  useEffect(() => { const prev=Math.max(1,musicVolumeRef.current); const ratio=musicVolume/prev; instrumentGainByPadRef.current.forEach(g=>{try{g.gain.value=clamp(g.gain.value*ratio,0,1)}catch{}}); musicVolumeRef.current=musicVolume }, [musicVolume])

  function encodeWav(buffer: AudioBuffer): Uint8Array { const channels=buffer.numberOfChannels, rate=buffer.sampleRate, frames=buffer.length, dataSize=frames*channels*2, out=new ArrayBuffer(44+dataSize), view=new DataView(out); const write=(off:number,s:string)=>{for(let i=0;i<s.length;i++)view.setUint8(off+i,s.charCodeAt(i))}; write(0,'RIFF');view.setUint32(4,36+dataSize,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,rate,true);view.setUint32(28,rate*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,dataSize,true);let o=44;for(let i=0;i<frames;i++)for(let ch=0;ch<channels;ch++){const s=clamp(buffer.getChannelData(ch)[i],-1,1);view.setInt16(o,s<0?s*0x8000:s*0x7fff,true);o+=2} return new Uint8Array(out) }

  return <div className="app-shell" data-scheme={isLightColor(themeBg)?'light':'dark'} data-theme={themeMode} data-cyber-default={themeMode==='cyberpunk'&&themeLine.toLowerCase()==='#35e0ff'?'true':'false'} style={{'--core-bg':themeBg,'--core-line':themeLine,'--core-accent':themeAccent,'--core-grad-start':themeGradStart,'--core-grad-end':themeGradEnd,'--core-pixel-size':`${themePixelSize}px`,'--core-font-scale':String(fontSize/100),'--core-chrome-scale':String(Math.min(fontSize/100,1.15)),'--core-ui-scale':'1','--core-font-family':fontFamily === 'mono' ? 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' : fontFamily === 'rounded' ? 'Avenir Next, Helvetica Neue, system-ui, sans-serif' : 'system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'} as React.CSSProperties}>
    <header className="topbar">
      <div className="brand"><img className="brand-mark" src={logoTile} alt="Core SX" draggable={false}/><div><strong>Core SX</strong><span>v{__APP_VERSION__} · SPD-SX CONTROLLER / INSTRUMENT</span></div></div>
      <nav className="top-page-tabs" aria-label="Core SX pages">
        <button className={activePage==='editor'?'active':''} disabled={device.mode==='AUDIO_MIDI'} onClick={()=>setActivePage('editor')}><span>✎</span>{t('editor')}</button>
        <button className={activePage==='spdPad'?'active':''} onClick={()=>setActivePage('spdPad')}><span>◉</span>{t('spdPad')}</button>
        <button className={activePage==='midi'?'active':''} onClick={()=>setActivePage('midi')}><span>⌁</span>{t('midi')}</button>
        <button className={activePage==='settings'?'active':''} onClick={()=>setActivePage('settings')}><span>⚙</span>{t('settings')}</button>
      </nav>
      <div className="topbar-right">
        <div className={`device-bar mode-${device.mode.toLowerCase()}`}><span className={`device-dot ${device.connected ? 'online' : 'offline'}`}></span><div><strong>{device.mode === 'WAVE_MGR' ? 'SPD-SX · Editor Mode' : device.mode === 'AUDIO_MIDI' ? 'SPD-SX · SPD Pad Mode' : device.connected ? 'SPD-SX Connected' : 'SPD-SX Not Connected'}</strong><small>{device.mode === 'WAVE_MGR' ? `${device.volumeName || 'Roland'} · WAVE MGR` : device.mode === 'AUDIO_MIDI' ? tr('AUDIO/MIDI · SPD 作為控制器') : (device.reason || tr('未偵測到 SPD-SX 的 WAVE MGR 或 AUDIO/MIDI 連線'))}</small></div>
          {device.mode === 'WAVE_MGR' && <><label className="auto-sync"><span className="sync-interval">{tr('停止 {0}s',syncDelaySec)}</span><input type="checkbox" checked={autoSync} onChange={e=>setAutoSync(e.target.checked)}/> Auto Sync</label><select className="sync-delay-select" value={syncDelaySec} onChange={e=>setSyncDelaySec(Number(e.target.value))}><option value={3}>3s</option><option value={5}>5s</option><option value={10}>10s</option><option value={15}>15s</option><option value={30}>30s</option><option value={60}>60s</option><option value={120}>120s</option></select><button className="btn mini" disabled={!device.connected || !project.rootPath || syncing} onClick={()=>void syncToDevice()}>{syncing ? tr('同步中…') : t('sync')}</button><button className="btn mini" disabled={!device.connected} onClick={()=>void openDevice()}>{t('readDevice')}</button></>}
        </div>
        <div className="toolbar"><button className="btn secondary" onClick={openProject}>{t('openBackup')}</button>{device.mode === 'WAVE_MGR' && <button className="btn secondary" disabled={!project.rootPath} onClick={addKit}>＋ {t('addKit')}</button>}{device.mode === 'WAVE_MGR' && <button className="btn primary" disabled={!project.rootPath} onClick={exportProject}>{t('export')}</button>}</div>
      </div>
    </header>
    <div className={`workspace ${['settings','midi','spdPad','editor'].includes(activePage)?'workspace-single-page':''}`}>
      {activePage==='settings' ? <FitPage key="settings" kind="flow"><SettingsPage t={t} language={language} musicVolume={musicVolume} soundVolume={soundVolume} soundStyle={soundStyle} velocitySensitivity={velocitySensitivity} padSensitivities={padSensitivities} audioSources={audioSources} themeMode={themeMode} themeBg={themeBg} themeLine={themeLine} themeAccent={themeAccent} themeGradStart={themeGradStart} themeGradEnd={themeGradEnd} themePixelSize={themePixelSize} fontSize={fontSize} fontSizeUnit={fontSizeUnit} fontFamily={fontFamily} onApply={next=>{setLanguage(next.language);setMusicVolume(next.musicVolume);setSoundVolume(next.soundVolume);setSoundStyle(next.soundStyle);setVelocitySensitivity(next.velocitySensitivity);setPadSensitivities(next.padSensitivities);setThemeMode(next.themeMode);setThemeBg(next.themeBg);setThemeLine(next.themeLine);setThemeAccent(next.themeAccent);setThemeGradStart(next.themeGradStart);setThemeGradEnd(next.themeGradEnd);setThemePixelSize(next.themePixelSize);setFontFamily(next.fontFamily);setFontSize(next.fontSize);localStorage.setItem('core-sx-font-size',String(next.fontSize));localStorage.setItem('core-sx-font-size-unit','percent');localStorage.setItem('core-sx-font-family',next.fontFamily);setStatus('✓ '+(next.language==='zh-TW'?'設定已套用':next.language==='en'?'Settings applied':next.language==='ja'?'設定を適用しました':'설정을 적용했습니다'))}} chooseAudioSource={chooseAudioSource} deleteAudioSource={deleteAudioSource} updateSourceName={(id,name)=>setAudioSources(prev=>prev.map(s=>s.id===id?{...s,name}:s))} /></FitPage>
      : activePage==='midi' ? <FitPage key="midi" kind="flow"><InstrumentMode t={t} midiPorts={midiPorts} midiStatus={midiStatus} midiLog={midiLog} midiChannel={midiChannel} setMidiChannel={setMidiChannel} midiInPort={midiInPort} midiOutPort={midiOutPort} setMidiInPort={setMidiInPort} setMidiOutPort={setMidiOutPort} connectMidiInput={connectMidiInput} connectMidiOutput={connectMidiOutput} refreshMidiPorts={()=>void refreshMidiPorts()} sendProgramChange={sendProgramChange} midiAppControl={midiAppControl} setMidiAppControl={setMidiAppControl} sysexHex={sysexHex} setSysexHex={setSysexHex} sendSysexHex={sendSysexHex} modeReady={midiStatus.inputOpen || midiStatus.outputOpen} /></FitPage>
      : activePage==='editor' ? <FitPage key="editor" kind="pads"><EditorPadPage kit={kit} kits={project.kits} selectedKit={selectedKit} onSelectKit={(idx)=>{setSelectedKit(idx);setSelectedPad(0)}} waves={project.waves} tags={project.tags} selectedPad={selectedPad} setSelectedPad={setSelectedPad} selectedLayer={selectedComputerLayer} setSelectedLayer={setSelectedComputerLayer} midiLearnPad={midiLearnPad} onLearn={beginMidiLearn} midiConnected={device.mode==='AUDIO_MIDI' && midiStatus.inputOpen} hitVisual={padHitVisual} selectedFile={selectedComputerFile} onSelectFile={(file)=>setSelectedComputerFile(file)} onPreviewWave={previewWave} onAssign={assignEditorWave} onPlay={(i)=>triggerEditorPad(i)} onPlayLayer={(i,l)=>triggerEditorPadLayer(i,l)} editedBuffer={kit && (selectedComputerLayer==='main'?kit.pads[selectedPad]?.waveId:kit.pads[selectedPad]?.subWaveId) ? editorEditedBuffersRef.current.get(editorKey(selectedPad,selectedComputerLayer,project.waves.find(w=>w.id===(selectedComputerLayer==='main'?kit.pads[selectedPad]?.waveId:kit.pads[selectedPad]?.subWaveId))?.dataPath || '')) : undefined} editedSettings={kit && (selectedComputerLayer==='main'?kit.pads[selectedPad]?.waveId:kit.pads[selectedPad]?.subWaveId) ? editorEditedSettingsRef.current.get(editorKey(selectedPad,selectedComputerLayer,project.waves.find(w=>w.id===(selectedComputerLayer==='main'?kit.pads[selectedPad]?.waveId:kit.pads[selectedPad]?.subWaveId))?.dataPath || '')) : undefined} onEditedBuffer={rememberEditorEditedBuffer} t={t} musicVolume={musicVolume} onMixChange={updateEditorPadLayer.bind(null)} onClearLayer={clearEditorLayer} onClearPad={clearEditorPad} onAddSamples={addEditorSamples} onAddCategory={async()=>{await addWaveCategory()}} onResetPads={resetEditorPads} kitPresets={spdKitPresets} kitLibraryOpen={kitLibraryOpen} setKitLibraryOpen={setKitLibraryOpen} onSaveKit={(mode,name)=>commitSpdKitSave(mode,name)} onSaveCurrentKit={saveCurrentEditorKit} onEnsureKitSlot={ensureEditorKitSlot} onRenameKit={renameEditorKit} onCopyKit={copyEditorKit} onDeleteKit={deleteEditorKit} waveSearch={waveSearch} setWaveSearch={setWaveSearch} waveTag={waveTag} setWaveTag={setWaveTag} /></FitPage>
      : activePage==='spdPad' ? <FitPage key="spd" kind="pads"><SpdPadPage onFxChange={updateSpdFx} assignments={spdPadAssignments} selectedPad={selectedSpdPad} setSelectedPad={setSelectedSpdPad} selectedLayer={selectedComputerLayer} setSelectedLayer={setSelectedComputerLayer} midiLearnPad={midiLearnPad} setMidiLearnPad={setMidiLearnPad} onLearn={beginMidiLearn} hitVisual={padHitVisual} midiConnected={device.mode==='AUDIO_MIDI' && midiStatus.inputOpen} sources={audioSources} activeSource={selectedAudioSource} files={audioFiles} allFiles={allAudioFiles} busy={soundLibraryBusy} onSourceChange={id=>{setActiveAudioSourceId(id);setSelectedComputerFile(undefined)}} onAddSource={chooseAudioSource} onAssign={assignComputerFile} onSelectFile={selectComputerFile} onPlay={triggerComputerPad} onPlayLayer={triggerComputerPadLayer} noteFor={instrumentPadNote} selectedFile={selectedComputerFile} t={t} musicVolume={musicVolume} onEditedBuffer={(key,buffer,settings)=>rememberEditedComputerBuffer(key,buffer,{...settings,edits:settings.edits})} editedBuffer={selectedComputerFile?computerEditedBuffersRef.current.get(computerKey(selectedSpdPad,selectedComputerLayer,selectedComputerFile.path)):undefined} editedSettings={selectedComputerFile?computerEditedSettingsRef.current.get(computerKey(selectedSpdPad,selectedComputerLayer,selectedComputerFile.path)):undefined} onResetPads={resetSpdPads} onMixChange={(index,layer,patch)=>setSpdPadAssignments(prev=>prev.map((a,i)=>i===index?{...a,[layer]:{...a[layer],...patch}}:a))} onClearLayer={clearComputerLayer} onClearPad={clearComputerPad} kitPresets={spdKitPresets} kitLibraryOpen={kitLibraryOpen} setKitLibraryOpen={setKitLibraryOpen} onSaveKit={(mode,name)=>commitSpdKitSave(mode,name)} onLoadKit={loadSpdKitPreset} onDeleteKit={deleteSpdKitPreset} /></FitPage>
      : <>
      <aside className="sidebar">
        <div className="section-title"><span>{t('kitList')}</span><span>{project.kits.length}/100</span></div>
        <input className="search" placeholder={t('search')+' Kit...'} value={search} onChange={e=>setSearch(e.target.value)}/>
        <div className="kit-list">{filteredKits.map(k=>{const idx=project.kits.findIndex(x=>x.slot===k.slot);return <button key={k.slot} className={`kit-item ${idx===selectedKit?'active':''}`} onClick={()=>{stopPreview();setSelectedKit(idx);setSelectedPad(0)}}><span className="kit-slot">{String(k.slot).padStart(3,'0')}</span><span className="kit-name">{k.name||'(Unnamed)'}</span><span className="kit-tempo">{Math.round(k.tempo)} BPM</span></button>})}</div>
        <button className="sidebar-add-kit btn secondary" disabled={!project.rootPath} onClick={addKit}>＋ {t('addKit')}</button>
      </aside>

      <main className="editor-column">{!kit?<EmptyState onOpen={openProject} t={t}/>:<>
        <section className="pad-section">
          <div className="kit-header"><div><div className="eyebrow">KIT {String(kit.slot).padStart(3,'0')}{kit.isNew?' · NEW':''}</div><input className="kit-title-input" value={kit.name} onChange={e=>updateKit({name:e.target.value})}/><div className="kit-subtitle">{kit.subtitle}</div></div><div className="kit-meta"><label>LEVEL<input type="number" min="0" max="100" value={kit.level} onChange={e=>updateKit({level:Number(e.target.value)})}/></label><label>BPM<input type="number" min="20" max="300" value={Math.round(kit.tempo)} onChange={e=>updateKit({tempo:Number(e.target.value)})}/></label></div></div>
          <div className="pad-grid">{visiblePadIndexes.map((padIndex,visibleIndex)=>{ const p=kit.pads[padIndex]; if(!p)return null; const isKick=visibleIndex===9; const label=isKick?'KICK':`PAD ${visibleIndex+1}`; return <button key={padIndex} className={`pad ${isKick?'kick-pad':''} ${padIndex===selectedPad?'selected':''} ${isPlaying&&padIndex===selectedPad?'playing':''}`} onDragOver={e=>e.preventDefault()} onDrop={e=>dropWaveOnPad(e,p)} onClick={()=>{setSelectedPad(padIndex);void previewPad(p);void loadWaveEditor(project.waves.find(w=>w.id===p.waveId))}}><div className="pad-number">{label}</div><div className="pad-wave">{p.waveName||`WAVE ${p.waveId}`}</div><div className="pad-bottom"><span>{playModes[p.playMode]??`Mode ${p.playMode}`}</span><span>{p.waveLevel}%</span></div><div className="pad-play-indicator">▶</div></button>})}</div>
        </section>

        <section className="waveform-editor">
          <div className="waveform-head"><div><div className="eyebrow">{t('waveformEditor')}</div><div className="waveform-title">{currentWave?.name||'No Wave'} <span>{waveBuffer?`${formatTime(waveBuffer.duration)} · ${waveBuffer.sampleRate} Hz`:'—'}</span></div></div><div className="waveform-actions"><button className="btn mini" disabled={!waveBuffer} onClick={()=>{waveEditDirtyRef.current=true;setWaveEdits({start:0,end:1,fadeIn:0,fadeOut:0,normalize:false,pitch:0,fadeInCurve:0.5,fadeOutCurve:0.5})}}>{t('reset')}</button><button className="btn mini" disabled={!waveBuffer} onClick={()=>void renderEditedWave(false)}>{t('exportWav')}</button></div></div>
          <div className="waveform-canvas-wrap"><canvas ref={canvasRef} className="waveform-canvas" onPointerDown={waveformPointerDown} onPointerMove={waveformPointerMove} onPointerUp={waveformPointerUp} onPointerCancel={waveformPointerUp} /></div>
          <div className="waveform-controls waveform-controls-detailed"><div className="waveform-hint">{tr('拖曳白色 Start / End 手柄；拖曳黃色 Fade 手柄調整長度；滑鼠移到 Fade 曲線上會變成上下指標，可直接編輯曲線。')}</div><div className="wave-edit-grid"><label className="detail-control"><span>START (ms)</span><input type="number" min="0" max={(waveBuffer?.duration||0)*1000} step="0.1" value={(waveEdits.start*(waveBuffer?.duration||0)*1000).toFixed(1)} onChange={e=>{const d=waveBuffer?.duration||0;setWaveEdits(x=>({...x,start:clamp(Number(e.target.value)/1000/Math.max(d,.001),0,x.end-.0001)}));waveEditDirtyRef.current=true}}/></label><label className="detail-control"><span>END (ms)</span><input type="number" min="0" max={(waveBuffer?.duration||0)*1000} step="0.1" value={(waveEdits.end*(waveBuffer?.duration||0)*1000).toFixed(1)} onChange={e=>{const d=waveBuffer?.duration||0;setWaveEdits(x=>({...x,end:clamp(Number(e.target.value)/1000/Math.max(d,.001),x.start+.0001,1)}));waveEditDirtyRef.current=true}}/></label><label className="detail-control"><span>FADE IN (ms)</span><input type="number" min="0" max={(waveBuffer?.duration||0)*1000} step="0.1" value={(waveEdits.fadeIn*1000).toFixed(1)} onChange={e=>{setWaveEdits(x=>({...x,fadeIn:Math.max(0,Number(e.target.value)/1000)}));waveEditDirtyRef.current=true}}/></label><label className="detail-control"><span>FADE OUT (ms)</span><input type="number" min="0" max={(waveBuffer?.duration||0)*1000} step="0.1" value={(waveEdits.fadeOut*1000).toFixed(1)} onChange={e=>{setWaveEdits(x=>({...x,fadeOut:Math.max(0,Number(e.target.value)/1000)}));waveEditDirtyRef.current=true}}/></label><label className="detail-control"><span>PITCH</span><input type="number" min="-24" max="24" step="0.1" value={waveEdits.pitch} onChange={e=>{setWaveEdits(x=>({...x,pitch:Number(e.target.value)}));waveEditDirtyRef.current=true}}/></label><label className="detail-control"><span>FADE IN CURVE</span><input type="range" min="0.05" max="0.95" step="0.01" value={waveEdits.fadeInCurve} onChange={e=>{setWaveEdits(x=>({...x,fadeInCurve:Number(e.target.value)}));waveEditDirtyRef.current=true}}/><output>{waveEdits.fadeInCurve.toFixed(2)}</output></label><label className="detail-control"><span>FADE OUT CURVE</span><input type="range" min="0.05" max="0.95" step="0.01" value={waveEdits.fadeOutCurve} onChange={e=>{setWaveEdits(x=>({...x,fadeOutCurve:Number(e.target.value)}));waveEditDirtyRef.current=true}}/><output>{waveEdits.fadeOutCurve.toFixed(2)}</output></label><label className="detail-control check"><span>{t('reverse')}</span><input type="checkbox" checked={!!waveEdits.reverse} onChange={e=>{setWaveEdits(x=>({...x,reverse:e.target.checked}));waveEditDirtyRef.current=true}}/></label><label className="detail-control check"><span>NORMALIZE</span><input type="checkbox" checked={waveEdits.normalize} onChange={e=>{setWaveEdits(x=>({...x,normalize:e.target.checked}));waveEditDirtyRef.current=true}}/></label><label className="detail-control"><span>ZOOM</span><input type="range" min="1" max="8" step="1" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/><output>{zoom}×</output></label></div></div>
        </section>

        <section className="inspector"><PadInspector pad={pad} onChange={updatePad} preview={()=>void previewPad()} t={t} /></section>
      </>}</main>

      <aside className="browser-panel"><section className="wave-browser"><div className="wave-browser-head"><div className="wave-browser-title-row"><div><div className="eyebrow">{t('waveBrowser')}</div><div className="wave-browser-title">{t('sample')} <span>{filteredWaves.length}/{project.waves.length}</span></div></div><div className="wave-browser-actions"><button className="btn mini" disabled={!project.rootPath} onClick={()=>void addWaveSample()}>＋ {t('sample')}</button><button className="btn mini" disabled={!project.rootPath} onClick={()=>void addWaveCategory()}>＋ {t('category')}</button></div></div><input className="search wave-search" placeholder={t('search')+' Wave / ID / Path...'} value={waveSearch} onChange={e=>setWaveSearch(e.target.value)}/><div className="wave-tabs">{waveTags.map(tag=><button key={tag} className={`wave-tab ${waveTag===tag?'active':''}`} onClick={()=>setWaveTag(tag)}>{tag==='ALL'?t('all'):tag}</button>)}</div></div><div className="wave-browser-list">{filteredWaves.map(w=><div key={w.id} className={`wave-row ${pad?.waveId===w.id?'assigned':''}`} draggable={w.exists} onDragStart={e=>handleWaveDragStart(e,w)} onDoubleClick={()=>void assignWave(w)} onClick={()=>void previewWave(w)}><div className="wave-id">{String(w.id).padStart(3,'0')}</div><div className="wave-name"><strong>{w.name||'(Unnamed)'}</strong><small>{w.path}</small></div><div className="wave-tag-label">{w.tagName||'—'}</div><div className="wave-row-actions"><div className={`wave-file ${w.exists?'ok':'missing'}`}>{w.exists?'WAV':'MISS'}</div><button className="wave-delete" title={tr('刪除 Sample')} onClick={e=>{e.stopPropagation();void deleteWave(w)}}>×</button></div></div>)}</div><div className="wave-browser-foot">{tr('點擊預覽 · 拖曳到 PAD · 雙擊指派 · × 刪除')}</div></section></aside>
      </>}
    </div>
    <footer className="statusbar"><span>{status}</span><span>{device.mode === 'WAVE_MGR' ? `● SPD-SX EDITOR ${syncing ? '· SYNCING' : autoSync ? '· AUTO SYNC' : '· CONNECTED'}` : device.mode === 'AUDIO_MIDI' ? '● SPD-SX · SPD PAD · MIDI' : device.mode === 'UNKNOWN' ? '○ SPD-SX UNKNOWN' : '○ SPD-SX OFFLINE'} · {project.warnings.length?`⚠ ${project.warnings.length} warnings`:'✓ Ready'}</span></footer>
  </div>
}


function EditorPadPage(props:{
  kit:KitModel|undefined; kits:KitModel[]; selectedKit:number; onSelectKit:(index:number)=>void; waves:WaveModel[]; tags:{index:number;name:string;order:number}[]; selectedPad:number; setSelectedPad:(n:number)=>void; selectedLayer:'main'|'sub'; setSelectedLayer:(v:'main'|'sub')=>void;
  midiLearnPad:number|null; onLearn:(n:number)=>void; midiConnected:boolean; hitVisual:{index:number;intensity:number;token:number}|null;
  selectedFile?:AudioFileInfo; onSelectFile:(file:AudioFileInfo|undefined,preview?:boolean)=>void; onPreviewWave:(wave:WaveModel)=>Promise<void>; onAssign:(file:AudioFileInfo,index:number,layer:'main'|'sub')=>Promise<void>; onPlay:(index:number)=>Promise<void>; onPlayLayer:(index:number,layer:'main'|'sub')=>Promise<void>;
  editedBuffer?:AudioBuffer; editedSettings?:WaveformEditState; onEditedBuffer:(key:string,buffer:AudioBuffer,settings:{reverse:boolean;edits:WaveformEditState})=>void; t:(key:string)=>string; musicVolume:number;
  onMixChange:(index:number,layer:'main'|'sub',patch:Partial<PadLayer>)=>void; onClearLayer:(index:number,layer:'main'|'sub')=>void; onClearPad:(index:number)=>void;
  onAddSamples:(sources:string[],tagIndex:number)=>Promise<void>; onAddCategory:()=>Promise<void>; onResetPads:()=>void;
  kitPresets:SpdKitPreset[]; kitLibraryOpen:boolean; setKitLibraryOpen:(v:boolean)=>void; onSaveKit:(mode:'overwrite'|'new',name?:string)=>void; onSaveCurrentKit:()=>Promise<void>; onEnsureKitSlot:(slot:number)=>Promise<void>; onRenameKit:(slot:number,name:string)=>Promise<void>; onCopyKit:(source:number,target:number)=>Promise<void>; onDeleteKit:(slot:number)=>Promise<void>;
  waveSearch:string; setWaveSearch:(v:string)=>void; waveTag:string; setWaveTag:(v:string)=>void;
}):JSX.Element {
  const [browserIndex,setBrowserIndex]=useState<number>(-1)
  const [sampleModal,setSampleModal]=useState(false)
  const [pendingFiles,setPendingFiles]=useState<string[]>([])
  const [tagIndex,setTagIndex]=useState<number>(props.tags[0]?.index ?? 0)
  const [menu,setMenu]=useState<{x:number;y:number;file:AudioFileInfo;layer:'main'|'sub'|null;submenuX:number;submenuY:number}|null>(null)
  const [padMenu,setPadMenu]=useState<{x:number;y:number;pad:number}|null>(null)
  const [kitMenu,setKitMenu]=useState<{x:number;y:number;slot:number}|null>(null)
  const [kitModal,setKitModal]=useState<{type:'rename'|'copy'|'delete'|'saved'|'copied'|'deleted';slot:number;name?:string;target?:number;message?:string}|null>(null)
  const [kitPage,setKitPage]=useState(1)
  const fileInfo=(w?:WaveModel|null):AudioFileInfo|undefined=>w?.dataPath?{name:w.name||`Wave ${w.id}`,path:w.dataPath,size:w.sizeBytes||0,extension:(w.dataPath.split('.').pop()||'').toLowerCase()}:undefined
  const assignedFile=(i:number,layer:'main'|'sub')=>fileInfo(props.waves.find(w=>w.id===(layer==='main'?props.kit?.pads[i]?.waveId:props.kit?.pads[i]?.subWaveId)) as WaveModel)
  const files=useMemo(()=>props.waves.map(w=>fileInfo(w)).filter(Boolean) as AudioFileInfo[],[props.waves])
  const q=props.waveSearch.toLowerCase().replace(/\s+/g,'')
  const categoryNames=['ALL',...props.tags.map(t=>t.name)]
  const filtered=props.waves.filter(w=>{const name=(w.name||'').toLowerCase().replace(/\s+/g,'');const path=(w.path||'').toLowerCase().replace(/\s+/g,'');return (!q||name.includes(q)||path.includes(q))&&(props.waveTag==='ALL'||(w.tagName||'').toLowerCase()===props.waveTag.toLowerCase())})
  const previewEditorWave=(w:WaveModel)=>{void props.onPreviewWave(w)}
  useEffect(()=>{if(browserIndex>=0&&filtered[browserIndex])props.onSelectFile(fileInfo(filtered[browserIndex]),false)},[browserIndex,filtered.length])
  useEffect(()=>{if(props.waveTag!=='ALL'&&!props.tags.some(t=>t.name===props.waveTag))props.setWaveTag('ALL')},[props.tags])
  useEffect(()=>{const onKey=(e:KeyboardEvent)=>{const target=e.target as HTMLElement|null;if(target&&['INPUT','TEXTAREA','SELECT'].includes(target.tagName))return;if(!filtered.length)return;const current=props.selectedFile?.path?filtered.findIndex(w=>fileInfo(w)?.path===props.selectedFile?.path):-1;if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const next=current<0?(e.key==='ArrowDown'?0:filtered.length-1):clamp(current+(e.key==='ArrowDown'?1:-1),0,filtered.length-1);const f=filtered[next];if(f){setBrowserIndex(next);const info=fileInfo(f);props.onSelectFile(info,false);previewEditorWave(f)}}else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();const ci=Math.max(0,categoryNames.findIndex(v=>v===props.waveTag));const ni=clamp(ci+(e.key==='ArrowRight'?1:-1),0,categoryNames.length-1);props.setWaveTag(categoryNames[ni]||'ALL');setBrowserIndex(-1);props.onSelectFile(undefined,false)}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)},[filtered,props.selectedFile?.path,props.waveTag,props.tags])
  const addPickedFiles=(list:FileList|null)=>{if(!list)return;const paths=Array.from(list).map((f:any)=>f.path).filter(Boolean);setPendingFiles(prev=>Array.from(new Set([...prev,...paths])))}
  const confirmSamples=async()=>{if(!pendingFiles.length)return;await props.onAddSamples(pendingFiles,tagIndex);setPendingFiles([]);setSampleModal(false)}
  const clearMenus=()=>{setMenu(null);setPadMenu(null)}
  const openEditorSourceMenu=(e:React.MouseEvent,file:AudioFileInfo)=>{e.preventDefault();e.stopPropagation();const menuW=190,subW=150,h=120;const left=Math.max(8,Math.min(e.clientX,window.innerWidth-menuW-8));const top=Math.max(8,Math.min(e.clientY,window.innerHeight-h-8));const submenuX=e.clientX+menuW+8+subW<window.innerWidth?left+menuW+6:Math.max(8,left-subW-6);const submenuY=Math.max(8,Math.min(e.clientY,window.innerHeight-320));setPadMenu(null);setMenu({x:left,y:top,file,layer:null,submenuX,submenuY})}
  useEffect(()=>{const fn=()=>{clearMenus();setKitMenu(null);};window.addEventListener('click',fn);return()=>window.removeEventListener('click',fn)},[])
  return <main className="spd-pad-page editor-pad-page">
    <section className="spd-pad-head"><div><div className="eyebrow">EDITOR</div><div className="spd-pad-compact-title">{props.midiConnected?props.t('midiReady'):'WAVE MGR · SPD-SX Editor'}</div></div><div className="spd-pad-head-controls"><button className="btn mini" onClick={()=>{setPendingFiles([]);setSampleModal(true)}}>＋ Add Sample</button><button className="btn mini" onClick={()=>void props.onSaveCurrentKit()}>{tr('💾 儲存 Kit')}</button><button className="btn mini" onClick={()=>props.setKitLibraryOpen(!props.kitLibraryOpen)}>{tr('▣ Kit 資料庫')}</button><button className="btn mini" onClick={()=>props.onResetPads()}>↺ {props.t('resetPad')}</button><div className={`instrument-status ${props.midiConnected?'mode-pad':'mode-offline'}`}><span className={`device-dot ${props.midiConnected?'online':'offline'}`}></span>{props.midiConnected?props.t('midiReady'):'WAVE MGR'}</div></div></section>
    <section className="sx-layout">
      <div className="sx-left">
        <div className="sx-pads">
          {Array.from({length:10},(_,i)=>{const p=props.kit?.pads[i];const mainW=props.waves.find(w=>w.id===p?.waveId);const subW=props.waves.find(w=>w.id===p?.subWaveId);const label=i===9?'KICK':`PAD ${i+1}`
            return <PadCard key={i} label={label} active={props.selectedPad===i} activeLayer={props.selectedLayer} learning={props.midiLearnPad===i} hit={props.hitVisual?.index===i} intensity={props.hitVisual?.index===i?props.hitVisual.intensity:0}
              main={{name:mainW?.name,volume:p?.waveLevel??100,pan:Math.round(((p?.wavePan??15)-15)/15*100)}} sub={{name:subW?.name,volume:p?.subWaveLevel??100,pan:Math.round(((p?.subWavePan??15)-15)/15*100)}}
              learnLabel={props.t('learn')} mainLabel="MAIN" subLabel="SUB"
              onPad={()=>{props.setSelectedPad(i);props.setSelectedLayer('main');void props.onPlay(i)}}
              onLayer={layer=>{props.setSelectedPad(i);props.setSelectedLayer(layer);props.onSelectFile(fileInfo((layer==='main'?mainW:subW) as WaveModel),false);void props.onPlayLayer(i,layer)}}
              onDropLayer={(layer,path)=>{const file=files.find(f=>f.path===path);if(file)void props.onAssign(file,i,layer)}}
              onContext={e=>{e.preventDefault();e.stopPropagation();setMenu(null);setPadMenu({x:e.clientX,y:e.clientY,pad:i})}}
              onLearn={()=>props.onLearn(i)}/>})}
        </div>
        <ComputerWaveEditor padIndex={props.selectedPad} layer={props.selectedLayer} mainFile={assignedFile(props.selectedPad,'main')} subFile={assignedFile(props.selectedPad,'sub')} mainMix={{volume:props.kit?.pads[props.selectedPad]?.waveLevel??100,pan:((props.kit?.pads[props.selectedPad]?.wavePan??15)-15)/15*100}} subMix={{volume:props.kit?.pads[props.selectedPad]?.subWaveLevel??100,pan:((props.kit?.pads[props.selectedPad]?.subWavePan??15)-15)/15*100}} onLayerChange={v=>props.setSelectedLayer(v)} file={assignedFile(props.selectedPad,props.selectedLayer)} editedBuffer={props.editedBuffer} editedSettings={props.editedSettings} t={props.t} musicVolume={props.musicVolume} onEditedBuffer={props.onEditedBuffer} onMixChange={(layer,patch)=>props.onMixChange(props.selectedPad,layer,patch)}/>
      </div>
      <aside className="spd-source-panel editor-wave-browser">
        <div className="spd-source-head"><div className="spd-source-head-info"><div className="instrument-card-title">WAVE BROWSER</div><div className="source-path-marquee"><span>{props.kit?.name||'SPD-SX WAVE'}</span></div></div><div className="sx-head-actions"><HelpTip lines={[tr('點擊音檔：選取並預覽'),tr('拖曳音檔到 PAD 的 MAIN / SUB：指派音源'),tr('在音檔上按右鍵：快速指定 MAIN / SUB → PAD')]}/><button className="btn mini" onClick={()=>setSampleModal(true)}>＋ Add Sample</button></div></div>
        <div className={`spd-source-tabs ${props.waveSearch?'locked':''}`}><button className={`spd-source-tab ${props.waveTag==='ALL'?'active':''}`} disabled={!!props.waveSearch} onClick={()=>{props.setWaveTag('ALL');setBrowserIndex(-1);props.onSelectFile(undefined,false)}}>ALL</button>{props.tags.map(tag=><button key={tag.index} className={`spd-source-tab ${props.waveTag===tag.name?'active':''}`} disabled={!!props.waveSearch} onClick={()=>{props.setWaveTag(tag.name);setBrowserIndex(-1);props.onSelectFile(undefined,false)}}>{tag.name}</button>)}</div>
        <div className="spd-source-search-block"><div className="spd-source-search-row"><input className="search" value={props.waveSearch} onChange={e=>{props.setWaveSearch(e.target.value);setBrowserIndex(-1)}} placeholder={tr('搜尋 Wave / ID / Path...')}/><button className="btn mini" disabled={!props.waveSearch&&props.waveTag==='ALL'} onClick={()=>{props.setWaveSearch('');props.setWaveTag('ALL');setBrowserIndex(-1);props.onSelectFile(undefined,false)}}>{tr('清除')}</button></div></div>
        <div className="spd-file-list editor-wave-list">{filtered.length===0?<div className="midi-empty">{tr('沒有符合條件的 Wave')}</div>:filtered.map((w,i)=>{const f=fileInfo(w);return <button type="button" key={w.id} draggable={!!f} className={`spd-file-row ${props.selectedFile?.path===f?.path?'selected assigned':''}`} onDragStart={e=>{if(f){e.dataTransfer.setData('application/x-spd-audio',f.path);e.dataTransfer.effectAllowed='copy'}}} onContextMenu={e=>{if(f)openEditorSourceMenu(e,f)}} onClick={()=>{if(f){setBrowserIndex(i);props.onSelectFile(f,false);void props.onPreviewWave(w)}}}><span>{String(w.id).padStart(3,'0')} · {w.name||'(Unnamed)'}</span><small>{w.tagName||'—'} · {w.exists?'WAV':'MISS'}</small></button>})}</div>
      </aside>
    </section>

    {menu&&<ContextMenu x={menu.x} y={menu.y} title={menu.file.name} onClose={clearMenus} items={(['main','sub'] as const).map(layer=>({label:layer.toUpperCase(),sub:Array.from({length:10},(_,i)=>({label:i===9?'KICK':`PAD ${i+1}`,onSelect:()=>{void props.onAssign(menu.file,i,layer)}}))}))}/>}
    {padMenu&&<ContextMenu x={padMenu.x} y={padMenu.y} title={padMenu.pad===9?'KICK':`PAD ${padMenu.pad+1}`} onClose={clearMenus} items={[{label:tr('清除 MAIN'),onSelect:()=>props.onClearLayer(padMenu.pad,'main')},{label:tr('清除 SUB'),onSelect:()=>props.onClearLayer(padMenu.pad,'sub')},{divider:true},{label:tr('清除全部'),danger:true,onSelect:()=>props.onClearPad(padMenu.pad)}]}/>}

    {kitMenu&&<ContextMenu x={kitMenu.x} y={kitMenu.y} title={`KIT ${String(kitMenu.slot).padStart(3,'0')}`} onClose={()=>setKitMenu(null)} items={[{label:tr('重新命名'),onSelect:()=>{const found=props.kits.find(k=>k.slot===kitMenu.slot);setKitModal({type:'rename',slot:kitMenu.slot,name:found?.name||`Kit ${String(kitMenu.slot).padStart(3,'0')}`})}},{label:tr('複製 Kit'),onSelect:()=>setKitModal({type:'copy',slot:kitMenu.slot})},{divider:true},{label:tr('刪除 Kit'),danger:true,onSelect:()=>setKitModal({type:'delete',slot:kitMenu.slot})}]}/>}
    {kitModal&&<div className="kit-save-modal-backdrop" onClick={()=>setKitModal(null)}><div className="kit-save-modal" onClick={e=>e.stopPropagation()}>{kitModal.type==='rename'&&<><div className="eyebrow">RENAME KIT</div><h2>{tr('重新命名')}</h2><input className="kit-save-name" value={kitModal.name||''} onChange={e=>setKitModal(m=>m?{...m,name:e.target.value}:m)} autoFocus/><div className="kit-save-actions"><button className="btn primary" disabled={!kitModal.name?.trim()} onClick={()=>{void props.onRenameKit(kitModal.slot,kitModal.name!.trim());setKitModal(null)}}>{tr('確定（同步）')}</button><button className="btn mini" onClick={()=>setKitModal(null)}>{tr('取消')}</button></div></>} {kitModal.type==='copy'&&<><div className="eyebrow">COPY KIT</div><h2>{tr('複製到哪一個 Kit？')}</h2><select className="kit-copy-target" value={kitModal.target??''} onChange={e=>setKitModal(m=>m?{...m,target:Number(e.target.value)}:m)}><option value="">{tr('請選擇 000–099')}</option>{Array.from({length:100},(_,i)=>{const existing=props.kits.some(k=>k.slot===i);return <option key={i} value={i}>{String(i).padStart(3,'0')} · {existing?(props.kits.find(k=>k.slot===i)?.name||tr('已使用')):tr('(空白 Kit)')}</option>})}</select><div className="kit-save-actions"><button className="btn primary" disabled={kitModal.target===undefined} onClick={()=>{const exists=props.kits.some(k=>k.slot===kitModal.target);if(exists){setKitModal(m=>m?{...m,type:'copy'}:m);if(window.confirm(tr('KIT {0} 已有內容，是否覆蓋？',String(kitModal.target).padStart(3,'0')))){void props.onCopyKit(kitModal.slot,kitModal.target!);setKitModal({type:'copied',slot:kitModal.target!,message:tr('已儲存並同步到 SPD-SX')})}}else{void props.onCopyKit(kitModal.slot,kitModal.target!);setKitModal({type:'copied',slot:kitModal.target!,message:tr('已儲存並同步到 SPD-SX')})}}}>{tr('確認')}</button><button className="btn mini" onClick={()=>setKitModal(null)}>{tr('取消')}</button></div></>} {kitModal.type==='delete'&&<><div className="eyebrow">DELETE KIT</div><h2>{tr('確定刪除 KIT {0}？',String(kitModal.slot).padStart(3,'0'))}</h2><div className="kit-save-actions"><button className="btn primary" onClick={()=>{void props.onDeleteKit(kitModal.slot);setKitModal({type:'deleted',slot:kitModal.slot,message:tr('已刪除並同步到 SPD-SX')})}}>{tr('是')}</button><button className="btn mini" onClick={()=>setKitModal(null)}>{tr('否')}</button></div></>} {(kitModal.type==='copied'||kitModal.type==='deleted')&&<><div className="eyebrow">DONE</div><h2>{kitModal.message}</h2><p>{tr('點擊空白處關閉。')}</p></>}</div></div>}
    {sampleModal&&<EditorSampleModal tags={props.tags} initialTag={tagIndex} onClose={()=>setSampleModal(false)} onConfirm={async(paths,tag)=>{setTagIndex(tag);await confirmSamplesWith(paths,tag)}} onAddCategory={props.onAddCategory} />}
    {props.kitLibraryOpen&&<><div className="spd-kit-backdrop" onClick={()=>props.setKitLibraryOpen(false)}></div><aside className="spd-kit-drawer editor-hardware-kit-drawer"><div className="spd-kit-drawer-head"><div><div className="eyebrow">KIT DATABASE</div><strong>SPD-SX Kits</strong></div><button className="btn mini" onClick={()=>props.setKitLibraryOpen(false)}>×</button></div><div className="spd-kit-list hardware-kit-list">{Array.from({length:10},(_,offset)=>{const slot=(kitPage-1)*10+offset;const found=props.kits.find(k=>k.slot===slot);const foundIndex=found?props.kits.findIndex(k=>k.slot===slot):-1;return <button key={slot} className={`spd-kit-load hardware-kit-item ${foundIndex===props.selectedKit?'active':''} ${found?'':'empty'}`} onClick={()=>{void props.onEnsureKitSlot(slot);setBrowserIndex(-1)}} onContextMenu={e=>{e.preventDefault();e.stopPropagation();setKitMenu({x:e.clientX,y:e.clientY,slot})}}><span className="hardware-kit-slot">{String(slot).padStart(3,'0')}</span><span className="hardware-kit-name">{found?.name||tr('(空白 Kit)')}</span><small>{found?'SPD':tr('空白')}</small></button>})}</div><div className="kit-db-pagination"><button className="btn mini" disabled={kitPage<=1} onClick={()=>setKitPage(1)}>⏮</button><button className="btn mini" disabled={kitPage<=1} onClick={()=>setKitPage(p=>Math.max(1,p-1))}>◀</button><span>{kitPage} / 10</span><button className="btn mini" disabled={kitPage>=10} onClick={()=>setKitPage(p=>Math.min(10,p+1))}>▶</button><button className="btn mini" disabled={kitPage>=10} onClick={()=>setKitPage(10)}>⏭</button></div></aside></>}
  </main>
  async function confirmSamplesWith(paths:string[],tag:number){await props.onAddSamples(paths,tag);setPendingFiles([]);setSampleModal(false)}
}

function EditorSampleModal(props:{tags:{index:number;name:string;order:number}[];initialTag:number;onClose:()=>void;onConfirm:(paths:string[],tag:number)=>Promise<void>;onAddCategory:()=>Promise<void>}){
  const inputRef=useRef<HTMLInputElement|null>(null); const [files,setFiles]=useState<string[]>([]); const [tag,setTag]=useState(props.initialTag)
  const add=(list:FileList|null)=>{if(!list)return;const paths=Array.from(list).map((f:any)=>f.path).filter(Boolean);setFiles(prev=>Array.from(new Set([...prev,...paths])))}
  return <div className="kit-save-modal-backdrop"><div className="kit-save-modal editor-sample-modal" onClick={e=>e.stopPropagation()}><div className="eyebrow">WAVE BROWSER</div><h2>Add Sample</h2><p>{tr('可一次選擇多個 WAV，或直接把檔案拖進此區域。')}</p><input ref={inputRef} type="file" multiple accept="audio/wav,.wav,.wave" hidden onChange={e=>add(e.target.files)}/><div className="editor-sample-drop" onDragOver={e=>{e.preventDefault()}} onDrop={e=>{e.preventDefault();add(e.dataTransfer.files)}} onClick={()=>inputRef.current?.click()}>{files.length?files.map(f=><div key={f}>{f.split('/').pop()}</div>):tr('瀏覽 / 拖曳 WAV 檔案至此')}</div><label className="settings-row"><span>{tr('分類')}</span><select value={tag} onChange={e=>setTag(Number(e.target.value))}>{props.tags.length?props.tags.map(t=><option key={t.index} value={t.index}>{t.name}</option>):<option value={0}>Default</option>}</select></label><div className="kit-save-actions"><button className="btn secondary" onClick={()=>void props.onAddCategory()}>{tr('＋ 新增分類')}</button><button className="btn primary" disabled={!files.length} onClick={()=>void props.onConfirm(files,tag)}>{tr('確定（同步）')}</button><button className="btn mini" onClick={props.onClose}>{tr('取消')}</button></div></div></div>
}

function SpdPadPage(props:{onFxChange:(index:number,layer:'main'|'sub',slots:FxSlot[])=>void;assignments:SpdPadAssignment[];selectedPad:number;setSelectedPad:(n:number)=>void;selectedLayer:'main'|'sub';setSelectedLayer:(v:'main'|'sub')=>void;midiLearnPad:number|null;setMidiLearnPad:(n:number|null)=>void;onLearn:(n:number)=>void;midiConnected:boolean;sources:AudioSourceTab[];activeSource:AudioSourceTab|undefined;files:AudioFileInfo[];allFiles:AudioFileInfo[];busy:boolean;onSourceChange:(id:string)=>void;onAddSource:()=>Promise<void>;onAssign:(file:AudioFileInfo,index:number,layer:'main'|'sub')=>Promise<void>;onSelectFile:(file:AudioFileInfo|undefined,preview?:boolean)=>void;onPlay:(index:number,forceOneShot?:boolean)=>Promise<void>;onPlayLayer:(index:number,layer:'main'|'sub',forceOneShot?:boolean)=>Promise<void>;noteFor:(index:number)=>number;selectedFile?:AudioFileInfo;editedBuffer?:AudioBuffer;editedSettings?:WaveformEditState;t:(key:string)=>string;musicVolume:number;onEditedBuffer:(key:string,buffer:AudioBuffer,settings:{reverse:boolean;edits:WaveformEditState})=>void;onResetPads:()=>void;hitVisual:{index:number;intensity:number;token:number}|null;onMixChange:(index:number,layer:'main'|'sub',patch:Partial<PadLayer>)=>void;onClearLayer:(index:number,layer:'main'|'sub')=>void;onClearPad:(index:number)=>void;kitPresets:SpdKitPreset[];kitLibraryOpen:boolean;setKitLibraryOpen:(v:boolean)=>void;onSaveKit:(mode:'overwrite'|'new',name?:string)=>void;onLoadKit:(p:SpdKitPreset)=>void;onDeleteKit:(id:string)=>void}):JSX.Element {
  const labels=[...Array(9)].map((_,i)=>`${props.t('pad')} ${i+1}`).concat(props.t('kick'))
  const selected=props.assignments[props.selectedPad]
  const [sourceMenu,setSourceMenu]=useState<{x:number;y:number;file:AudioFileInfo;layer:'main'|'sub'|null;submenuX:number;submenuY:number}>({x:0,y:0,file:{name:'',path:'',size:0,extension:''},layer:null,submenuX:0,submenuY:0})
  const [sourceMenuOpen,setSourceMenuOpen]=useState(false)
  const [padMenu,setPadMenu]=useState<{x:number;y:number;pad:number}|null>(null)
  const [padMenuLayer,setPadMenuLayer]=useState<'main'|'sub'>('main')
  const [saveStep,setSaveStep]=useState<'closed'|'choose'|'overwrite'|'new'>('closed')
  useEffect(()=>{const fn=()=>setSaveStep('choose');window.addEventListener('core-sx-request-save-kit',fn);return()=>window.removeEventListener('core-sx-request-save-kit',fn)},[])
  const [saveName,setSaveName]=useState('')
  const [sourceSearch,setSourceSearch]=useState('')
  const [sourceTag,setSourceTag]=useState<string>('ALL')
  const [sourceTagMenuOpen,setSourceTagMenuOpen]=useState(false)
  const systemTags=['BD','Bass Drum','Kick','Snare','Tom','Tom1','Tom2','Tom3','Tom4','Floor Tom','Cymbel','Crash','Splash','China','Cow Bell','Stack','FX']
  const [customTags,setCustomTags]=useState<string[]>(()=>readStoredJson<string[]>('core-sx-audio-tags',[]).filter(Boolean))
  const [hiddenSystemTags,setHiddenSystemTags]=useState<string[]>(()=>readStoredJson<string[]>('core-sx-hidden-audio-tags',[]).filter(Boolean))
  const tagKey=(value:string)=>value.toLowerCase().replace(/\s+/g,'')
  const quickTags=[...systemTags.filter(t=>!hiddenSystemTags.some(h=>tagKey(h)===tagKey(t))),...customTags.filter(t=>!systemTags.some(s=>tagKey(s)===tagKey(t)))]
  const [newTag,setNewTag]=useState('')
  function addCustomTag(){const tag=newTag.trim();if(!tag)return;const exists=quickTags.some(t=>normalizeSearch(t)===normalizeSearch(tag));if(!exists){setCustomTags(prev=>[...prev,tag])};setNewTag('')}
  function deleteCustomTag(tag:string){if(systemTags.some(s=>tagKey(s)===tagKey(tag))){setHiddenSystemTags(prev=>prev.includes(tag)?prev:[...prev,tag])}else{setCustomTags(prev=>prev.filter(t=>t!==tag))}if(sourceTag===tag)setSourceTag('ALL')}

  useEffect(()=>{localStorage.setItem('core-sx-audio-tags',JSON.stringify(customTags))},[customTags])
  useEffect(()=>{localStorage.setItem('core-sx-hidden-audio-tags',JSON.stringify(hiddenSystemTags))},[hiddenSystemTags])
  useEffect(()=>{const fn=()=>{setCustomTags([]);setHiddenSystemTags([]);setSourceTag('ALL');setNewTag('')};window.addEventListener('core-sx-reset-tags',fn);return()=>window.removeEventListener('core-sx-reset-tags',fn)},[])
  function closeMenus(){setSourceMenuOpen(false);setPadMenu(null)}
  useEffect(()=>{const fn=()=>closeMenus();window.addEventListener('click',fn);return()=>window.removeEventListener('click',fn)},[])
  useEffect(()=>{const handler=(e:KeyboardEvent)=>{const target=e.target as HTMLElement|null;if(target && ['INPUT','SELECT','TEXTAREA'].includes(target.tagName))return;const locked=!!sourceSearch||sourceTag!=='ALL';const pool=locked&&props.allFiles.length?props.allFiles:props.files;if(!pool.length)return;const idx=props.selectedFile?Math.max(0,pool.findIndex(f=>f.path===props.selectedFile?.path)):-1;if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();const next=clamp(idx+(e.key==='ArrowDown'?1:idx<=0?0:-1),0,pool.length-1);props.onSelectFile(pool[next])}else if((e.key==='ArrowLeft'||e.key==='ArrowRight')&&!locked){e.preventDefault();const srcIndex=Math.max(0,props.sources.findIndex(s=>s.id===props.activeSource?.id));const nextIndex=clamp(srcIndex+(e.key==='ArrowRight'?1:-1),0,props.sources.length-1);const next=props.sources[nextIndex];if(next&&next.id!==props.activeSource?.id)props.onSourceChange(next.id)}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler)},[props.files,props.allFiles,props.selectedFile?.path,props.sources,props.activeSource?.id,sourceSearch,sourceTag])
  useEffect(()=>{requestAnimationFrame(()=>{document.querySelector('.spd-source-tab.active')?.scrollIntoView({inline:'nearest',block:'nearest'});document.querySelector('.spd-file-row.selected')?.scrollIntoView({block:'nearest'})})},[props.activeSource?.id,props.selectedFile?.path,sourceSearch,sourceTag])
  // Do not auto-select or autoplay the first file when a library/category opens.
  function handleSourceContext(e:React.MouseEvent,file:AudioFileInfo){e.preventDefault();e.stopPropagation();setPadMenu(null);const menuW=190,subW=150,h=120;const left=Math.max(8,Math.min(e.clientX,window.innerWidth-menuW-8));const top=Math.max(8,Math.min(e.clientY,window.innerHeight-h-8));const submenuX=e.clientX+menuW+8+subW<window.innerWidth?left+menuW+6:Math.max(8,left-subW-6);const submenuY=Math.max(8,Math.min(e.clientY,window.innerHeight-320));setSourceMenu({x:left,y:top,file,layer:null,submenuX,submenuY});setSourceMenuOpen(true)}
  function handlePadContext(e:React.MouseEvent,pad:number){e.preventDefault();e.stopPropagation();setSourceMenuOpen(false);setPadMenu({x:e.clientX,y:e.clientY,pad});setPadMenuLayer('main')}
  const assignFromMenu=(layer:'main'|'sub',index:number)=>{void props.onAssign(sourceMenu.file,index,layer);setSelectedForContext(index,layer);closeMenus()}
  const setSelectedForContext=(index:number,layer:'main'|'sub')=>{props.setSelectedPad(index);props.setSelectedLayer(layer)}
  const padNames=['PAD1','PAD2','PAD3','PAD4','PAD5','PAD6','PAD7','PAD8','PAD9','PAD10']
  const normalizeSearch=(value:string)=>value.toLowerCase().replace(/\s+/g,'')
  const [durationMap,setDurationMap]=useState<Record<string,number>>({})
  useEffect(()=>{
    let cancelled=false
    const missing=(sourceSearch||sourceTag!=='ALL'?props.allFiles:props.files).filter(f=>durationMap[f.path]==null).slice(0,80)
    if(!missing.length)return
    void (async()=>{
      const ctx=new AudioContext()
      const updates:Record<string,number>={}
      try{for(const file of missing){if(cancelled)break;try{const bytes=await window.spd.sound.readFile(file.path);if(!bytes)continue;const decoded=await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer);updates[file.path]=decoded.duration}catch{}}
      }finally{try{await ctx.close()}catch{}}
      if(!cancelled&&Object.keys(updates).length)setDurationMap(prev=>({...prev,...updates}))
    })()
    return()=>{cancelled=true}
  },[props.files, props.allFiles, durationMap, sourceSearch, sourceTag])
  const browserPool=(sourceSearch||sourceTag!=='ALL')&&props.allFiles.length?props.allFiles:props.files
  const searchableFiles=browserPool.filter(file=>{
    const hay=normalizeSearch(`${file.name} ${file.path}`)
    const q=normalizeSearch(sourceSearch)
    const tagOk=sourceTag==='ALL' ? true : hay.includes(normalizeSearch(sourceTag))
    return (!q || hay.includes(q)) && tagOk
  })
  const selectAssignedLayer=(index:number,layer:'main'|'sub')=>{
    props.setSelectedPad(index); props.setSelectedLayer(layer)
    const path=layer==='main'?props.assignments[index]?.main?.filePath:props.assignments[index]?.sub?.filePath
    if(path){const found=props.files.find(f=>f.path===path);props.onSelectFile(found||{name:layer==='main'?props.assignments[index]?.main?.fileName||'Main':props.assignments[index]?.sub?.fileName||'Sub',path,size:0,extension:path.split('.').pop()?.toLowerCase()||''},false)}
    else props.onSelectFile(undefined,false)
  }

  return <main className="spd-pad-page">
    <section className="spd-pad-head">
      <div><div className="eyebrow">SPD PAD</div><div className="spd-pad-compact-title">{props.midiConnected?props.t('midiReady'):props.t('waitingMidi')}</div></div>
      <div className="spd-pad-head-controls">
        <OutputPicker/>
        <button className="btn mini" onClick={()=>{setSaveName(`Kit ${props.kitPresets.length+1}`);setSaveStep('choose')}}>{tr('＋ 儲存 Kit')}</button>
        <button className="btn mini" onClick={()=>props.setKitLibraryOpen(!props.kitLibraryOpen)}>{tr('▣ Kit 資料庫')}</button>
        <button className="btn mini" onClick={()=>props.onResetPads()}>↺ {props.t('resetPad')}</button>
        <div className={`instrument-status ${props.midiConnected?'mode-pad':'mode-offline'}`}><span className={`device-dot ${props.midiConnected?'online':'offline'}`}></span>{props.midiConnected?props.t('midiReady'):props.t('waitingMidi')}</div>
      </div>
    </section>
    <section className="sx-layout">
      <div className="sx-left">
        <div className="sx-pads">
          {props.assignments.map((a,i)=>{const mainName=a.main?.fileName||a.fileName;const subName=a.sub?.fileName
            return <PadCard key={i} note={a.midiNote??36+i} label={labels[i]} active={props.selectedPad===i} activeLayer={props.selectedLayer} learning={props.midiLearnPad===i} hit={props.hitVisual?.index===i} intensity={props.hitVisual?.index===i?props.hitVisual.intensity:0}
              main={{name:mainName,volume:a.main?.volume??100,pan:a.main?.pan??0}} sub={{name:subName,volume:a.sub?.volume??100,pan:a.sub?.pan??0}}
              learnLabel={props.t('learn')} mainLabel={props.t('main')} subLabel={props.t('sub')}
              onPad={()=>{selectAssignedLayer(i,'main'); void props.onPlay(i,true)}}
              onLayer={layer=>{selectAssignedLayer(i,layer); void props.onPlayLayer(i,layer,true)}}
              onDropLayer={(layer,path)=>{const file=props.files.find(f=>f.path===path);if(file)void props.onAssign(file,i,layer)}}
              onContext={e=>handlePadContext(e,i)} onLearn={()=>props.onLearn(i)}/>})}
        </div>
        <ComputerWaveEditor showFx fx={props.assignments[props.selectedPad]?.[props.selectedLayer]?.fx||[]} onFxChange={slots=>props.onFxChange(props.selectedPad,props.selectedLayer,slots)} padIndex={props.selectedPad} layer={props.selectedLayer} mainFile={selected?.main?.filePath?{name:selected.main.fileName||'Main',path:selected.main.filePath,size:0,extension:selected.main.filePath.split('.').pop()?.toLowerCase()||''}:undefined} subFile={selected?.sub?.filePath?{name:selected.sub.fileName||'Sub',path:selected.sub.filePath,size:0,extension:selected.sub.filePath.split('.').pop()?.toLowerCase()||''}:undefined} mainMix={selected?.main||{volume:100,pan:0}} subMix={selected?.sub||{volume:100,pan:0}} onLayerChange={layer=>selectAssignedLayer(props.selectedPad,layer)} file={(props.selectedLayer==='main'?selected?.main?.filePath:selected?.sub?.filePath)?{name:(props.selectedLayer==='main'?selected?.main?.fileName:selected?.sub?.fileName)|| (props.selectedLayer==='main'?'Main':'Sub'),path:(props.selectedLayer==='main'?selected?.main?.filePath:selected?.sub?.filePath)!,size:0,extension:(props.selectedLayer==='main'?selected?.main?.filePath:selected?.sub?.filePath)!.split('.').pop()?.toLowerCase()||''}:undefined} editedBuffer={props.editedBuffer} editedSettings={props.editedSettings} t={props.t} musicVolume={props.musicVolume} onEditedBuffer={props.onEditedBuffer} onMixChange={(layer,patch)=>props.onMixChange(props.selectedPad,layer,patch)}/>
      </div>
      <aside className="spd-source-panel">
        <div className="spd-source-head"><div className="spd-source-head-info"><div className="instrument-card-title">{props.t('sourceTabs')}</div><div className="source-path-marquee"><span>{props.activeSource?.path||props.t('noSource')}</span></div></div><div className="sx-head-actions"><HelpTip lines={[tr('先選取 PAD，再將音檔拖到 PAD 的 MAIN / SUB'),tr('點擊音檔只會選取，不會自動指派'),tr('在音檔上按右鍵：快速指定 MAIN / SUB → PAD')]}/><button className="btn mini" onClick={()=>void props.onAddSource()}>＋ {props.t('addSource')}</button></div></div>
        <div className={`spd-source-tabs ${sourceSearch || sourceTag!=='ALL' ? 'locked' : ''}`}>{props.sources.map(s=><button type="button" key={s.id} disabled={!!sourceSearch || sourceTag!=='ALL'} title={sourceSearch || sourceTag!=='ALL' ? tr('清除搜尋後可切換分類') : s.name} className={`spd-source-tab ${props.activeSource?.id===s.id?'active':''}`} onClick={()=>{setSourceTag('ALL');setSourceSearch('');props.onSourceChange(s.id)}}>{s.name}</button>)}</div>
        <div className="spd-source-search-block"><div className="spd-source-search-row"><input className="search" value={sourceSearch} onChange={e=>setSourceSearch(e.target.value)} placeholder={tr('搜尋音源名稱…')}/><div className="spd-tag-picker"><button type="button" className={`btn mini ${sourceTag!=='ALL'?'active':''}`} onClick={()=>setSourceTagMenuOpen(v=>!v)}>{tr('標籤')}{sourceTag!=='ALL'?`：${sourceTag}`:''}⌄</button>{sourceTagMenuOpen&&<div className="spd-tag-menu"><div className="spd-tag-add-row"><input value={newTag} onChange={e=>setNewTag(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();addCustomTag()}}} placeholder={tr('新增標籤…')}/><button type="button" className="btn mini" onClick={addCustomTag} disabled={!newTag.trim()}>＋</button></div><button type="button" className={sourceTag==='ALL'?'active':''} onClick={()=>{setSourceTag('ALL');setSourceTagMenuOpen(false)}}>{tr('全部')}</button>{quickTags.map(tag=><div className={`spd-tag-item ${sourceTag===tag?'active':''}`} key={tag}><button type="button" className="spd-tag-select" onClick={()=>{setSourceTag(tag);setSourceTagMenuOpen(false)}}>{tag}</button><button type="button" className="spd-tag-delete" onClick={()=>deleteCustomTag(tag)} aria-label={tr('刪除 {0}',tag)}>×</button></div>)}</div>}</div><button type="button" className="btn mini" disabled={sourceTag==='ALL'&&!sourceSearch} onClick={()=>{setSourceSearch('');setSourceTag('ALL')}}>{tr('清除')}</button></div></div>
        <div className="spd-file-list">{props.busy?<div className="midi-empty">{props.t('scanning')}</div>:browserPool.length===0?<div className="midi-empty">{props.t('noAudio')}</div>:searchableFiles.length===0?<div className="midi-empty">{tr('沒有符合條件的音源')}</div>:searchableFiles.map(file=><button type="button" key={file.path} draggable className={`spd-file-row ${props.selectedFile?.path===file.path?'selected assigned':''}`} onContextMenu={e=>handleSourceContext(e,file)} onDragStart={e=>{e.dataTransfer.setData('application/x-spd-audio',file.path);e.dataTransfer.effectAllowed='copy'}} onClick={()=>props.onSelectFile(file)}><span>{file.name}</span><small>{file.extension.toUpperCase()} · {file.duration!=null?formatTime(file.duration):durationMap[file.path]!=null?formatTime(durationMap[file.path]):'…'}</small></button>)}</div>
      </aside>
    </section>

    {props.kitLibraryOpen&&<>
      <div className="spd-kit-backdrop" onClick={()=>props.setKitLibraryOpen(false)}></div>
      <aside className="spd-kit-drawer">
        <div className="spd-kit-drawer-head"><div><div className="eyebrow">KIT DATABASE</div><strong>SPD Pad Kits</strong></div><button className="btn mini" onClick={()=>props.setKitLibraryOpen(false)}>×</button></div>
        <div className="spd-kit-list">{props.kitPresets.length===0?<div className="midi-empty">{tr('尚無儲存的 Kit')}</div>:props.kitPresets.map(p=><div key={p.id} className="spd-kit-card"><button className="spd-kit-load" onClick={()=>props.onLoadKit(p)}><strong>{p.name}</strong><small>{new Date(p.updatedAt).toLocaleString()}</small></button><button className="spd-kit-delete" onClick={()=>props.onDeleteKit(p.id)}>×</button></div>)}</div>
      </aside>
    </>}

    {sourceMenuOpen&&<ContextMenu x={sourceMenu.x} y={sourceMenu.y} title={sourceMenu.file.name} onClose={closeMenus} items={(['main','sub'] as const).map(layer=>({label:layer.toUpperCase(),sub:padNames.map((name,index)=>({label:name,onSelect:()=>assignFromMenu(layer,index)}))}))}/>}
    {padMenu&&<ContextMenu x={padMenu.x} y={padMenu.y} title={padNames[padMenu.pad]} onClose={closeMenus} items={[{label:tr('清除 MAIN'),onSelect:()=>props.onClearLayer(padMenu.pad,'main')},{label:tr('清除 SUB'),onSelect:()=>props.onClearLayer(padMenu.pad,'sub')},{divider:true},{label:tr('清除全部'),danger:true,onSelect:()=>props.onClearPad(padMenu.pad)}]}/>}
    {saveStep!=='closed'&&<div className="kit-save-modal-backdrop"><div className="kit-save-modal" onClick={e=>e.stopPropagation()}>{saveStep==='choose'&&<><div className="eyebrow">SAVE KIT</div><h2>{tr('儲存 Kit')}</h2><p>{tr('請選擇儲存方式。')}</p><div className="kit-save-actions"><button className="btn primary" onClick={()=>setSaveStep('overwrite')}>{tr('覆蓋當前 Kit')}</button><button className="btn secondary" onClick={()=>setSaveStep('new')}>{tr('另存新 Kit')}</button><button className="btn mini" onClick={()=>setSaveStep('closed')}>{tr('取消')}</button></div></>}{saveStep==='overwrite'&&<><div className="eyebrow">OVERWRITE</div><h2>{tr('確認覆蓋目前 Kit？')}</h2><p>{tr('這會更新目前載入的儲存 Kit；若尚未載入，將以目前硬體 Kit 名稱建立。')}</p><div className="kit-save-actions"><button className="btn primary" onClick={()=>{props.onSaveKit('overwrite');setSaveStep('closed')}}>{tr('確認儲存覆蓋')}</button><button className="btn mini" onClick={()=>setSaveStep('closed')}>{tr('取消')}</button></div></>}{saveStep==='new'&&<><div className="eyebrow">NEW KIT</div><h2>{tr('另存新 Kit')}</h2><input className="kit-save-name" value={saveName} onChange={e=>setSaveName(e.target.value)} autoFocus/><div className="kit-save-actions"><button className="btn primary" disabled={!saveName.trim()} onClick={()=>{props.onSaveKit('new',saveName.trim());setSaveStep('closed')}}>{tr('確認')}</button><button className="btn mini" onClick={()=>setSaveStep('closed')}>{tr('取消')}</button></div></>}</div></div>}
  </main>
}

function ComputerWaveEditor(props:{showFx?:boolean;fx?:FxSlot[];onFxChange?:(slots:FxSlot[])=>void;padIndex:number;layer:'main'|'sub';mainFile?:AudioFileInfo;subFile?:AudioFileInfo;mainMix:PadLayer;subMix:PadLayer;onLayerChange:(v:'main'|'sub')=>void;file?:AudioFileInfo;editedBuffer?:AudioBuffer;editedSettings?:WaveformEditState;t:(key:string)=>string;musicVolume:number;onEditedBuffer:(key:string,buffer:AudioBuffer,settings:{reverse:boolean;edits:WaveformEditState})=>void;onMixChange:(layer:'main'|'sub',patch:Partial<PadLayer>)=>void}){
  const [buffer,setBuffer]=useState<AudioBuffer|null>(null)
  const [edits,setEdits]=useState<WaveformEditState>({start:0,end:1,fadeIn:0,fadeOut:0,normalize:false,pitch:0,fadeInCurve:.5,fadeOutCurve:.5,playMode:'oneShot',reverse:false})
  const [history,setHistory]=useState<WaveformEditState[]>([]); const [future,setFuture]=useState<WaveformEditState[]>([]); const [zoom,setZoom]=useState(1); const [viewStart,setViewStart]=useState(0)
  const [view,setView]=useState<'edit'|'fx'>('edit'); const fxSlots=props.fx||[]; const fxView=!!props.showFx&&view==='fx'
  const viewSpan=1/Math.max(1,zoom); const vStart=clamp(viewStart,0,1-viewSpan)
  const toX=(ratio:number,w:number)=>(ratio-vStart)/viewSpan*w
  const toRatio=(x:number,w:number)=>vStart+clamp(x/Math.max(w,1),0,1)*viewSpan
  const drawRef=useRef<()=>void>(()=>{})
  const canvasRef=useRef<HTMLCanvasElement|null>(null); const audioCtxRef=useRef<AudioContext|null>(null); const dragRef=useRef<{mode:'start'|'end'|'fadeIn'|'fadeOut'|'fadeInCurve'|'fadeOutCurve'|null;startY:number;initial?:WaveformEditState;grab?:number}>({mode:null,startY:0})
  const defaultEdits:WaveformEditState={start:0,end:1,fadeIn:0,fadeOut:0,normalize:false,pitch:0,fadeInCurve:.5,fadeOutCurve:.5,playMode:'oneShot',reverse:false}
  // Identity of what the editor is currently showing. Everything that is written back to the
  // parent is tagged with this key, so audio / settings of PAD A can never land on PAD B.
  const currentKey=props.file?`${props.padIndex}:${props.layer}:${props.file.path}`:''
  const [bufferKey,setBufferKey]=useState('')
  const [editsKey,setEditsKey]=useState('')
  const editsRef=useRef(edits); editsRef.current=edits
  const keyRef=useRef(currentKey); keyRef.current=currentKey
  const lastRegisteredRef=useRef('')
  const pendingFlushRef=useRef<(()=>void)|null>(null)
  const editedJson=props.editedSettings?JSON.stringify(props.editedSettings):''
  // 1) decode the source file only when pad / layer / file really changes (not on every parent re-render)
  useEffect(()=>{
    let alive=true
    setHistory([]); setFuture([]); setBuffer(null); setBufferKey('')
    if(!props.file) return ()=>{alive=false}
    const key=currentKey
    void (async()=>{try{const bytes=await window.spd.sound.readFile(props.file!.path);if(!bytes)throw new Error('Audio file not found');const ctx=await audioEngine.get(false);audioCtxRef.current=ctx;const decoded=await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer);if(alive){setBuffer(decoded);setBufferKey(key)}}catch{if(alive){setBuffer(null);setBufferKey('')}}})()
    return()=>{alive=false}
  },[currentKey])
  // 2) adopt the saved settings of this pad/layer (ignore the echo of our own writes, so dragging is never reset)
  useEffect(()=>{
    if(editedJson&&editedJson===lastRegisteredRef.current&&editsKey===currentKey) return
    const next:WaveformEditState=props.editedSettings?{...defaultEdits,...clone(props.editedSettings)}:clone(defaultEdits)
    if(JSON.stringify(next)!==JSON.stringify(editsRef.current)) setEdits(next)
    setEditsKey(currentKey)
  },[currentKey,editedJson])
  drawRef.current=draw
  useEffect(()=>{draw()},[buffer,edits,zoom,viewStart])
  useEffect(()=>{const c=canvasRef.current;if(!c||typeof ResizeObserver==='undefined')return;const ro=new ResizeObserver(()=>drawRef.current());ro.observe(c);return()=>ro.disconnect()},[])
  useEffect(()=>{const c=canvasRef.current;if(!c)return;const onWheel=(ev:WheelEvent)=>{if(zoom<=1)return;ev.preventDefault();const delta=Math.abs(ev.deltaX)>Math.abs(ev.deltaY)?ev.deltaX:ev.deltaY;setViewStart(v=>clamp(v+delta/Math.max(c.clientWidth,1)*viewSpan,0,1-viewSpan))};c.addEventListener('wheel',onWheel,{passive:false});return()=>c.removeEventListener('wheel',onWheel)},[zoom,viewSpan])
  // 3) publish the processed buffer — only when buffer, edits and pad/layer all belong together
  useEffect(()=>{
    if(!buffer||!props.file||bufferKey!==currentKey||editsKey!==currentKey) return
    const key=currentKey; const snapshot=clone(edits); const src=buffer; let done=false
    const flush=()=>{if(done)return;done=true;pendingFlushRef.current=null;const out=renderEditedBuffer(src,snapshot);lastRegisteredRef.current=JSON.stringify(snapshot);props.onEditedBuffer(key,out,{reverse:!!snapshot.reverse,edits:snapshot})}
    pendingFlushRef.current=flush
    const timer=window.setTimeout(flush,60)
    return()=>{window.clearTimeout(timer);if(keyRef.current!==key)flush()}
  },[edits,buffer,bufferKey,editsKey,currentKey])
  useEffect(()=>()=>{pendingFlushRef.current?.()},[])
  function commit(next:WaveformEditState){setHistory(h=>[...h,clone(edits)].slice(-50));setFuture([]);setEdits(clone(next))}
  function undo(){setHistory(h=>{if(!h.length)return h;const prev=h[h.length-1];setFuture(f=>[clone(edits),...f].slice(0,50));setEdits(clone(prev));return h.slice(0,-1)})}
  function redo(){setFuture(f=>{if(!f.length)return f;const next=f[0];setHistory(h=>[...h,clone(edits)].slice(-50));setEdits(clone(next));return f.slice(1)})}
  function canvasRatio(x:number){const r=canvasRef.current?.getBoundingClientRect();return r?clamp((x-r.left)/Math.max(r.width,1),0,1):0}
  function draw(){
    const c=canvasRef.current;if(!c)return
    if(!buffer){const g=c.getContext('2d');g?.clearRect(0,0,c.width,c.height);return}
    const r=c.getBoundingClientRect(),w=Math.max(1,Math.floor(r.width)),h=Math.max(1,Math.floor(r.height)),ratio=window.devicePixelRatio||1
    if(w<8||h<8)return
    c.width=w*ratio;c.height=h*ratio
    const ctx=c.getContext('2d');if(!ctx)return
    const css=getComputedStyle(c)
    const col=(name:string,fb:string)=>css.getPropertyValue(name).trim()||fb
    const tint=col('--sx-tint','#0a84ff'),waveC=col('--sx-wave','#f1f5f9'),dimC=col('--sx-wave-dim','rgba(241,245,249,.32)'),gridC=col('--sx-grid','rgba(241,245,249,.09)'),labelC=col('--sx-label','rgba(241,245,249,.6)'),onTint=col('--sx-on-tint','#fff'),stageC=col('--sx-stage-bg','#06080b')
    const FONT='600 11px -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang TC",system-ui,sans-serif'
    ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h)
    const d=buffer.getChannelData(0),len=d.length,dur=Math.max(buffer.duration,.001)
    const rulerH=22,plotH=h-rulerH,mid=plotH/2
    const sR=clamp(edits.start,0,1),eR=clamp(Math.max(edits.end,sR+.0001),0,1)
    const rs=Math.max(0,Math.floor(clamp(edits.start,0,.999)*len)),re=Math.min(len,Math.max(rs+1,Math.floor(clamp(edits.end,edits.start+.001,1)*len)))
    // ruler + grid
    const visDur=dur*viewSpan,t0=vStart*dur,steps=[.005,.01,.02,.05,.1,.2,.25,.5,1,2,5,10,30,60],step=steps.find(st=>st/visDur*w>=84)||60
    ctx.font=FONT;ctx.textBaseline='alphabetic'
    for(let t=Math.ceil(t0/step)*step;t<=t0+visDur+1e-9;t+=step){const x=Math.round((t-t0)/visDur*w)+.5;ctx.strokeStyle=gridC;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,plotH);ctx.stroke();ctx.fillStyle=labelC;ctx.textAlign='left';ctx.fillText(step<1?`${t.toFixed(step<.01?3:2)}s`:`${t.toFixed(t%1?1:0)}s`,x+4,h-7)}
    ctx.strokeStyle=gridC;ctx.beginPath();ctx.moveTo(0,mid+.5);ctx.lineTo(w,mid+.5);ctx.stroke()
    // waveform — with Reverse the whole waveform is drawn mirrored (playback order); START / END trim it in place
    const i0=Math.floor(vStart*len),i1=Math.min(len,Math.ceil((vStart+viewSpan)*len)),perPx=Math.max(1,(i1-i0)/w)
    for(let x=0;x<w;x++){
      const a=i0+Math.floor(x*perPx),b=Math.min(len,Math.max(a+1,i0+Math.floor((x+1)*perPx)))
      const inSel=a>=rs&&a<re
      let lo=a,hi=b
      if(edits.reverse){lo=len-b;hi=len-a}  // whole waveform mirrored; handles stay put on it
      let mn=1,mx=-1;const stride=Math.max(1,Math.floor((hi-lo)/192))
      for(let j=lo;j<hi;j+=stride){const v=d[j]??0;if(v<mn)mn=v;if(v>mx)mx=v}
      if(mn>mx){mn=0;mx=0}
      ctx.fillStyle=inSel?waveC:dimC
      const y1=mid-mx*mid*.9,y2=mid-mn*mid*.9;ctx.fillRect(x,Math.min(y1,y2),1,Math.max(1,Math.abs(y2-y1)))
    }
    const xs=toX(sR,w),xe=toX(eR,w),fiR=clamp(edits.fadeIn/dur,0,eR-sR),foR=clamp(edits.fadeOut/dur,0,eR-sR),xfi=toX(sR+fiR,w),xfo=toX(eR-foR,w)
    const cx0=clamp(xs,0,w),cx1=clamp(xe,0,w)
    ctx.globalAlpha=.55;ctx.fillStyle=stageC;ctx.fillRect(0,0,cx0,plotH);ctx.fillRect(cx1,0,w-cx1,plotH);ctx.globalAlpha=.07;ctx.fillStyle=tint;ctx.fillRect(cx0,0,Math.max(0,cx1-cx0),plotH);ctx.globalAlpha=1
    // fades, Logic-style: the attenuated area above the curve is shaded, the curve itself is the control
    const gain=(t:number,cv:number)=>Math.pow(clamp(t,0,1),Math.max(.05,cv*2)),yOf=(g:number)=>plotH*(1-g),N=64
    const fadeShape=(x0:number,x1:number,cv:number,isIn:boolean)=>{
      if(x1-x0<1)return
      ctx.beginPath()
      if(isIn){ctx.moveTo(x0,0);ctx.lineTo(x1,0);for(let i=N;i>=0;i--){const t=i/N;ctx.lineTo(x0+(x1-x0)*t,yOf(gain(t,cv)))}}
      else{ctx.moveTo(x1,0);ctx.lineTo(x0,0);for(let i=0;i<=N;i++){const t=i/N;ctx.lineTo(x0+(x1-x0)*t,yOf(gain(1-t,cv)))}}
      ctx.closePath();ctx.globalAlpha=.62;ctx.fillStyle=stageC;ctx.fill();ctx.globalAlpha=1
      ctx.beginPath();for(let i=0;i<=N;i++){const t=i/N,x=x0+(x1-x0)*t,y=yOf(gain(isIn?t:1-t,cv));if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}
      ctx.lineWidth=2.5;ctx.lineJoin='round';ctx.strokeStyle=tint;ctx.stroke()
    }
    fadeShape(xs,xfi,edits.fadeInCurve,true);fadeShape(xfo,xe,edits.fadeOutCurve,false)
    // trim lines + centre grips
    ctx.lineWidth=2;ctx.strokeStyle=tint
    const rr=(x:number,y:number,ww:number,hh:number,rad:number)=>{ctx.beginPath();if((ctx as any).roundRect)(ctx as any).roundRect(x,y,ww,hh,rad);else ctx.rect(x,y,ww,hh)}
    for(const x0 of [xs,xe]){if(x0<-2||x0>w+2)continue;const x=clamp(x0,1.5,w-1.5);ctx.beginPath();ctx.moveTo(Math.round(x),0);ctx.lineTo(Math.round(x),plotH);ctx.stroke()}
    for(const x0 of [xs,xe]){if(x0<-2||x0>w+2)continue;const x=Math.round(clamp(x0,6,w-6));ctx.fillStyle=tint;rr(x-5,mid-16,10,32,5);ctx.fill();ctx.fillStyle=onTint;ctx.globalAlpha=.85;ctx.fillRect(x-1.5,mid-7,1,14);ctx.fillRect(x+.5,mid-7,1,14);ctx.globalAlpha=1}
    // fade handles (square, top corner of each fade) — drag sideways to change length
    for(const x0 of [xfi,xfo]){if(x0<-9||x0>w+9)continue;const x=Math.round(clamp(x0,9,w-9));ctx.fillStyle=onTint;rr(x-6,5,12,12,3);ctx.fill();ctx.lineWidth=2.5;ctx.strokeStyle=tint;ctx.stroke()}
    // chips
    const chip=(text:string,x:number,y:number,align:'left'|'right'|'center',filled:boolean)=>{ctx.font=FONT;const tw=ctx.measureText(text).width,cw=tw+14,cx=align==='left'?x:align==='right'?x-cw:x-cw/2;ctx.fillStyle=filled?tint:stageC;ctx.globalAlpha=filled?1:.82;rr(cx,y,cw,20,10);ctx.fill();ctx.globalAlpha=1;ctx.fillStyle=filled?onTint:waveC;ctx.textAlign='left';ctx.fillText(text,cx+7,y+14);return cw}
    const sT=`${(edits.start*dur).toFixed(3)} s`,eT=`${(edits.end*dur).toFixed(3)} s`,cy=plotH-26
    if(xe-xs>200){chip(sT,clamp(xs+10,4,w-90),cy,'left',false);chip(eT,clamp(xe-10,90,w-4),cy,'right',false)}else{chip(`${sT} → ${eT}`,clamp((xs+xe)/2,70,w-70),cy,'center',false)}
    if(edits.reverse){const mx=clamp((xs+xe)/2,60,w-60);chip('◀ REVERSE',mx,(xe-xs>260)?7:26,'center',true)}
    ctx.textAlign='left'
  }
  function hitTest(e:React.PointerEvent<HTMLCanvasElement>){
    const r=e.currentTarget.getBoundingClientRect(),w=r.width,h=r.height,x=e.clientX-r.left,y=e.clientY-r.top
    const plotH=h-22,dur=Math.max(buffer?.duration||0,.001),region=Math.max(0,edits.end-edits.start)
    const fi=clamp(edits.fadeIn/dur,0,region),fo=clamp(edits.fadeOut/dur,0,region)
    const xs=toX(edits.start,w),xe=toX(edits.end,w),xfi=toX(edits.start+fi,w),xfo=toX(edits.end-fo,w)
    const gain=(t:number,cv:number)=>Math.pow(clamp(t,0,1),Math.max(.05,cv*2))
    let mode:null|'start'|'end'|'fadeIn'|'fadeOut'|'fadeInCurve'|'fadeOutCurve'=null,grab=0
    const hx=(v:number)=>clamp(v,9,w-9)
    if(Math.abs(x-hx(xfi))<=11&&y<=24){mode='fadeIn';grab=x-xfi}
    else if(Math.abs(x-hx(xfo))<=11&&y<=24){mode='fadeOut';grab=x-xfo}
    else{
      const ds=Math.abs(x-xs),de=Math.abs(x-xe)
      if(Math.min(ds,de)<=9){mode=ds<=de?'start':'end';grab=x-(ds<=de?xs:xe)}
      else if(fi>0&&x>xs&&x<xfi){const t=(x-xs)/Math.max(xfi-xs,1);if(Math.abs(y-plotH*(1-gain(t,edits.fadeInCurve)))<=11)mode='fadeInCurve'}
      else if(fo>0&&x>xfo&&x<xe){const t=(x-xfo)/Math.max(xe-xfo,1);if(Math.abs(y-plotH*(1-gain(1-t,edits.fadeOutCurve)))<=11)mode='fadeOutCurve'}
    }
    return {mode,w,h,grab}
  }
  function pointerDown(e:React.PointerEvent<HTMLCanvasElement>){if(!buffer)return;const {mode,grab}=hitTest(e);dragRef.current={mode,startY:e.clientY,initial:mode?clone(edits):undefined,grab};if(mode){e.currentTarget.setPointerCapture(e.pointerId);e.preventDefault()}}
  function pointerMove(e:React.PointerEvent<HTMLCanvasElement>){
    if(!buffer)return
    const mode=dragRef.current.mode
    if(!mode){const {mode:hover}=hitTest(e);e.currentTarget.style.cursor=hover==='fadeInCurve'||hover==='fadeOutCurve'?'ns-resize':hover?'ew-resize':'default';return}
    const r=e.currentTarget.getBoundingClientRect(),xr=toRatio(e.clientX-r.left-(dragRef.current.grab||0),r.width),dur=Math.max(buffer.duration,.001),init=dragRef.current.initial||edits,plotH=Math.max(r.height-22,1),dy=(e.clientY-dragRef.current.startY)/plotH
    let next=edits
    if(mode==='start')next={...edits,start:Math.min(xr,edits.end-.001),fadeIn:Math.min(edits.fadeIn,Math.max(0,(edits.end-xr)*dur))}
    else if(mode==='end')next={...edits,end:Math.max(xr,edits.start+.001),fadeOut:Math.min(edits.fadeOut,Math.max(0,(xr-edits.start)*dur))}
    else if(mode==='fadeIn')next={...edits,fadeIn:clamp(xr-edits.start,0,edits.end-edits.start)*dur}
    else if(mode==='fadeOut')next={...edits,fadeOut:clamp(edits.end-xr,0,edits.end-edits.start)*dur}
    else if(mode==='fadeInCurve')next={...edits,fadeInCurve:clamp(init.fadeInCurve+dy*.9,.05,.95)}
    else next={...edits,fadeOutCurve:clamp(init.fadeOutCurve+dy*.9,.05,.95)}
    editsRef.current=next;setEdits(next)
  }
  function pointerUp(e:React.PointerEvent<HTMLCanvasElement>){const initial=dragRef.current.initial;if(initial&&JSON.stringify(initial)!==JSON.stringify(editsRef.current)){setHistory(h=>[...h,initial].slice(-50));setFuture([])}dragRef.current={mode:null,startY:0};try{e.currentTarget.releasePointerCapture(e.pointerId)}catch{}}
  function makeProcessedBuffer(){ return buffer?renderEditedBuffer(buffer,edits):null }
  const localPreviewSourceRef=useRef<AudioBufferSourceNode|null>(null)
  async function previewEdited(){
    if(!buffer)return
    try{const old=localPreviewSourceRef.current;try{old?.stop()}catch{};const ctx=await audioEngine.get();audioCtxRef.current=ctx;const processed=makeProcessedBuffer();if(!processed)return;const src=ctx.createBufferSource();const gain=ctx.createGain();const pan=ctx.createStereoPanner();const fxOn=hasActiveFx(fxSlots);const playBuf=fxOn?bakeFx('ui:pv:'+currentKey,processed,{start:edits.start,end:edits.end},fxSlots):processed;src.buffer=playBuf;const mix=props.layer==='main'?props.mainMix:props.subMix;gain.gain.value=clamp((mix.volume/100)*(props.musicVolume/100),0,1);pan.pan.value=clamp((mix.pan||0)/100,-1,1);src.connect(gain).connect(pan).connect(audioEngine.input(props.padIndex));localPreviewSourceRef.current=src;src.onended=()=>{if(localPreviewSourceRef.current===src)localPreviewSourceRef.current=null};const startOffset=fxOn?0:clamp(edits.start,0,1)*processed.duration;const duration=fxOn?playBuf.duration:Math.max(0.02,(clamp(edits.end,0,1)-clamp(edits.start,0,1))*processed.duration);src.start(0,startOffset,duration)}catch{}}
  function applyCurrentEdits(){if(!buffer||!props.file)return;const processed=makeProcessedBuffer();if(!processed)return;const key=currentKey;if(bufferKey!==currentKey)return;props.onEditedBuffer(key,processed,{reverse:!!edits.reverse,edits:clone(edits)});}
  function reset(){commit(defaultEdits)}
  function exportEdited(){let out=makeProcessedBuffer();if(!out||!props.file)return;const fxOn=hasActiveFx(fxSlots);if(fxOn)out=bakeFx('ui:ex:'+currentKey,out,{start:edits.start,end:edits.end},fxSlots);const bytes=encodeComputerWav(out);void window.spd.saveWave({defaultName:`${props.file.name.replace(/\.[^.]+$/,'')}_${fxOn?'fx':'edited'}.wav`,bytes})}
  function encodeComputerWav(b:AudioBuffer){const ch=b.numberOfChannels,rate=b.sampleRate,frames=b.length,dataSize=frames*ch*2,buf=new ArrayBuffer(44+dataSize),v=new DataView(buf),write=(o:number,x:string)=>{for(let i=0;i<x.length;i++)v.setUint8(o+i,x.charCodeAt(i))};write(0,'RIFF');v.setUint32(4,36+dataSize,true);write(8,'WAVE');write(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,ch,true);v.setUint32(24,rate,true);v.setUint32(28,rate*ch*2,true);v.setUint16(32,ch*2,true);v.setUint16(34,16,true);write(36,'data');v.setUint32(40,dataSize,true);let o=44;for(let i=0;i<frames;i++)for(let c=0;c<ch;c++){const n=clamp(b.getChannelData(c)[i],-1,1);v.setInt16(o,n<0?n*0x8000:n*0x7fff,true);o+=2}return new Uint8Array(buf)}
  const setEdit=<K extends keyof WaveformEditState>(key:K,value:WaveformEditState[K])=>commit({...edits,[key]:value})
  const durationMs=(buffer?.duration||0)*1000, dur=Math.max(buffer?.duration||0,.001)
  const applyParam=(key:'start'|'end'|'fadeIn'|'fadeOut'|'pitch',value:number,cur:WaveformEditState):WaveformEditState=>{let v=value;if(key==='pitch')v=clamp(v,-24,24);else if(key==='start')v=clamp(v,0,Math.max(cur.end-.001,0));else if(key==='end')v=clamp(v,Math.min(cur.start+.001,1),1);else v=clamp(v,0,Math.max(0,(cur.end-cur.start)*dur));const patch:WaveformEditState={...cur,[key]:v};const region=Math.max(0,(patch.end-patch.start)*dur);patch.fadeIn=Math.min(patch.fadeIn,region);patch.fadeOut=Math.min(patch.fadeOut,region);return patch}
  const pct=(v:number,min:number,max:number)=>({'--p':`${clamp((v-min)/(max-min),0,1)*100}%`} as React.CSSProperties)
  const padLabel=props.padIndex===9?'KICK':`PAD ${props.padIndex+1}`
  const setZoomCentered=(z:number)=>{const span=1/z,cur=editsRef.current;setZoom(z);setViewStart(clamp((cur.start+cur.end)/2-span/2,0,1-span))}
  const field=(key:'start'|'end'|'fadeIn'|'fadeOut'|'pitch')=>{
    const label=key==='start'?props.t('start'):key==='end'?props.t('end'):key==='fadeIn'?props.t('fadeIn'):key==='fadeOut'?props.t('fadeOut'):props.t('pitch')
    const isPitch=key==='pitch',isFade=key==='fadeIn'||key==='fadeOut',raw=Number(edits[key]||0)
    const shown=isPitch?raw:raw*(isFade?1000:durationMs),unit=isPitch?'st':'ms'
    const begin=(e:React.PointerEvent<HTMLDivElement>)=>{e.currentTarget.setPointerCapture(e.pointerId);e.currentTarget.focus();const startY=e.clientY,initial=clone(editsRef.current),startValue=Number(initial[key]||0)
      const onMove=(ev:PointerEvent)=>{const delta=startY-ev.clientY;const step=isPitch?delta*0.08:isFade?(delta*.5)/1000:delta/Math.max(durationMs,1);const patch=applyParam(key,startValue+step,editsRef.current);editsRef.current=patch;setEdits(patch)}
      const onUp=()=>{window.removeEventListener('pointermove',onMove);window.removeEventListener('pointerup',onUp);window.removeEventListener('pointercancel',onUp);if(JSON.stringify(initial)!==JSON.stringify(editsRef.current)){setHistory(h=>[...h,initial].slice(-50));setFuture([])}}
      window.addEventListener('pointermove',onMove);window.addEventListener('pointerup',onUp);window.addEventListener('pointercancel',onUp)}
    const onKey=(e:React.KeyboardEvent)=>{const dir=e.key==='ArrowUp'||e.key==='ArrowRight'?1:e.key==='ArrowDown'||e.key==='ArrowLeft'?-1:0;if(!dir)return;e.preventDefault();const big=e.shiftKey,cur=editsRef.current,base=Number(cur[key]||0);const delta=isPitch?dir*(big?1:.1):isFade?dir*(big?.01:.001):dir*(big?10:1)/Math.max(durationMs,1);commit(applyParam(key,base+delta,cur))}
    return <div key={key} className="sx-field" role="slider" tabIndex={0} aria-label={label} aria-valuenow={Number(shown.toFixed(1))} aria-valuetext={`${shown.toFixed(1)} ${unit}`} title={tr('上下拖曳調整 · 方向鍵微調（Shift 加大）· 雙擊重設')} onPointerDown={begin} onKeyDown={onKey} onDoubleClick={()=>commit(applyParam(key,key==='end'?1:0,editsRef.current))}><span className="sx-field-label">{label}</span><span className="sx-field-value"><b>{shown.toFixed(1)}</b><i>{unit}</i></span></div>}
  const slider=(label:string,value:number,min:number,max:number,step:number,onChange:(v:number)=>void,out:string,stack=false)=><label className={`sx-row${stack?' is-stack':''}`}><span className="sx-row-label">{label}</span><input className="sx-slider" type="range" min={min} max={max} step={step} value={value} style={pct(value,min,max)} onChange={e=>onChange(Number(e.target.value))}/><output>{out}</output></label>
  return <section className="sx-wave" data-has-audio={buffer?'1':'0'}>
    <header className="sx-wave-head">
      <div className="sx-wave-id">
        <div className="sx-seg" role="tablist" aria-label="Layer"><button type="button" role="tab" aria-selected={props.layer==='main'} className={props.layer==='main'?'on':''} onClick={()=>props.onLayerChange('main')}>MAIN</button><button type="button" role="tab" aria-selected={props.layer==='sub'} className={props.layer==='sub'?'on':''} onClick={()=>props.onLayerChange('sub')}>SUB</button></div>
        {props.showFx&&<div className="sx-seg" role="tablist" aria-label="View"><button type="button" role="tab" aria-selected={!fxView} className={!fxView?'on':''} onClick={()=>setView('edit')}>{tr('編輯')}</button><button type="button" role="tab" aria-selected={fxView} className={fxView?'on':''} onClick={()=>setView('fx')}>FX{hasActiveFx(fxSlots)&&<i className="sx-dot"/>}</button></div>}
        <div className="sx-wave-file"><strong title={props.file?.name}>{props.file?.name||props.t('noAudioSelected')}</strong><span>{padLabel} · {buffer?`${formatTime(buffer.duration)} · ${(buffer.sampleRate/1000).toFixed(1)} kHz`:'—'}</span></div>
      </div>
      <div className="sx-wave-tools">
        <div className="sx-iconbtns"><button type="button" className="sx-icon" disabled={!history.length} onClick={undo} title={tr('復原')} aria-label={tr('復原')}>↶</button><button type="button" className="sx-icon" disabled={!future.length} onClick={redo} title={tr('重做')} aria-label={tr('重做')}>↷</button></div>
        <button type="button" className="sx-btn" disabled={!buffer} onClick={reset}>{props.t('reset')}</button>
        <button type="button" className="sx-btn" disabled={!buffer} onClick={()=>void previewEdited()}>▶ {props.t('preview')}</button>
        <button type="button" className="sx-btn is-primary" disabled={!buffer||!props.file} onClick={applyCurrentEdits}>{tr('✓ 套用')}</button>
        <button type="button" className="sx-btn" disabled={!buffer} onClick={exportEdited}>{props.t('exportAudio')}</button>
      </div>
    </header>
    <div className="sx-stage"><canvas ref={canvasRef} className="sx-canvas" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}/>{!buffer&&<div className="sx-stage-empty"><svg width="34" height="22" viewBox="0 0 34 22" aria-hidden="true"><g fill="currentColor"><rect x="1" y="9" width="3" height="4" rx="1.5"/><rect x="7" y="5" width="3" height="12" rx="1.5"/><rect x="13" y="1" width="3" height="20" rx="1.5"/><rect x="19" y="6" width="3" height="10" rx="1.5"/><rect x="25" y="3" width="3" height="16" rx="1.5"/><rect x="31" y="8" width="2" height="6" rx="1"/></g></svg><strong>{props.file?tr('讀取中…'):props.t('noAudioSelected')}</strong><span>{props.file?'':tr('點選 PAD 的 MAIN / SUB，或從右側拖入音源')}</span></div>}</div>
    <div className="sx-stage-foot">
      <label className="sx-toggle is-inline"><input type="checkbox" role="switch" className="sx-switch" checked={!!edits.reverse} onChange={e=>setEdit('reverse',e.target.checked)}/><span>{props.t('reverse')}</span></label>
      <label className="sx-toggle is-inline"><input type="checkbox" role="switch" className="sx-switch" checked={edits.normalize} onChange={e=>setEdit('normalize',e.target.checked)}/><span>{props.t('normalize')}</span></label>
      <span className="sx-foot-spacer"/><HelpTip lines={[tr('拖曳 START / END 把手調整播放範圍'),tr('拖曳上方的方塊把手調整淡入／淡出長度'),tr('在淡化曲線上上下拖曳，可調整曲線形狀'),tr('數值欄位：上下拖曳或用方向鍵微調（Shift 加大），雙擊重設'),tr('Reverse 開啟後，波形會依播放方向反轉顯示')]}/>
      <label className="sx-zoom"><span>{props.t('zoom')}</span><input className="sx-slider" type="range" min="1" max="8" step="1" value={zoom} style={pct(zoom,1,8)} onChange={e=>setZoomCentered(Number(e.target.value))}/><output>{zoom}×</output></label>
      {zoom>1&&<label className="sx-zoom"><span>{tr('位置')}</span><input className="sx-slider" type="range" min="0" max="1000" step="1" value={Math.round((vStart/Math.max(1-viewSpan,1e-6))*1000)} style={pct(vStart/Math.max(1-viewSpan,1e-6),0,1)} onChange={e=>setViewStart(Number(e.target.value)/1000*(1-viewSpan))}/></label>}
    </div>
    {fxView?<FxRack slots={fxSlots} onChange={s=>props.onFxChange?.(s)} bakeKey={currentKey} srcSig={JSON.stringify([edits.start,edits.end,edits.reverse,edits.fadeIn,edits.fadeOut,edits.fadeInCurve,edits.fadeOutCurve,edits.pitch,edits.normalize,bufferKey])} makeSource={()=>{const b=makeProcessedBuffer();return b?{buffer:b,start:edits.start,end:edits.end}:null}}/>:<div className="sx-inspector">
      <section className="sx-group is-wide"><h4>TRIM · FADE · PITCH</h4>
        <div className="sx-fields">{field('start')}{field('end')}{field('fadeIn')}{field('fadeOut')}{field('pitch')}</div>
        <div className="sx-pair">{slider(props.t('fadeInCurve'),edits.fadeInCurve,.05,.95,.01,v=>setEdit('fadeInCurve',v),edits.fadeInCurve.toFixed(2),true)}{slider(props.t('fadeOutCurve'),edits.fadeOutCurve,.05,.95,.01,v=>setEdit('fadeOutCurve',v),edits.fadeOutCurve.toFixed(2),true)}</div></section>
      <section className="sx-group"><h4>MIX</h4>
        {slider('MAIN VOL',props.mainMix.volume??100,0,100,1,v=>props.onMixChange('main',{volume:v}),String(props.mainMix.volume??100))}{slider('MAIN PAN',props.mainMix.pan??0,-100,100,1,v=>props.onMixChange('main',{pan:v}),panLabel(props.mainMix.pan??0))}
        {slider('SUB VOL',props.subMix.volume??100,0,100,1,v=>props.onMixChange('sub',{volume:v}),String(props.subMix.volume??100))}{slider('SUB PAN',props.subMix.pan??0,-100,100,1,v=>props.onMixChange('sub',{pan:v}),panLabel(props.subMix.pan??0))}</section>
    </div>}
  </section>
}


function SettingsPage(props:{t:(key:string)=>string;language:string;musicVolume:number;soundVolume:number;soundStyle:string;velocitySensitivity:number;padSensitivities:number[];audioSources:AudioSourceTab[];themeMode:string;themeBg:string;themeLine:string;themeAccent:string;themeGradStart:string;themeGradEnd:string;themePixelSize:number;fontSize:number;fontSizeUnit:string;fontFamily:string;onApply:(next:{language:string;musicVolume:number;soundVolume:number;soundStyle:string;velocitySensitivity:number;padSensitivities:number[];themeMode:string;themeBg:string;themeLine:string;themeAccent:string;themeGradStart:string;themeGradEnd:string;themePixelSize:number;fontSize:number;fontSizeUnit:string;fontFamily:string})=>void;chooseAudioSource:()=>Promise<void>;deleteAudioSource:(id:string)=>Promise<void>;updateSourceName:(id:string,name:string)=>void}){
  const [tab,setTab]=useState<'general'|'pad'|'sources'|'theme'|'audio'>(()=>{const t=UI.settingsTab;UI.settingsTab='';return (['general','pad','sources','theme','audio'].includes(t)?t:'general') as 'general'})
  const [page,setPage]=useState(1)
  const styles=['studio','arcade','cinematic','dreamy','glass','mechanical','minimal','organic','rubber','scifi','soft','zen']
  const themeOptions=[['system',tr('系統預設')],['solid',tr('純色')],['gradient',tr('漸層')],['8bit','8bit'],['cyberpunk','Cyberpunk']] as const
  const themePresetsByMode:Record<string,Array<[string,string,{mode:string;bg:string;line:string;accent:string;gs:string;ge:string}]>>={
    system:[
      ['system-dark',tr('暗色（預設）'),{mode:'system',bg:'#0b0e12',line:'#2d3744',accent:'#f1f5f9',gs:'#202833',ge:'#0b0e12'}],
      ['system-graphite',tr('石墨'),{mode:'system',bg:'#12151a',line:'#343c48',accent:'#e9eef5',gs:'#1b2028',ge:'#12151a'}],
      ['system-midnight',tr('午夜藍'),{mode:'system',bg:'#0a1124',line:'#2b3b66',accent:'#dce7ff',gs:'#101a36',ge:'#0a1124'}],
      ['system-ocean',tr('深海青'),{mode:'system',bg:'#061b20',line:'#1f5560',accent:'#d6f5f8',gs:'#0b2a31',ge:'#061b20'}],
      ['system-forest',tr('森林綠'),{mode:'system',bg:'#0b1710',line:'#2a4d37',accent:'#dff2e6',gs:'#12251a',ge:'#0b1710'}],
      ['system-amber',tr('琥珀'),{mode:'system',bg:'#17110a',line:'#5a4420',accent:'#fdebc8',gs:'#241a0d',ge:'#17110a'}],
      ['system-violet',tr('暮紫'),{mode:'system',bg:'#120e1f',line:'#42366b',accent:'#ece3ff',gs:'#1c1530',ge:'#120e1f'}],
      ['system-light',tr('亮色'),{mode:'system',bg:'#f4f5f7',line:'#b8bfc9',accent:'#161b22',gs:'#ffffff',ge:'#e3e7eb'}],
      ['system-paper',tr('米白'),{mode:'system',bg:'#faf6ef',line:'#cfc4b1',accent:'#2a241b',gs:'#ffffff',ge:'#efe6d6'}],
    ],
    solid:[
      ['solid-system',tr('系統預設'),{mode:'solid',bg:'#0b0f14',line:'#2a333d',accent:'#dfe7ee',gs:'#0b0f14',ge:'#0b0f14'}],
      ['solid-black-white',tr('黑底白線'),{mode:'solid',bg:'#000000',line:'#ffffff',accent:'#ffffff',gs:'#000000',ge:'#000000'}],
      ['solid-white-black',tr('白底黑線'),{mode:'solid',bg:'#ffffff',line:'#111111',accent:'#111111',gs:'#ffffff',ge:'#ffffff'}],
      ['solid-red-black',tr('紅底黑線'),{mode:'solid',bg:'#b31217',line:'#000000',accent:'#ffffff',gs:'#b31217',ge:'#b31217'}],
      ['solid-black-red',tr('黑底紅線'),{mode:'solid',bg:'#000000',line:'#ff3030',accent:'#ff4b4b',gs:'#000000',ge:'#000000'}],
    ],
    gradient:[
      ['gradient-system',tr('系統預設'),{mode:'gradient',bg:'#0b0f14',line:'#2a333d',accent:'#dfe7ee',gs:'#0b0f14',ge:'#17212c'}],
      ['gradient-platinum',tr('白金'),{mode:'gradient',bg:'#34383d',line:'#f0f3f6',accent:'#ffffff',gs:'#202329',ge:'#aeb5bd'}],
      ['gradient-gold',tr('純金'),{mode:'gradient',bg:'#4b3a12',line:'#ffe58a',accent:'#ffe9a6',gs:'#2b2108',ge:'#8e6a18'}],
      ['gradient-bronze',tr('古銅金'),{mode:'gradient',bg:'#3c2b1d',line:'#d7a56b',accent:'#e8c08e',gs:'#261a12',ge:'#704927'}],
      ['gradient-rose',tr('玫瑰金'),{mode:'gradient',bg:'#4b2a36',line:'#f3b3c5',accent:'#ffd7e0',gs:'#2a1720',ge:'#8f4c62'}],
      ['gradient-space',tr('太空銀'),{mode:'gradient',bg:'#1c2027',line:'#c7d0dc',accent:'#eef2f6',gs:'#0e1117',ge:'#3b444f'}],
      ['gradient-bright',tr('亮銀'),{mode:'gradient',bg:'#5c626a',line:'#ffffff',accent:'#ffffff',gs:'#353a40',ge:'#aeb6bf'}],
    ],
    '8bit':[['8bit-default',tr('白底黑線'),{mode:'8bit',bg:'#ffffff',line:'#111111',accent:'#111111',gs:'#ffffff',ge:'#ffffff'}]],
    cyberpunk:[
      ['cyber-default',tr('預設（六色）'),{mode:'cyberpunk',bg:'#0a0810',line:'#35e0ff',accent:'#ffffff',gs:'#090512',ge:'#16091f'}],
      ['cyber-blue',tr('霓虹藍'),{mode:'cyberpunk',bg:'#08131f',line:'#18d4ff',accent:'#18d4ff',gs:'#041827',ge:'#0d2a40'}],
      ['cyber-green',tr('霓虹綠'),{mode:'cyberpunk',bg:'#07150c',line:'#39ff88',accent:'#39ff88',gs:'#06150d',ge:'#0e3a20'}],
      ['cyber-red',tr('霓虹紅'),{mode:'cyberpunk',bg:'#190707',line:'#ff3b30',accent:'#ff3b30',gs:'#160606',ge:'#3b0b0b'}],
      ['cyber-magenta',tr('霓虹洋紅'),{mode:'cyberpunk',bg:'#18061a',line:'#ff2bd6',accent:'#ff2bd6',gs:'#1a071d',ge:'#3c0a3f'}],
      ['cyber-yellow',tr('霓虹黃'),{mode:'cyberpunk',bg:'#171408',line:'#ffe64a',accent:'#ffe64a',gs:'#151206',ge:'#30240a'}],
      ['cyber-purple',tr('霓虹紫'),{mode:'cyberpunk',bg:'#12081a',line:'#b45cff',accent:'#b45cff',gs:'#100715',ge:'#2a0c3f'}],
    ]
  }
  const pageSize=10
  const pages=Math.max(1,Math.ceil(props.audioSources.length/pageSize))
  const shown=props.audioSources.slice((page-1)*pageSize,page*pageSize)
  const [draft,setDraft]=useState({language:props.language,musicVolume:props.musicVolume,soundVolume:props.soundVolume,soundStyle:props.soundStyle,velocitySensitivity:props.velocitySensitivity,padSensitivities:[...props.padSensitivities],themeMode:props.themeMode,themeBg:props.themeBg,themeLine:props.themeLine,themeAccent:props.themeAccent,themeGradStart:props.themeGradStart,themeGradEnd:props.themeGradEnd,themePixelSize:props.themePixelSize,fontSize:props.fontSize,fontSizeUnit:props.fontSizeUnit,fontFamily:props.fontFamily})
  useEffect(()=>setDraft({language:props.language,musicVolume:props.musicVolume,soundVolume:props.soundVolume,soundStyle:props.soundStyle,velocitySensitivity:props.velocitySensitivity,padSensitivities:[...props.padSensitivities],themeMode:props.themeMode,themeBg:props.themeBg,themeLine:props.themeLine,themeAccent:props.themeAccent,themeGradStart:props.themeGradStart,themeGradEnd:props.themeGradEnd,themePixelSize:props.themePixelSize,fontSize:props.fontSize,fontSizeUnit:props.fontSizeUnit,fontFamily:props.fontFamily}),[props.language,props.musicVolume,props.soundVolume,props.soundStyle,props.velocitySensitivity,props.padSensitivities,props.themeMode,props.themeBg,props.themeLine,props.themeAccent,props.themeGradStart,props.themeGradEnd,props.themePixelSize,props.fontSize,props.fontSizeUnit,props.fontFamily])
  useEffect(()=>setPage(p=>Math.min(p,Math.max(1,Math.ceil(props.audioSources.length/pageSize)))),[props.audioSources.length])
  const resetSystemSettings=()=>{
    const defaults={language:'zh-TW',musicVolume:90,soundVolume:55,soundStyle:'studio',velocitySensitivity:100,padSensitivities:Array.from({length:10},()=>100),themeMode:'system',themeBg:'#0b0e12',themeLine:'#2d3744',themeAccent:'#f1f5f9',themeGradStart:'#202833',themeGradEnd:'#0b0e12',themePixelSize:6,fontSize:100,fontSizeUnit:'percent',fontFamily:'system'}
    setDraft(defaults)
    props.onApply(defaults)
    localStorage.removeItem('core-sx-hidden-audio-tags')
    localStorage.removeItem('core-sx-audio-tags')
    window.dispatchEvent(new Event('core-sx-reset-tags'))
  }
  return <main className="settings-page">
    <header className="settings-head sx-settings-head"><h1>{props.t('settingsTitle')}</h1><HelpTip lines={[props.t('settingsApplyHint'),tr('可先選風格與推薦配色，再自行調整 RGB / HEX；設定會在右下角按「套用」後生效。')]}/></header>
    <nav className="settings-tabs"><button className={tab==='general'?'active':''} onClick={()=>setTab('general')}>{props.t('general')}</button><button className={tab==='pad'?'active':''} onClick={()=>setTab('pad')}>{props.t('padSensitivity')}</button><button className={tab==='sources'?'active':''} onClick={()=>setTab('sources')}>{props.t('audioSources')}</button><button className={tab==='theme'?'active':''} onClick={()=>setTab('theme')}>{props.t('theme')}</button><button className={tab==='audio'?'active':''} onClick={()=>setTab('audio')}>{tr('音訊輸出')}</button></nav>
    <section className="settings-control-section">
      <div className="settings-tab-panel">
        {tab==='audio'&&<div className="settings-card settings-single-card sx-audio-card"><AudioOutputSettings/></div>}
        {tab==='general'&&<div className="settings-card settings-single-card"><label className="settings-row"><span>{props.t('language')}</span><select value={draft.language} onChange={e=>setDraft(d=>({...d,language:e.target.value}))}><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option></select></label><label className="settings-row"><span>{props.t('musicVolume')} <b>{draft.musicVolume}</b></span><input type="range" min="0" max="100" value={draft.musicVolume} onChange={e=>setDraft(d=>({...d,musicVolume:Number(e.target.value)}))}/></label><label className="settings-row"><span>{props.t('soundVolume')} <b>{draft.soundVolume}</b></span><input type="range" min="0" max="100" value={draft.soundVolume} onChange={e=>setDraft(d=>({...d,soundVolume:Number(e.target.value)}))}/></label><label className="settings-row"><span>{props.t('soundStyle')}</span><select value={draft.soundStyle} onChange={e=>setDraft(d=>({...d,soundStyle:e.target.value}))}>{styles.map(st=><option key={st} value={st}>{st}</option>)}</select></label><label className="settings-row"><span>{tr('文字大小')} <b>{draft.fontSize}%</b></span><select value={draft.fontSize} onChange={e=>setDraft(d=>({...d,fontSize:Number(e.target.value)}))}>{[[90,tr('小 90%')],[100,tr('標準 100%')],[115,tr('大 115%')],[130,tr('特大 130%')],[150,tr('超大 150%')]].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><label className="settings-row"><span>{tr('字體')}</span><select value={draft.fontFamily} onChange={e=>setDraft(d=>({...d,fontFamily:e.target.value}))}><option value="system">{tr('系統字體')}</option><option value="rounded">{tr('Avenir / 圓潤')}</option><option value="mono">{tr('等寬 / 像素感')}</option></select></label><div className="settings-supported"><strong>{props.t('supported')}:</strong> WAV · AIFF · MP3 · OGG/OPUS · M4A/AAC · FLAC · WebM</div></div>}
        {tab==='pad'&&<div className="settings-card settings-pad-sensitivity"><div className="settings-pad-sensitivity-grid">{draft.padSensitivities.map((v,i)=><label className="settings-pad-sensitivity-row" key={i}><span>{i===9?'KICK':`PAD ${i+1}`} <b>{v}%</b></span><input type="range" min="25" max="200" value={v} onChange={e=>setDraft(d=>({...d,padSensitivities:d.padSensitivities.map((x,j)=>j===i?Number(e.target.value):x)}))}/></label>)}</div><div className="settings-supported">{props.t('velocitySensitivity')} · 25%–200%</div></div>}
        {tab==='sources'&&<div className="settings-card settings-sources-card settings-single-card"><div className="settings-card-head"><h2>{props.t('audioSources')}</h2><button className="btn mini" onClick={()=>void props.chooseAudioSource()}>＋ {props.t('addSource')}</button></div>{shown.length===0?<div className="settings-empty">{props.t('noSource')}</div>:shown.map(s=><div key={s.id} className="settings-source-row"><div><input className="settings-source-name" value={s.name} onChange={e=>props.updateSourceName(s.id,e.target.value)}/><small>{s.path}</small></div><button className="btn mini" onClick={()=>void props.deleteAudioSource(s.id)}>{props.t('delete')}</button></div>)}<div className="settings-pagination"><button className="btn mini" disabled={page<=1} onClick={()=>setPage(p=>Math.max(1,p-1))}>‹</button><span>{page} / {pages}</span><button className="btn mini" disabled={page>=pages} onClick={()=>setPage(p=>Math.min(pages,p+1))}>›</button></div></div>}
        {tab==='theme'&&<div className="settings-card settings-single-card theme-settings-card">
          <section className="theme-panel-section theme-style-section"><div className="theme-panel-title">{tr('風格')}</div><div className="theme-option-grid">{themeOptions.map(([id,label])=><button key={id} className={`theme-option ${draft.themeMode===id?'active':''}`} onClick={()=>setDraft(d=>({...d,themeMode:id}))}>{label}</button>)}</div></section>
          <section className="theme-panel-section theme-recommend-section"><div className="theme-panel-title">{tr('推薦配色')}</div><div className="theme-presets">{(themePresetsByMode[draft.themeMode]||themePresetsByMode.system).map(([id,label,p])=><button key={id} className={`theme-preset ${draft.themeMode===p.mode && draft.themeBg===p.bg && draft.themeLine===p.line ? 'active':''}`} onClick={()=>setDraft(d=>({...d,themeMode:p.mode,themeBg:p.bg,themeLine:p.line,themeAccent:p.accent,themeGradStart:p.gs,themeGradEnd:p.ge}))}>{label}</button>)}</div></section>
          <section className="theme-panel-section theme-picker-section"><div className="theme-panel-title">{tr('顏色選擇')}</div><div className="theme-color-grid"><label><span>{tr('底色')}</span><input type="color" value={draft.themeBg} onChange={e=>setDraft(d=>({...d,themeBg:e.target.value}))}/><input value={draft.themeBg} onChange={e=>setDraft(d=>({...d,themeBg:e.target.value}))}/></label><label><span>{tr('線條色')}</span><input type="color" value={draft.themeLine} onChange={e=>setDraft(d=>({...d,themeLine:e.target.value}))}/><input value={draft.themeLine} onChange={e=>setDraft(d=>({...d,themeLine:e.target.value}))}/></label><label><span>{tr('強調色')}</span><input type="color" value={draft.themeAccent} onChange={e=>setDraft(d=>({...d,themeAccent:e.target.value}))}/><input value={draft.themeAccent} onChange={e=>setDraft(d=>({...d,themeAccent:e.target.value}))}/></label><label><span>{tr('漸層起點')}</span><input type="color" value={draft.themeGradStart} onChange={e=>setDraft(d=>({...d,themeGradStart:e.target.value}))}/><input value={draft.themeGradStart} onChange={e=>setDraft(d=>({...d,themeGradStart:e.target.value}))}/></label><label><span>{tr('漸層終點')}</span><input type="color" value={draft.themeGradEnd} onChange={e=>setDraft(d=>({...d,themeGradEnd:e.target.value}))}/><input value={draft.themeGradEnd} onChange={e=>setDraft(d=>({...d,themeGradEnd:e.target.value}))}/></label></div>{draft.themeMode==='8bit'&&<label className="detail-control theme-pixel-size"><span>{tr('8bit 像素顆粒大小')}</span><input type="range" min="2" max="12" step="1" value={draft.themePixelSize} onChange={e=>setDraft(d=>({...d,themePixelSize:Number(e.target.value)}))}/><output>{draft.themePixelSize}px</output></label>}</section>
        </div>}
      </div>
      <div className="settings-control-footer" style={tab==='audio'?{display:'none'}:undefined}><div/><div className="settings-footer-actions"><button className="btn" onClick={resetSystemSettings}>{tr('↺ 重置系統設定')}</button><button className="btn primary" onClick={()=>props.onApply(draft)}>✓ {props.t('applySettings')}</button></div></div>
    </section>
    <footer className="settings-credit"><div className="eyebrow">{props.t('credit')}</div><div className="credit-grid"><div><strong>{props.t('producer')}</strong><span>Agi Lin</span></div><div><strong>Instagram</strong><span>axgxix411</span></div><div><strong>Gmail</strong><span>agilin0411@gmail.com</span></div></div></footer>
  </main>
}

function InstrumentMode(props:{
  t:(key:string)=>string; midiPorts:MidiPorts; midiStatus:MidiStatus; midiLog:MidiMessageLog[]; midiChannel:number; setMidiChannel:(v:number)=>void;
  midiInPort:number|null; midiOutPort:number|null; setMidiInPort:(v:number|null)=>void; setMidiOutPort:(v:number|null)=>void;
  connectMidiInput:()=>Promise<void>; connectMidiOutput:()=>Promise<void>; refreshMidiPorts:()=>void;
  sendProgramChange:(program:number)=>Promise<void>; midiAppControl:boolean; setMidiAppControl:(v:boolean)=>void; sysexHex:string; setSysexHex:(v:string)=>void; sendSysexHex:()=>Promise<void>; modeReady:boolean
}){
  const [program,setProgram]=useState(0)
  return <main className="instrument-mode">
    <section className="instrument-hero">
      <div><div className="eyebrow">{props.t('instrumentMode')}</div><h1>{props.t('directControl')}</h1><p>{props.t('audioMidiHint')}</p></div>
      <div className="instrument-status"><span className={`device-dot ${props.modeReady?'online':'offline'}`}></span>{props.modeReady?props.t('ready'):'…'}</div>
    </section>
    <section className="instrument-grid">
      <div className="instrument-card instrument-control-card"><div className="instrument-card-title">{props.t('spdControl')}</div><label className="midi-app-toggle"><input type="checkbox" checked={props.midiAppControl} onChange={e=>props.setMidiAppControl(e.target.checked)}/><span>{props.t('enableSpdControl')}</span></label><div className="instrument-note">{props.t('audioMidiHint')}</div></div>
      <div className="instrument-card">
        <div className="instrument-card-title">{props.t('midiPorts')}</div>
        <div className="instrument-port-grid">
          <label>{props.t('input')}<select value={props.midiInPort??''} onChange={e=>props.setMidiInPort(e.target.value===''?null:Number(e.target.value))}><option value="">—</option>{props.midiPorts.inputs.map(x=><option key={x.index} value={x.index}>{x.index}: {x.name}</option>)}</select><button className="btn mini" disabled={props.midiInPort===null} onClick={()=>void props.connectMidiInput()}>{props.t('connectInput')}</button></label>
          <label>{props.t('output')}<select value={props.midiOutPort??''} onChange={e=>props.setMidiOutPort(e.target.value===''?null:Number(e.target.value))}><option value="">—</option>{props.midiPorts.outputs.map(x=><option key={x.index} value={x.index}>{x.index}: {x.name}</option>)}</select><button className="btn mini" disabled={props.midiOutPort===null} onClick={()=>void props.connectMidiOutput()}>{props.t('connectOutput')}</button></label>
        </div>
        <button className="btn secondary wide" onClick={props.refreshMidiPorts}>{props.t('rescanMidi')}</button>
      </div>
      <div className="instrument-card">
        <div className="instrument-card-title">{props.t('programChange')}</div>
        <div className="pc-controls"><label>{props.t('channel')}<select value={props.midiChannel} onChange={e=>props.setMidiChannel(Number(e.target.value))}>{Array.from({length:16},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}</select></label><label>{props.t('program')}<input type="number" min="0" max="127" value={program} onChange={e=>setProgram(Number(e.target.value))}/></label><button className="btn primary" disabled={!props.midiStatus.outputOpen} onClick={()=>void props.sendProgramChange(program)}>{props.t('sendProgram')}</button></div>
      </div>
      <div className="instrument-card instrument-log-card">
        <div className="instrument-card-title">{props.t('liveMonitor')}</div>
        <div className="instrument-log">{props.midiLog.length===0?<div className="midi-empty">{props.t('waitingMidi')}</div>:props.midiLog.slice(-24).map((m,i)=><div key={`${i}-${m.hex}`} className="instrument-log-row"><span>{m.direction==='in'?'IN':'OUT'}</span><code>{m.hex}</code><strong>{describeMidi(m.bytes)}</strong><small>{m.port?.name||''}</small></div>)}</div>
      </div>
      <div className="instrument-card">
        <div className="instrument-card-title">{props.t('rawSysex')}</div>
        <div className="sysex-row"><input value={props.sysexHex} onChange={e=>props.setSysexHex(e.target.value)} placeholder="F0 7E 10 06 01 F7"/><button className="btn mini" disabled={!props.midiStatus.outputOpen} onClick={()=>void props.sendSysexHex()}>{props.t('send')}</button></div>
        <div className="instrument-routing"><div><b>{props.t('portSpdIn')}</b><span>CoreMIDI Input · Pad / CC / SysEx → App</span></div><div><b>{props.t('portSpdOut')}</b><span>CoreMIDI Output · Program Change / MIDI / SysEx → SPD-SX</span></div><div><b>{props.t('virtualOut')}</b><span>Virtual MIDI route for Logic Pro or other software.</span></div></div>
      </div>
    </section>
  </main>
}

function RangeEdit({label,value,display,onChange}:{label:string,value:number,display:string,onChange:(v:number)=>void}){return <label className="range-edit"><span>{label}</span><input type="range" min="0" max="1" step="0.001" value={value} onChange={e=>onChange(Number(e.target.value))}/><output>{display}</output></label>}
function PadInspector({pad,onChange,preview,t}:{pad:PadModel|undefined,onChange:(patch:Partial<PadModel>)=>void,preview:()=>void;t:(key:string)=>string}){if(!pad)return <div className="inspector-empty">{t('padEditor')}</div>; return <div className="inspector-content"><div className="inspector-label"><span>{t('padEditor')}</span><strong>{t('pad')} {pad.index===9?t('kick'):pad.index+1}</strong></div><button className="preview-button" onClick={preview} disabled={!pad.waveExists}>▶<span>{t('preview')}</span></button><div className="param-group"><Field label="Wave ID"><input type="number" value={pad.waveId} onChange={e=>onChange({waveId:Number(e.target.value)})}/></Field><Field label="Mute Group"><input type="number" min="0" max="9" value={pad.muteGroup} onChange={e=>onChange({muteGroup:Number(e.target.value)})}/></Field></div><div className="param-group"><Field label="Play Mode"><select value={pad.playMode} onChange={e=>onChange({playMode:Number(e.target.value)})}><option value={-1}>Default</option><option value={0}>One Shot</option><option value={1}>Shot</option><option value={2}>Loop</option></select></Field><Field label="Output"><select value={pad.outputAssign} onChange={e=>onChange({outputAssign:Number(e.target.value)})}><option value={0}>MAIN</option><option value={1}>SUB</option><option value={2}>INDIVIDUAL</option></select></Field></div><div className="param-group"><Field label="Level"><div className="range-row"><input type="range" min="0" max="100" value={pad.waveLevel} onChange={e=>onChange({waveLevel:Number(e.target.value)})}/><output>{pad.waveLevel}</output></div></Field><Field label="Pan"><div className="range-row"><input type="range" min="0" max="30" value={pad.wavePan} onChange={e=>onChange({wavePan:Number(e.target.value)})}/><output>{pad.wavePan===15?'C':pad.wavePan<15?`L${15-pad.wavePan}`:`R${pad.wavePan-15}`}</output></div></Field></div></div>}
function Field({label,children}:{label:string,children:React.ReactNode}){return <label className="field"><span>{label}</span>{children}</label>}
function EmptyState({onOpen,t}:{onOpen:()=>void;t:(key:string)=>string}){return <div className="empty"><div className="empty-mark">SX</div><h1>{t('emptyTitle')}</h1><p>{t('emptyDescription')}</p><button className="btn primary" onClick={onOpen}>{t('openBackup')}</button><div className="empty-note">{t('offline')}</div></div>}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)

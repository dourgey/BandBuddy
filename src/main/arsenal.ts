import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { dialog } from 'electron'
import { z } from 'zod'
import { effectChainSchema, effectStructureKey, trackEffectsSchema, type ArsenalMonitorState, type ArsenalPreset, type ArsenalState, type EffectChainSnapshot, type MonitorMode, type PreparedEffects, type ToneAsset, type TrackEffects } from '@shared/arsenal.js'
import type { BandBuddyDatabase } from './database.js'
import type { AppPaths } from './paths.js'
import type { MediaService } from './media.js'
import type { AudioHostClient } from './audio-host.js'
import type { RecordingService } from './recording.js'
import { runProcess } from './process.js'

const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
export function decodeIr(bytes: Buffer): { channels: number[][]; sampleRate: number } {
  if (bytes.length < 44 || bytes.toString('ascii',0,4)!=='RIFF' || bytes.toString('ascii',8,12)!=='WAVE') throw new Error('请选择有效的 WAV 箱体 IR')
  let format=0, channels=0, rate=0, bits=0, data: Buffer | null=null
  for(let p=12;p+8<=bytes.length;) {
    const key=bytes.toString('ascii',p,p+4),size=bytes.readUInt32LE(p+4),start=p+8
    if(start+size>bytes.length) throw new Error('IR 文件不完整')
    if(key==='fmt ' && size>=16) {format=bytes.readUInt16LE(start);channels=bytes.readUInt16LE(start+2);rate=bytes.readUInt32LE(start+4);bits=bytes.readUInt16LE(start+14);if(format===65534 && size>=40) format=bytes.readUInt16LE(start+24)}
    if(key==='data') data=bytes.subarray(start,start+size)
    p=start+size+(size%2)
  }
  if(!data || ![1,2].includes(channels) || rate<8000 || rate>192000 || !((format===1 && [16,24,32].includes(bits)) || (format===3 && bits===32))) throw new Error('IR 需要单声道或立体声 PCM/Float WAV，8–192 kHz')
  const frames=data.length/(bits/8*channels)
  if(!Number.isInteger(frames) || frames<1 || frames>rate*2) throw new Error('箱体 IR 长度必须大于 0 且不超过 2 秒')
  const result=Array.from({length:channels},()=>new Array<number>(frames))
  for(let i=0;i<frames;++i) for(let c=0;c<channels;++c) {const p=(i*channels+c)*bits/8;const v=format===3?data.readFloatLE(p):bits===16?data.readInt16LE(p)/32768:bits===24?data.readIntLE(p,3)/8388608:data.readInt32LE(p)/2147483648;if(!Number.isFinite(v)) throw new Error('IR 包含无效采样');result[c]![i]=v}
  return {channels:result,sampleRate:rate}
}
export class ArsenalService {
  private readonly root: string
  private state: ArsenalMonitorState={active:false,mode:'off',sampleRate:0,bufferFrames:0,latencyMs:0,peak:[],outputPeak:0,xruns:0,error:null}
  private structure=''
  private busy: Promise<unknown> = Promise.resolve()
  private trackStructure = new Map<string,string>()
  constructor(private paths:AppPaths,private db:BandBuddyDatabase,private media:MediaService,private host:AudioHostClient,private recording:RecordingService,private emit:(s:ArsenalMonitorState)=>void,private changed:()=>void,private occupied:()=>boolean) {
    this.root=path.join(paths.dataRoot,'arsenal')
    host.onEvent(e=>{if(!this.state.active)return;if(e.event==='meter'){this.state={...this.state,peak:e.data.peak,outputPeak:e.data.outputPeak??0,xruns:e.data.xruns};this.emit(this.state)}else if(e.event==='error'||e.event==='crashed'){this.state={...this.state,active:false,mode:'off',error:e.data.error};this.emit(this.state)}})
  }
  list(): ArsenalState {return {assets:this.db.sqlite.prepare('SELECT json FROM tone_assets ORDER BY created_at DESC').all().map((r:any)=>JSON.parse(r.json)),presets:this.db.sqlite.prepare('SELECT json FROM arsenal_presets ORDER BY updated_at DESC').all().map((r:any)=>JSON.parse(r.json))}}
  private asset(id:string):ToneAsset {const row=this.db.sqlite.prepare('SELECT json FROM tone_assets WHERE id=?').get(id) as {json:string}|undefined;if(!row)throw new Error(`音色资源缺失：${id}`);return JSON.parse(row.json)}
  private file(a:ToneAsset):string {return path.join(this.root,`${a.id}.${a.kind==='nam'?'nam':'wav'}`)}
  async importAsset(kind:'nam'|'ir',sampleRate?:number):Promise<ToneAsset|null> {
    const result=await dialog.showOpenDialog({title:kind==='nam'?'导入 NAM 音色':'导入箱体 IR',properties:['openFile'],filters:[{name:kind==='nam'?'NAM':'WAV',extensions:[kind==='nam'?'nam':'wav']}]})
    if(result.canceled || !result.filePaths[0])return null
    const file=result.filePaths[0];if((await stat(file)).size>64*1024*1024)throw new Error('文件超过 64 MB 导入上限')
    const bytes=await readFile(file), id=hash(bytes),old=this.list().assets.find(a=>a.id===id);if(old)return old
    const item:ToneAsset={id,kind,name:path.basename(file,path.extname(file)),sampleRate:0,channels:1,durationMs:0,metadata:{},createdAt:new Date().toISOString()}
    if(kind==='nam') {
      let model:any;try{model=JSON.parse(bytes.toString('utf8'))}catch{throw new Error('NAM 文件不是有效 JSON')}
      if(!model || typeof model.architecture!=='string' || !Array.isArray(model.weights) || !model.weights.length || model.weights.some((x:unknown)=>typeof x!=='number'||!Number.isFinite(x)) || !model.config)throw new Error('NAM 模型结构无效')
      item.sampleRate=Number(model.sample_rate || sampleRate);if(!Number.isFinite(item.sampleRate)||item.sampleRate<8000||item.sampleRate>192000)throw new Error('NAM 缺少训练采样率，请在导入旁选择正确的采样率后重试')
      item.architecture=model.architecture;item.metadata=model.metadata??{};item.slimmable=model.architecture.toLowerCase().includes('slim') || Boolean(model.config?.slimmable)
    }else {const ir=decodeIr(bytes);item.sampleRate=ir.sampleRate;item.channels=ir.channels.length;item.durationMs=ir.channels[0]!.length/ir.sampleRate*1000}
    await mkdir(this.root,{recursive:true});const destination=this.file(item);await writeFile(`${destination}.part`,bytes);await rename(`${destination}.part`,destination)
    this.db.sqlite.prepare('INSERT INTO tone_assets(id,json,created_at) VALUES(?,?,?)').run(id,JSON.stringify(item),item.createdAt)
    return item
  }
  savePreset(input:{id?:string;name:string;chain:EffectChainSnapshot}):ArsenalPreset {
    const chain=effectChainSchema.parse(input.chain);this.validateReferences(chain)
    const old=input.id?this.list().presets.find(p=>p.id===input.id):undefined
    if(input.id&&!old)throw new Error('预设不存在')
    const now=new Date().toISOString(),preset:ArsenalPreset={id:old?.id??randomUUID(),name:z.string().trim().min(1).max(100).parse(input.name),chain,revision:(old?.revision??0)+1,createdAt:old?.createdAt??now,updatedAt:now}
    this.db.sqlite.prepare('INSERT INTO arsenal_presets(id,json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at').run(preset.id,JSON.stringify(preset),now);return preset
  }
  deletePreset(id:string):void {this.db.sqlite.prepare('DELETE FROM arsenal_presets WHERE id=?').run(id)}
  async deleteAsset(id:string):Promise<void> {
    const asset=this.asset(id)
    const refs=[...this.list().presets.map(p=>JSON.stringify(p.chain)),...this.db.sqlite.prepare('SELECT effects_json AS json FROM recording_tracks WHERE effects_json IS NOT NULL UNION ALL SELECT effects_snapshot_json AS json FROM recording_takes WHERE effects_snapshot_json IS NOT NULL').all().map((r:any)=>r.json)]
    if(refs.some(r=>r.includes(id))||this.state.active)throw new Error('资源正在被预设、录音或监听引用，不能删除')
    this.db.sqlite.prepare('DELETE FROM tone_assets WHERE id=?').run(id);await rm(this.file(asset),{force:true})
  }
  private validateReferences(chain:EffectChainSnapshot):void {for(const [type,id] of [['nam',chain.amp.assetId],['ir',chain.cab.assetId]] as const)if(id&&this.asset(id).kind!==type)throw new Error('音色资源类型不匹配');if(chain.amp.enabled&&!chain.amp.assetId)throw new Error('请先选择 NAM 模型');if(chain.cab.enabled&&!chain.cab.assetId)throw new Error('请先选择箱体 IR')}
  async prepare(input:EffectChainSnapshot):Promise<PreparedEffects> {
    const chain=effectChainSchema.parse(input);this.validateReferences(chain)
    const model=chain.amp.assetId?this.asset(chain.amp.assetId):null,ir=chain.cab.assetId?this.asset(chain.cab.assetId):null
    return {chain,model:model?await readFile(this.file(model),'utf8'):null,modelRate:model?.sampleRate??48000,ir:ir?decodeIr(await readFile(this.file(ir))).channels:null,irRate:ir?.sampleRate??48000}
  }
  async setTrack(trackId:string,input:TrackEffects):Promise<void> {
    const effects=trackEffectsSchema.parse(input);this.validateReferences(effects.chain)
    if(!this.db.getRecordingTrack(trackId))throw new Error('录音轨不存在')
    if(this.recording.getState().recordingTrackId===trackId && this.recording.isActive()) {
      const structure=effectStructureKey(effects.chain)
      await this.host.setEffects({mode:effects.monitorMode==='off'?0:effects.monitorMode==='dry'||!effects.enabled?1:2,...(this.trackStructure.get(trackId)===structure?{chain:effects.chain}:{prepared:await this.prepare(effects.chain)})});this.trackStructure.set(trackId,structure)
    }
    this.db.sqlite.prepare('UPDATE recording_tracks SET effects_json=?,updated_at=? WHERE id=?').run(JSON.stringify(effects),new Date().toISOString(),trackId);this.changed()
  }
  monitorState():ArsenalMonitorState{return this.state}
  async stopMonitor():Promise<void> {if(!this.state.active)return;await this.host.stopTest();this.state={...this.state,active:false,mode:'off',peak:[],outputPeak:0};this.emit(this.state)}
  monitor(mode:MonitorMode,chain:EffectChainSnapshot):Promise<ArsenalMonitorState> {
    const next=this.busy.catch(()=>undefined).then(async()=>{
      if(mode==='off'){await this.stopMonitor();return this.state}
      if(this.recording.isActive()||this.occupied())throw new Error('录音或设备测试进行中，请使用录音轨监听控制')
      const prepared=await this.prepare(chain),structure=effectStructureKey(chain)
      if(this.state.active) {await this.host.setEffects({mode:mode==='dry'?1:2,...(structure===this.structure?{chain}:{prepared})});this.state={...this.state,mode}}
      else {const config=await this.recording.arsenalDeviceConfiguration();const result=await this.host.startTest({...config,monitorMode:mode==='dry'?1:2,monitorGainDb:0,effects:prepared});this.state={...this.state,...result,active:true,mode,error:null}}
      this.structure=structure;this.emit(this.state);return this.state
    });this.busy=next;return next
  }
  async render(source:string,effects:TrackEffects|undefined|null,signal:AbortSignal,tailSeconds=0):Promise<string> {
    if(!effects?.enabled)return source
    const prepared=await this.prepare(effects.chain),sourceHash=hash(await readFile(source)),key=hash(JSON.stringify([sourceHash,prepared,tailSeconds,'bb-dsp-1-nam-0.5.4']))
    const root=path.join(this.paths.cacheRoot,'arsenal');await mkdir(root,{recursive:true});const target=path.join(root,`${key}.wav`)
    try{await stat(target);return target}catch{}
    const unique=path.join(root,`${key}-${randomUUID()}`),input=`${unique}.input.wav`,output=`${unique}.output.wav`,manifest=`${unique}.json`
    try {
      const ffmpeg=this.media.tool('ffmpeg');if(!ffmpeg)throw new Error('FFMPEG_MISSING')
      const decode=await runProcess(ffmpeg,['-y','-v','error','-i',source,'-ar','48000','-ac','2','-c:a','pcm_f32le',input],{signal});if(decode.code)throw new Error(decode.stderr)
      await writeFile(manifest,JSON.stringify({input,output,prepared,tailSeconds}))
      const result=await runProcess(this.paths.audioHostExecutable(),['--render-effects',manifest],{signal});if(result.code)throw new Error(`湿声渲染失败：${result.stderr}`)
      if(signal.aborted)throw new Error('EXPORT_CANCELLED');await rename(output,target);return target
    } finally {await Promise.all([input,output,manifest].map(p=>rm(p,{force:true})))}
  }
}

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm, stat, copyFile } from 'node:fs/promises'
import { createReadStream, existsSync, readFileSync, statSync, openSync, readSync, writeSync, closeSync, ftruncateSync } from 'node:fs'
import path from 'node:path'
import { dialog } from 'electron'
import { z } from 'zod'
import { createEffectModule, moduleChain, storeEffectChain, effectChainSchema, effectStructureKey, trackEffectsSchema, type ArsenalCommand, type ArsenalWorkspace, type ArsenalTake, type ArsenalMonitorState, type ArsenalPreset, type ArsenalState, type EffectChainSnapshot, type MonitorMode, type PreparedEffects, type ToneAsset, type TrackEffects } from '@shared/arsenal.js'
import { factoryPresets } from '@shared/effect-catalog.js'
import type { BandBuddyDatabase } from './database.js'
import type { AppPaths } from './paths.js'
import type { MediaService } from './media.js'
import type { AudioHostClient } from './audio-host.js'
import type { RecordingService } from './recording.js'
import { runProcess } from './process.js'
import { decodeNam } from './nam.js'

const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
async function hashFile(file:string):Promise<string>{const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk as Buffer);return h.digest('hex')}
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
  private decodedAssets = new Map<string,{model?:string;ir?:number[][]}>()
  private workspace: ArsenalWorkspace = {draft:null,takes:[],quick:{recording:false,looping:false,durationMs:0}}
  private currentTake: ArsenalTake | null = null
  constructor(private paths:AppPaths,private db:BandBuddyDatabase,private media:MediaService,private host:AudioHostClient,private recording:RecordingService,private emit:(s:ArsenalMonitorState)=>void,private changed:()=>void,private occupied:()=>boolean) {
    this.root=path.join(paths.dataRoot,'arsenal')
    try {const saved=JSON.parse(readFileSync(path.join(this.root,'workspace.json'),'utf8'));this.workspace.favorites=saved.favorites??[];this.workspace.draft=saved.draft?{...saved.draft,chain:effectChainSchema.parse(saved.draft.chain)}:null;this.workspace.takes=(saved.takes??[]).map((t:ArsenalTake)=>({...t,chain:effectChainSchema.parse(t.chain)}));if(saved.pending){const t=saved.pending as ArsenalTake;const file=path.join(this.root,`${t.id}.dry.wav`);if(existsSync(file)){this.workspace.takes.unshift(this.recoverTake(t));}}}catch { /* A first launch has no workspace. Existing audio files remain untouched. */ }
    host.onEvent(e=>{if(!this.state.active)return;if(e.event==='meter'){this.state={...this.state,peak:e.data.peak,outputPeak:e.data.outputPeak??0,xruns:e.data.xruns,tunerActive:e.data.tunerActive,tunerHz:e.data.tunerHz,dspLoad:e.data.dspLoad,dspLatencyMs:e.data.dspLatencyMs};this.emit(this.state)}else if(e.event==='error'||e.event==='crashed'){this.state={...this.state,active:false,mode:'off',error:e.data.error};this.workspace.quick={recording:false,looping:false,durationMs:0};if(this.currentTake){const pending=this.currentTake;this.currentTake=null;const recovery=this.busy.catch(()=>undefined).then(async()=>{this.workspace.takes.unshift(this.recoverTake(pending));await this.persistWorkspace()});this.busy=recovery;void recovery.catch(()=>undefined)}this.emit(this.state)}})
  }
  list(): ArsenalState {
    const assets = this.db.sqlite.prepare('SELECT json FROM tone_assets ORDER BY created_at DESC').all() as { json: string }[]
    const presets = this.db.sqlite.prepare('SELECT json FROM arsenal_presets ORDER BY updated_at DESC').all() as { json: string }[]
    return {
      assets: assets.map(row => JSON.parse(row.json)),
      presets: [...presets.map(row => {
        const preset = JSON.parse(row.json) as ArsenalPreset
        return { ...preset, chain: effectChainSchema.parse(preset.chain) }
      }), ...factoryPresets()].map(p=>({...p,favorite:this.workspace.favorites?.includes(p.id)??p.favorite}))
    }
  }
  private asset(id:string):ToneAsset {const row=this.db.sqlite.prepare('SELECT json FROM tone_assets WHERE id=?').get(id) as {json:string}|undefined;if(!row)throw new Error(`音色资源缺失：${id}`);return JSON.parse(row.json)}
  private file(a:ToneAsset):string {return path.join(this.root,`${a.id}.${a.kind==='nam'?'nam':'wav'}`)}
  async importAsset(kind:'nam'|'ir',sampleRate?:number):Promise<ToneAsset|null> {
    const result=await dialog.showOpenDialog({title:kind==='nam'?'导入 NAM 音色':'导入箱体 IR',properties:['openFile','multiSelections'],filters:[{name:kind==='nam'?'NAM':'WAV',extensions:kind==='nam'?['nam','nam2']:['wav']}]})
    if(result.canceled || !result.filePaths[0])return null
    let first:ToneAsset|null=null;const failures:string[]=[];for(const file of result.filePaths){try{const item=await this.importFile(kind,file,sampleRate);first??=item}catch(e){failures.push(`${path.basename(file)}：${e instanceof Error?e.message:String(e)}`)}}if(failures.length)throw new Error(`已导入 ${result.filePaths.length-failures.length} 个，${failures.length} 个未导入\n${failures.join('\n')}`);return first
  }
  private async importFile(kind:'nam'|'ir',file:string,sampleRate?:number):Promise<ToneAsset> {
    if((await stat(file)).size>64*1024*1024)throw new Error('文件超过 64 MB 导入上限')
    const bytes=await readFile(file), id=hash(bytes),old=this.list().assets.find(a=>a.id===id);if(old)return old
    const item:ToneAsset={id,kind,name:path.basename(file,path.extname(file)),sampleRate:0,channels:1,durationMs:0,metadata:{},createdAt:new Date().toISOString()}
    if(kind==='nam') {
      Object.assign(item,decodeNam(bytes,sampleRate))
      const m=createEffectModule('amp');m.settings.amp.engine='nam';const chain=moduleChain(m),manifest=path.join(this.root,`${randomUUID()}.validate.json`);await mkdir(this.root,{recursive:true});try{await writeFile(manifest,JSON.stringify({sampleRate:item.sampleRate,prepared:{chain,model:bytes.toString('utf8'),modelRate:item.sampleRate,ir:null,irRate:48000}}));const check=await runProcess(this.paths.audioHostExecutable(),['--validate-effects',manifest]);if(check.code)throw new Error(`当前引擎无法加载此模型：${check.stderr}`)}finally{await rm(manifest,{force:true})}
    }else {const ir=decodeIr(bytes);item.sampleRate=ir.sampleRate;item.channels=ir.channels.length;item.durationMs=ir.channels[0]!.length/ir.sampleRate*1000}
    await mkdir(this.root,{recursive:true});const destination=this.file(item);await writeFile(`${destination}.part`,bytes);await rename(`${destination}.part`,destination)
    this.db.sqlite.prepare('INSERT INTO tone_assets(id,json,created_at) VALUES(?,?,?)').run(id,JSON.stringify(item),item.createdAt)
    return item
  }
  savePreset(input:{id?:string;name:string;chain:EffectChainSnapshot;tags?:string[];favorite?:boolean}):ArsenalPreset {
    const chain=effectChainSchema.parse(input.chain);this.validateReferences(chain)
    const old=input.id?this.list().presets.find(p=>p.id===input.id):undefined
    if(input.id&&!old)throw new Error('预设不存在')
    const now=new Date().toISOString(),preset:ArsenalPreset={id:old&&!old.factory?old.id:randomUUID(),name:z.string().trim().min(1).max(100).parse(input.name),chain,revision:old&&!old.factory?old.revision+1:1,createdAt:old?.createdAt??now,updatedAt:now,tags:input.tags??old?.tags??[],favorite:input.favorite??old?.favorite??false}
    this.db.sqlite.prepare('INSERT INTO arsenal_presets(id,json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at').run(preset.id,JSON.stringify({...preset,chain:storeEffectChain(chain)}),now);return preset
  }
  deletePreset(id:string):void {this.db.sqlite.prepare('DELETE FROM arsenal_presets WHERE id=?').run(id)}
  async deleteAsset(id:string):Promise<void> {
    const asset=this.asset(id)
    const refs=[...this.list().presets.map(p=>JSON.stringify(p.chain)),...this.db.sqlite.prepare('SELECT effects_json AS json FROM recording_tracks WHERE effects_json IS NOT NULL UNION ALL SELECT effects_snapshot_json AS json FROM recording_takes WHERE effects_snapshot_json IS NOT NULL').all().map((r:any)=>r.json)]
    refs.push(JSON.stringify(this.workspace),JSON.stringify(this.currentTake))
    if(refs.some(r=>r.includes(id))||this.state.active)throw new Error('资源正在被预设、草稿、录音或监听引用，不能删除')
    this.db.sqlite.prepare('DELETE FROM tone_assets WHERE id=?').run(id);await rm(this.file(asset),{force:true})
  }
  private validateReferences(chain:EffectChainSnapshot):void {if(chain.modules){for(const module of chain.modules)this.validateReferences(moduleChain(module));return;}for(const [type,id] of [['nam',chain.amp.assetId],['ir',chain.cab.assetId],['ir',chain.cab.secondaryAssetId]] as const)if(id&&this.asset(id).kind!==type)throw new Error('音色资源类型不匹配');if(chain.amp.enabled&&chain.amp.engine==='nam'&&!chain.amp.assetId)throw new Error('请先选择 NAM 模型');if(chain.cab.enabled&&chain.cab.engine==='ir'&&!chain.cab.assetId)throw new Error('请先选择箱体 IR')}
  private async decoded(asset:ToneAsset):Promise<{model?:string;ir?:number[][]}>{
    const old=this.decodedAssets.get(asset.id);if(old)return old
    const bytes=await readFile(this.file(asset)),value=asset.kind==='nam'?{model:bytes.toString('utf8')}:{ir:decodeIr(bytes).channels}
    const cost=(v:{model?:string;ir?:number[][]}):number=>(v.model?.length??0)*2+(v.ir?.reduce((sum,c)=>sum+c.length*8,0)??0),limit=64*1024*1024
    if(cost(value)>limit)return value
    while(this.decodedAssets.size&&(this.decodedAssets.size>=12||[...this.decodedAssets.values()].reduce((sum,v)=>sum+cost(v),cost(value))>limit))this.decodedAssets.delete(this.decodedAssets.keys().next().value!)
    this.decodedAssets.set(asset.id,value);return value
  }
  async prepare(input:EffectChainSnapshot):Promise<PreparedEffects> {
    const chain=effectChainSchema.parse(input);this.validateReferences(chain)
    if (chain.modules) return { chain, modules: await Promise.all(chain.modules.map(m => this.prepare(moduleChain(m)))), model: null, modelRate: 48000, ir: null, irRate: 48000 }
    const model=chain.order.includes('amp')&&chain.amp.engine==='nam'&&chain.amp.assetId?this.asset(chain.amp.assetId):null,ir=(chain.order.includes('cab')||chain.order.includes('amp'))&&chain.cab.engine==='ir'&&chain.cab.assetId?this.asset(chain.cab.assetId):null
    const secondary=chain.order.includes('cab')&&chain.cab.engine==='ir'&&chain.cab.secondaryAssetId?this.asset(chain.cab.secondaryAssetId):null
    let namInputGain=1,namOutputGain=1
    if(model&&chain.amp.calibration){const input=model.metadata.input_level_dbu;if(chain.amp.inputDbU===null||typeof input!=='number')throw new Error('模型或声卡缺少输入标定值');namInputGain=10**((chain.amp.inputDbU-input)/20)}
    if(model&&chain.amp.outputMode==='calibrated'){const output=model.metadata.output_level_dbu;if(chain.amp.outputDbU===null||typeof output!=='number')throw new Error('模型或声卡缺少输出标定值');namOutputGain=10**((output-chain.amp.outputDbU)/20)}
    if(model&&chain.amp.outputMode==='normalized'){const loudness=model.metadata.loudness;if(typeof loudness!=='number'||!Number.isFinite(loudness))throw new Error('模型没有响度元数据');namOutputGain=10**((-18-loudness)/20)}
    return {chain,model:model?(await this.decoded(model)).model!:null,modelRate:model?.sampleRate??48000,ir:ir?(await this.decoded(ir)).ir!:null,irRate:ir?.sampleRate??48000,secondaryIr:secondary?(await this.decoded(secondary)).ir!:null,secondaryIrRate:secondary?.sampleRate??48000,namInputGain,namOutputGain}
  }
  async setTrack(trackId:string,input:TrackEffects):Promise<void> {
    const effects=trackEffectsSchema.parse(input);this.validateReferences(effects.chain)
    if(!this.db.getRecordingTrack(trackId))throw new Error('录音轨不存在')
    if(this.recording.getState().recordingTrackId===trackId && this.recording.isActive()) {
      const structure=effectStructureKey(effects.chain)
      await this.host.setEffects({mode:effects.monitorMode==='off'?0:effects.monitorMode==='dry'||!effects.enabled?1:2,...(this.trackStructure.get(trackId)===structure?{chain:effects.chain}:{prepared:await this.prepare(effects.chain)})});this.trackStructure.set(trackId,structure)
    }
    this.db.sqlite.prepare('UPDATE recording_tracks SET effects_json=?,updated_at=? WHERE id=?').run(JSON.stringify({...effects,chain:storeEffectChain(effects.chain)}),new Date().toISOString(),trackId);this.changed()
  }
  private async updateLive(params:Record<string,unknown>):Promise<void>{
    for(let attempt=0;;attempt++){try{await this.host.setEffects(params);return}catch(e){if(attempt>=5||!String(e).includes('EFFECT_CHAIN_LOADING'))throw e;await new Promise(resolve=>setTimeout(resolve,20))}}
  }
  monitorState():ArsenalMonitorState{return this.state}
  async feed(input:{bus:number;sampleRate:number;samples:number[];reset?:boolean}):Promise<boolean>{if(!this.state.active)return false;return this.host.arsenalPcm(input)}
  private recoverTake(t:ArsenalTake):ArsenalTake {
    const file=this.takeFile(t.id),size=statSync(file).size,fd=openSync(file,'r+');let durationMs=0
    try{const header=Buffer.alloc(44);readSync(fd,header,0,44,0);if(header.toString('ascii',0,4)!=='RIFF'||header.toString('ascii',36,40)!=='data')throw new Error('快录文件头无效');const channels=header.readUInt16LE(22),rate=header.readUInt32LE(24);if(![1,2].includes(channels)||rate<8000)throw new Error('快录格式无效');const bytes=Math.max(0,Math.floor((size-44)/(4*channels))*4*channels);header.writeUInt32LE(36+bytes,4);header.writeUInt32LE(bytes,40);writeSync(fd,header,0,44,0);ftruncateSync(fd,44+bytes);durationMs=bytes/(4*channels*rate)*1000}finally{closeSync(fd)}
    return {...t,chain:effectChainSchema.parse(t.chain),durationMs,recovered:true}
  }
  private async persistWorkspace():Promise<void> {
    await mkdir(this.root,{recursive:true})
    const compact=(t:ArsenalTake)=>({...t,chain:storeEffectChain(t.chain)})
    const value={favorites:this.workspace.favorites??[],draft:this.workspace.draft?{...this.workspace.draft,chain:storeEffectChain(this.workspace.draft.chain)}:null,takes:this.workspace.takes.map(compact),pending:this.currentTake?compact(this.currentTake):null}
    const file=path.join(this.root,'workspace.json'),temp=`${file}.${randomUUID()}.part`
    await writeFile(temp,JSON.stringify(value));await rename(temp,file)
  }
  private takeFile(id:string):string {return path.join(this.root,`${z.string().uuid().parse(id)}.dry.wav`)}
  private async finishQuickTake():Promise<void> {
    if(!this.currentTake)return
    let result:Awaited<ReturnType<AudioHostClient['arsenalQuick']>>
    try{result=await this.host.arsenalQuick({action:'stopRecord'})}catch(e){const pending=this.currentTake;this.currentTake=null;this.workspace.quick={recording:false,looping:false,durationMs:0};try{this.workspace.takes.unshift(this.recoverTake(pending));await this.persistWorkspace()}catch{}throw e}
    this.workspace.takes.unshift({...this.currentTake,durationMs:result.durationMs,sampleRate:result.sampleRate,channels:result.channels})
    this.currentTake=null;this.workspace.quick={recording:false,looping:false,durationMs:result.durationMs};await this.persistWorkspace()
  }
  command(input:ArsenalCommand):Promise<ArsenalWorkspace> {
    const next=this.busy.catch(()=>undefined).then(async()=>{
      switch(input.action){
        case 'favorite':this.workspace.favorites=[...(this.workspace.favorites??[]).filter(id=>id!==input.id),...(input.value?[z.string().uuid().parse(input.id)]:[])];await this.persistWorkspace();break
        case 'tuner':await this.host.arsenalQuick({action:'tuner',enabled:z.boolean().parse(input.enabled)});break
        case 'workspace':if(this.state.active)this.workspace.quick=await this.host.arsenalQuick({action:'state'});break
        case 'draft':this.workspace.draft={...input.draft,name:z.string().max(100).parse(input.draft.name),chain:effectChainSchema.parse(input.draft.chain)};await this.persistWorkspace();break
        case 'record': {
          if(this.currentTake)throw new Error('快录已开始')
          if(!this.state.active)throw new Error('请先启动监听')
          const chain=effectChainSchema.parse(input.chain);this.validateReferences(chain)
          this.currentTake={id:randomUUID(),name:z.string().trim().min(1).max(100).parse(input.name),createdAt:new Date().toISOString(),durationMs:0,sampleRate:this.state.sampleRate,channels:1,chain}
          const config=await this.recording.arsenalDeviceConfiguration();this.currentTake.channels=Array.isArray(config.inputChannels)?config.inputChannels.length:1
          await this.persistWorkspace()
          try{this.workspace.quick=await this.host.arsenalQuick({action:'record',path:this.takeFile(this.currentTake.id)});this.currentTake.channels=(this.workspace.quick as {channels?:number}).channels??1;await this.persistWorkspace()}catch(e){this.currentTake=null;await this.persistWorkspace();throw e}break
        }
        case 'stopRecord':await this.finishQuickTake();break
        case 'stopLoop':if(this.state.active)this.workspace.quick=await this.host.arsenalQuick({action:'stopLoop'});break
        case 'loop':{
          const take=this.workspace.takes.find(t=>t.id===input.id);if(!take)throw new Error('录音不存在')
          const start=z.number().min(0).max(take.durationMs).parse(input.startMs),end=z.number().min(start+50).max(Math.min(take.durationMs,start+60000)).parse(input.endMs)
          if(!this.state.active)throw new Error('请先启动监听')
          const output=path.join(this.root,'loop.wav'),ffmpeg=await this.media.tool('ffmpeg');if(!ffmpeg)throw new Error('FFMPEG_MISSING')
          const result=await runProcess(ffmpeg,['-y','-v','error','-ss',String(start/1000),'-i',this.takeFile(take.id),'-t',String((end-start)/1000),'-ar',String(this.state.sampleRate),'-ac','2','-c:a','pcm_f32le',output])
          if(result.code)throw new Error(result.stderr)
          this.workspace.quick=await this.host.arsenalQuick({action:'loop',path:output});break
        }
        case 'exportTake':{
          const take=this.workspace.takes.find(t=>t.id===input.id);if(!take)throw new Error('录音不存在')
          const result=await dialog.showSaveDialog({title:input.wet?'导出效果声音':'导出原始 DI',defaultPath:`${take.name}${input.wet?'-wet':'-DI'}.wav`,filters:[{name:'WAV',extensions:['wav']}]});if(result.canceled||!result.filePath)break
          const source=input.wet?await this.render(this.takeFile(take.id),{enabled:true,presetId:null,monitorMode:'wet',chain:effectChainSchema.parse(input.chain??take.chain)},new AbortController().signal,5):this.takeFile(take.id)
          await copyFile(source,result.filePath);break
        }
        case 'deleteTake':{
          if(this.workspace.quick.looping)throw new Error('请先停止 DI 循环')
          const file=this.takeFile(input.id);this.workspace.takes=this.workspace.takes.filter(t=>t.id!==input.id);await this.persistWorkspace();await rm(file,{force:true});break
        }
        case 'exportPreset':{
          const result=await dialog.showSaveDialog({title:'导出预设',defaultPath:`${input.preset.name}.bbtone`,filters:[{name:'BandBuddy 音色',extensions:['bbtone']}]});if(!result.canceled&&result.filePath)await writeFile(result.filePath,JSON.stringify({format:'bandbuddy-tone',version:1,name:input.preset.name,tags:input.preset.tags??[],chain:storeEffectChain(input.preset.chain)},null,2));break
        }
        case 'importPreset':{
          const result=await dialog.showOpenDialog({title:'导入预设',properties:['openFile'],filters:[{name:'BandBuddy 音色',extensions:['bbtone','json']}]});if(result.canceled||!result.filePaths[0])break
          if((await stat(result.filePaths[0])).size>2*1024*1024)throw new Error('预设文件超过 2 MB')
          const data=z.object({format:z.literal('bandbuddy-tone'),version:z.literal(1),name:z.string().max(100),tags:z.array(z.string().max(30)).max(20).optional(),chain:effectChainSchema}).parse(JSON.parse(await readFile(result.filePaths[0],'utf8')))
          this.savePreset(data);break
        }
        case 'asset':{
          const old=this.asset(input.id);const edit=z.object({name:z.string().trim().min(1).max(100),tags:z.array(z.string().max(30)).max(20),role:z.enum(['amp','pedal','rig','unknown']),favorite:z.boolean(),notes:z.string().max(2000)}).parse(input)
          this.db.sqlite.prepare('UPDATE tone_assets SET json=? WHERE id=?').run(JSON.stringify({...old,...edit}),old.id);break
        }
      }
      return structuredClone(this.workspace)
    });this.busy=next;return next
  }
  stopMonitor():Promise<void> {const next=this.busy.catch(()=>undefined).then(()=>this.stopMonitorNow());this.busy=next;return next}
  private async stopMonitorNow():Promise<void> {
    if(!this.state.active)return
    let failure:unknown
    if(this.currentTake)try{await this.finishQuickTake()}catch(e){failure=e}
    await this.host.stopTest();this.workspace.quick={recording:false,looping:false,durationMs:0}
    this.state={...this.state,active:false,mode:'off',peak:[],outputPeak:0,tunerActive:false,error:failure?String(failure):null};this.emit(this.state)
    if(failure)throw failure
  }
  monitor(mode:MonitorMode,chain:EffectChainSnapshot):Promise<ArsenalMonitorState> {
    const next=this.busy.catch(()=>undefined).then(async()=>{
      if(mode==='off'){await this.stopMonitorNow();return this.state}
      if(this.recording.isActive()||this.occupied())throw new Error('录音或设备测试进行中，请使用录音轨监听控制')
      chain=effectChainSchema.parse(chain);this.validateReferences(chain)
      const structure=effectStructureKey(chain)
      if(this.state.active) {await this.updateLive({mode:mode==='dry'?1:2,...(structure===this.structure?{chain}:{prepared:await this.prepare(chain)})});this.state={...this.state,mode}}
      else {const config=await this.recording.arsenalDeviceConfiguration();const result=await this.host.startTest({...config,monitorMode:mode==='dry'?1:2,monitorGainDb:0,effects:await this.prepare(chain)});this.state={...this.state,...result,active:true,mode,error:null}}
      this.structure=structure;this.emit(this.state);return this.state
    });this.busy=next;return next
  }
  async render(source:string,effects:TrackEffects|undefined|null,signal:AbortSignal,tailSeconds=0):Promise<string> {
    if(!effects?.enabled)return source
    const prepared=await this.prepare(effects.chain),sourceHash=await hashFile(source),key=hash(JSON.stringify([sourceHash,prepared,tailSeconds,'bb-dsp-4-modular']))
    const root=path.join(this.paths.cacheRoot,'arsenal');await mkdir(root,{recursive:true});const target=path.join(root,`${key}.wav`)
    try{await stat(target);return target}catch{}
    const unique=path.join(root,`${key}-${randomUUID()}`),input=`${unique}.input.wav`,output=`${unique}.output.wav`,manifest=`${unique}.json`
    try {
      const ffmpeg=await this.media.tool('ffmpeg');if(!ffmpeg)throw new Error('FFMPEG_MISSING')
      const decode=await runProcess(ffmpeg,['-y','-v','error','-i',source,'-ar','48000','-ac','2','-c:a','pcm_f32le',input],{signal});if(decode.code)throw new Error(decode.stderr)
      await writeFile(manifest,JSON.stringify({input,output,prepared,tailSeconds}))
      const result=await runProcess(this.paths.audioHostExecutable(),['--render-effects',manifest],{signal});if(result.code)throw new Error(`湿声渲染失败：${result.stderr}`)
      if(signal.aborted)throw new Error('EXPORT_CANCELLED');await rename(output,target);return target
    } finally {await Promise.all([input,output,manifest].map(p=>rm(p,{force:true})))}
  }
}

import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultEffectChain, effectChainSchema, storeEffectChain, chainModules, createEffectModule } from '@shared/arsenal.js'
import { effectDefinition, changeModuleParameter, factoryPresets } from '@shared/effect-catalog.js'
import { ArsenalService } from '../src/main/arsenal.js'
vi.mock('electron',()=>({dialog:{}}))
let root:string,sqlite:DatabaseSync
beforeEach(async()=>{root=await mkdtemp(path.join(tmpdir(),'bb-workstation-'));sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE arsenal_presets(id TEXT PRIMARY KEY,json TEXT,updated_at TEXT);CREATE TABLE tone_assets(id TEXT PRIMARY KEY,json TEXT,created_at TEXT)')})
afterEach(async()=>{sqlite.close();await rm(root,{recursive:true,force:true})})
function service(){return new ArsenalService({dataRoot:root} as never,{sqlite} as never,{} as never,{onEvent:vi.fn()} as never,{} as never,vi.fn(),vi.fn(),()=>false)}
it('roundtrips old chains into compact modules without changing algorithms or audible settings',()=>{
 const old=defaultEffectChain();old.drive.enabled=true;old.drive.drive=.72;old.eq.enabled=true;old.eq.bands[3]=4
 const compact=storeEffectChain(old),restored=effectChainSchema.parse(compact)
 expect(compact.version).toBe(2);expect(compact.modules.every(m=>m.revision===1)).toBe(true)
 expect(compact.modules[0]).not.toHaveProperty('settings');expect(chainModules(restored).map(m=>m.settings[m.type])).toEqual(chainModules(old).map(m=>m.settings[m.type]));expect(restored.inputGainDb).toBe(old.inputGainDb);expect(restored.outputGainDb).toBe(old.outputGainDb)
 expect(effectChainSchema.safeParse({...compact,modules:[{id:'x',type:'amp',revision:2,params:{engine:'bad'}}]}).success).toBe(false)
})
it('persists drafts, favorites and compact presets; saving factory presets creates independent copies',async()=>{
 const a=service(),factory=a.list().presets[0]!,copy=a.savePreset({...factory,name:'我的清音'})
 expect(copy.id).not.toBe(factory.id);expect(a.list().presets).toHaveLength(9)
 const stored=JSON.parse((sqlite.prepare('SELECT json FROM arsenal_presets').get() as {json:string}).json);expect(stored.chain.version).toBe(2)
 await a.command({action:'favorite',id:factory.id,value:true});await a.command({action:'draft',draft:{name:'未保存',chain:copy.chain,dirty:true,presetId:copy.id}})
 const b=service();expect((await b.command({action:'workspace'})).draft?.name).toBe('未保存');expect(b.list().presets.find(p=>p.id===factory.id)?.favorite).toBe(true);expect(b.monitorState().active).toBe(false)
 const disk=JSON.parse(await readFile(path.join(root,'arsenal/workspace.json'),'utf8'));expect(disk.draft.chain.version).toBe(2)
})
it('factory presets need no files and every visible parameter obeys its schema',()=>{
 for(const preset of factoryPresets())for(const m of chainModules(preset.chain)){
  expect(m.settings.amp.assetId).toBeNull();expect(m.settings.cab.assetId).toBeNull()
  for(const p of effectDefinition(m).parameters){expect(()=>changeModuleParameter(m,p.path,p.min)).not.toThrow();expect(()=>changeModuleParameter(m,p.path,p.max)).not.toThrow()}
 }
 const m=createEffectModule('dynamic');m.settings.dynamic.device='boost';expect(effectDefinition(m).parameters.map(p=>p.path)).toEqual(['dynamic.gainDb'])
 const wah=createEffectModule('mod');wah.settings.mod.device='wah';expect(effectDefinition(wah).parameters.map(p=>p.path)).not.toContain('mod.rateHz')
})
it('recovers an interrupted DI file by repairing its header without starting monitoring',async()=>{
 const id='10000000-0000-4000-8000-000000000001',header=Buffer.alloc(44+480*4);header.write('RIFF',0);header.writeUInt32LE(36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(3,20);header.writeUInt16LE(1,22);header.writeUInt32LE(48000,24);header.writeUInt32LE(192000,28);header.writeUInt16LE(4,32);header.writeUInt16LE(32,34);header.write('data',36)
 await mkdir(path.join(root,'arsenal'));await writeFile(path.join(root,'arsenal',`${id}.dry.wav`),header);await writeFile(path.join(root,'arsenal','workspace.json'),JSON.stringify({takes:[],pending:{id,name:'恢复测试',chain:storeEffectChain(defaultEffectChain()),sampleRate:48000,channels:1,createdAt:new Date().toISOString()}}))
 const s=service(),workspace=await s.command({action:'workspace'});expect(workspace.takes[0]).toMatchObject({durationMs:10,recovered:true});expect(s.monitorState().active).toBe(false);const repaired=await readFile(path.join(root,'arsenal',`${id}.dry.wav`));expect(repaired.readUInt32LE(40)).toBe(1920);expect(repaired.subarray(44)).toEqual(header.subarray(44))
})

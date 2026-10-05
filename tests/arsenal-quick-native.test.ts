import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { mkdtemp,readFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect,it } from 'vitest'
import { defaultEffectChain,createEffectModule,moduleChain } from '@shared/arsenal.js'
const executable=path.resolve('resources/audio-host/win32-x64/bandbuddy-audio-host.exe')
it.skipIf(!existsSync(executable))('captures raw DI, loops it, detects pitch and swaps graphs while keeping one device session',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'bb-quick-native-')),child=spawn(executable,['--simulate'],{stdio:['pipe','pipe','pipe'],windowsHide:true}),lines=createInterface({input:child.stdout});let sequence=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(e:Error)=>void}>();const meters:any[]=[]
 lines.on('line',line=>{const data=JSON.parse(line);if(data.event==='meter')meters.push(data.data);const p=pending.get(data.id);if(p){pending.delete(data.id);data.ok?p.resolve(data.result):p.reject(new Error(data.error))}})
 child.once('exit',()=>{for(const p of pending.values())p.reject(new Error('native host exited'))})
 const rpc=(method:string,params:object={}):Promise<any>=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(`${JSON.stringify({id,method,params})}\n`)})
 const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms))
 const prepared=(amount:number)=>{const module=createEffectModule('drive');module.settings.drive.drive=amount;return {chain:{...defaultEffectChain(),modules:[module]},modules:[{chain:moduleChain(module),model:null,modelRate:48000,ir:null,irRate:48000}]}}
 try{
  const [device]=await rpc('devices');await rpc('startTest',{backend:device.backend,inputDeviceId:device.id,outputDeviceId:device.id,inputChannels:[0,1],sampleRate:48000,bufferFrames:128,monitorMode:2,monitorGainDb:0,effects:prepared(.2)})
  const file=path.join(root,'DI.wav');await rpc('arsenalQuick',{action:'record',path:file});for(let i=0;i<50;i++){await wait(50);if((await rpc('arsenalQuick',{action:'state'})).durationMs>150)break}await rpc('effects',{prepared:prepared(.8)});await wait(100);const recorded=await rpc('arsenalQuick',{action:'stopRecord'});expect(recorded.durationMs).toBeGreaterThan(100);expect(recorded.recording).toBe(false)
  const bytes=await readFile(file);expect(bytes.readUInt32LE(40)).toBe(bytes.length-44);expect(bytes.readUInt16LE(22)).toBe(2);let max=0;for(let i=44;i<bytes.length;i+=4)max=Math.max(max,Math.abs(bytes.readFloatLE(i)));expect(max).toBeLessThanOrEqual(.251);expect(max).toBeGreaterThan(.1)
  await rpc('arsenalQuick',{action:'loop',path:file});expect((await rpc('arsenalQuick',{action:'state'})).looping).toBe(true);await wait(150);await rpc('arsenalQuick',{action:'stopLoop'});expect(await readFile(file)).toEqual(bytes)
  await rpc('arsenalQuick',{action:'tuner',enabled:true});for(let i=0;i<60&&!meters.some(m=>m.tunerActive&&m.tunerHz>0);i++)await wait(50);expect(meters.some(m=>m.tunerActive&&m.tunerHz>0)).toBe(true);const last=meters.at(-1);expect(last.outputPeak).toBe(0);expect(last.dspLatencyMs).toBeGreaterThan(0);expect(Number.isFinite(last.dspLoad)).toBe(true)
  const before=meters.length;for(let n=0;n<4;n++)await rpc('arsenalPcm',{bus:0,sampleRate:44100,samples:Array.from({length:8192},(_,i)=>.12*Math.sin(i*.04))});await wait(200);expect(meters.slice(before).some(m=>m.outputPeak>.08)).toBe(true)
  await rpc('arsenalPcm',{bus:0,sampleRate:44100,samples:[],reset:true})
  await rpc('arsenalQuick',{action:'tuner',enabled:false});await rpc('arsenalQuick',{action:'record',path:path.join(root,'second.wav')});await wait(500);expect((await rpc('arsenalQuick',{action:'stopRecord'})).durationMs).toBeGreaterThan(0);await rpc('stopTest')
 }finally{child.kill();lines.close();await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve())});await rm(root,{recursive:true,force:true})}
},15000)

// Run after building the native effects-test target and scripts/build-effects.mjs.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import createModule from '../src/renderer/src/arsenal/dsp/arsenal-dsp.js'

const root = process.cwd()
const ampCabOnly = process.argv.includes('--amp-cab-only')
const pedalsOnly = process.argv.includes('--pedals-only')
const platform = `${process.platform}-${process.arch}`
const nativeRoot = path.join(root, 'native/audio-host/build', platform)
const suffix = process.platform === 'win32' ? '.exe' : ''
const nativeExecutable = (directory, name) => [path.join(directory, 'Release', name + suffix), path.join(directory, name + suffix)].find(file => existsSync(file)) ?? path.join(directory, name + suffix)
const native = process.env.BB_EFFECTS_TEST || nativeExecutable(path.join(nativeRoot, 'effects'), 'bandbuddy-effects-test')
const host = process.env.BB_AUDIO_HOST || nativeExecutable(nativeRoot, 'bandbuddy-audio-host')

const m = await createModule({ wasmBinary: await readFile(path.join(root, 'src/renderer/src/arsenal/dsp/arsenal-dsp.wasm')) })
const dir = await mkdtemp(path.join(tmpdir(), 'bb-whitebox-'))
const frames = 8192
const source = new Float32Array(frames * 2)
let seed = 42
for (let n = 0; n < frames; ++n) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  source[n * 2] = n < 6000 ? .3 * Math.sin(n * .13) + .05 * (seed / 2 ** 32 - .5) : 0
  source[n * 2 + 1] = n < 6000 ? .15 * Math.sin(n * .033) : 0
}
function run(args) {
  const p = spawnSync(native, args, { encoding: 'utf8' })
  if (p.error || p.status) throw new Error(p.error?.message || p.stderr)
  return p.stdout.trim()
}
function cString(text) {
  const p = m._malloc(m.lengthBytesUTF8(text) + 1);m.stringToUTF8(text, p, m.lengthBytesUTF8(text) + 1);return p
}
function rmsError(a,b) {
  let error = 0, reference = 0
  for (let n = 0; n < a.length; ++n) {
    if (!Number.isFinite(a[n]) || !Number.isFinite(b[n])) throw new Error('Nonfinite render')
    error += (a[n] - b[n]) ** 2; reference += a[n] ** 2
  }
  return Math.sqrt(error / Math.max(reference, 1e-20))
}
const results=[]
try {
  if (!ampCabOnly && !pedalsOnly) console.log(run([]))
  const input=path.join(dir,'input.f32'),manifest=path.join(dir,'chain.json'),out=path.join(dir,'output.f32')
  await writeFile(input, new Uint8Array(source.buffer))
  const hash = createHash('sha256').update(new Uint8Array(source.buffer)).digest('hex')
  const variants = (ampCabOnly ? [] : (pedalsOnly?['centaur']:['ts808','sd1','rat','microamp','distortion-plus','fuzzface','ds1','bd2','centaur']).flatMap(device => [2,4].map(oversampling => ({device,oversampling}))))
  if (!ampCabOnly && !pedalsOnly) for (const [index,mod] of ['phase90','optical-tremolo','chorus','flanger','wah','ota-compressor'].entries())
    variants.push({device:'ts808',oversampling:4,classic:index,mod})
  if(!ampCabOnly){
    const pedal=(mod,modControls={})=>variants.push({device:'centaur',oversampling:4,pedalMod:true,mod,modControls})
    for(const bassFilter of [false,true])pedal('stereo-chorus',{bass:.3,treble:.7,bassFilter})
    for(const sweepMode of ['sweep','step','dynamic'])for(const feedback of [-.75,.75])pedal('step-flanger',{sweepMode,feedback})
    for(const waveform of ['sine','triangle','ramp','square','random','env-depth','env-rate','env-pitch'])pedal('aqueduct-vibrato',{waveform})
    pedal('fixed-wah',{levelDb:3})
  }
  const cabinets = ['fender-deluxe','fender-twin','marshall-1960ax','marshall-1960b','vox-ac30c2','mesa-rectifier','orange-ppc412']
  if(!pedalsOnly)for (const [index,head] of ['fender-twin','marshall-jtm45','marshall-jcm800','vox-ac30','mesa-rectifier'].entries())
    for (const quality of [2,4]) variants.push({device:'ts808',oversampling:4,head,quality,cabinet:cabinets[index]})
  if(!pedalsOnly)for (const cabinet of cabinets) variants.push({device:'ts808',oversampling:4,cabinet})
  for (const variant of variants) {
    const {device,oversampling}=variant
    const chain = {version:1, order:['drive','amp','eq','delay','reverb'],inputGainDb:0,outputGainDb:-6,
      drive:{enabled:true,device,revision:1,drive:.7,tone:.4,level:.8,inputVolts:1,oversampling},
      amp:{enabled:false,assetId:null,quality:'full'},cab:{enabled:true,assetId:null,gainDb:0,lowCut:40,highCut:16000},
      eq:{enabled:true,bands:[0,1,0,-2,1,0,0],gainDb:0},
      delay:{enabled:true,timeMs:10,feedback:.3,mix:.15,tone:6000,sync:false,division:'1/4',bpm:120},
      reverb:{enabled:true,decay:.4,preDelayMs:0,damping:.4,mix:.1}}
    if(variant.classic!==undefined) {
      chain.order=['drive','mod','amp','eq','delay','reverb']
      chain.amp={...chain.amp,enabled:true,engine:'classic',classic:{device:variant.classic%2?'2203-pre':'ab763-pre',gain:.7,bass:.4,middle:.6,treble:.8,master:.8,inputVolts:1}}
      chain.cab={...chain.cab,engine:'physical',physical:{device:['open112','open212','sealed412'][variant.classic%3],volumeLitres:100,distanceMetres:.5,micAngle:25}}
      chain.mod={enabled:true,device:variant.mod,rateHz:1.7,depth:.8,mix:.6,feedback:.4,manual:.7}
    }
    if (variant.cabinet) {
      chain.order=variant.head?['amp','cab']:['cab']
      chain.amp={...chain.amp,enabled:!!variant.head,engine:'classic',classic:{device:variant.head??'fender-twin',gain:.7,bass:.4,middle:.6,treble:.8,master:.8,inputVolts:1,presence:.7,cut:.6,sag:.4,oversampling:variant.quality??4}}
      chain.cab={...chain.cab,engine:'physical',physical:{device:variant.cabinet,volumeLitres:170,distanceMetres:.5,micAngle:25}}
    }
    if(variant.pedalMod){
      chain.order=['drive','mod','cab']
      chain.mod={enabled:true,device:variant.mod,rateHz:1.7,depth:.8,mix:.6,feedback:.4,manual:.7,...variant.modControls}
    }
    const prepared = {chain,model:null,modelRate:48000,ir:[[1,0,.1],[.8,0,-.1]],irRate:48000}
    if ((device === 'rat' && oversampling === 4) || variant.classic===0 || (variant.head==='fender-twin'&&variant.quality===4) || (variant.mod==='stereo-chorus'&&variant.modControls?.bassFilter===true)) {
      const latency=variant.classic===undefined?160:192
      // Exercise an actual native WAV export, including latency compensation and a 100 ms tail.
      const header=Buffer.alloc(44)
      header.write('RIFF');header.writeUInt32LE(36+source.byteLength,4);header.write('WAVEfmt ',8)
      header.writeUInt32LE(16,16);header.writeUInt16LE(3,20);header.writeUInt16LE(2,22)
      header.writeUInt32LE(48000,24);header.writeUInt32LE(48000*8,28);header.writeUInt16LE(8,32);header.writeUInt16LE(32,34)
      header.write('data',36);header.writeUInt32LE(source.byteLength,40)
      const wavIn=path.join(dir,'dry.wav'),wavOut=path.join(dir,'wet.wav'),job=path.join(dir,'job.json')
      await writeFile(wavIn,Buffer.concat([header,Buffer.from(source.buffer)]))
      await writeFile(job,JSON.stringify({input:wavIn,output:wavOut,prepared,tailSeconds:.1}))

      const result=spawnSync(host,['--render-effects',job],{encoding:'utf8'})
      if(result.error||result.status)throw new Error(result.error?.message||result.stderr)
      const wave=await readFile(wavOut);let data
      for(let p=12;p+8<=wave.length;) {const size=wave.readUInt32LE(p+4);if(wave.toString('ascii',p,p+4)==='data')data=wave.subarray(p+8,p+8+size);p+=8+size+(size%2)}
      if(!data || data.length!==(frames+4800)*8)throw new Error('Offline tail length incorrect')
      const padding=new Float32Array((frames+4800+latency)*2);padding.set(source)
      const padded=path.join(dir,'padded.f32');await writeFile(padded,new Uint8Array(padding.buffer));await writeFile(manifest,JSON.stringify(prepared))
      run([manifest,padded,out,'128']);const raw=await readFile(out)
      const compensated=raw.subarray(latency*8)
      if(!data.equals(compensated))throw new Error('Offline DSP latency compensation differs from streaming')
      if (variant.head || variant.pedalMod) {
        const pluginHost=process.env.BB_PLUGIN_HOST || path.join(root,'native/audio-host/build',platform,'plugin-host',...(process.platform==='win32'?['Release']:[]),`bandbuddy-plugin-host${process.platform==='win32'?'.exe':''}`)
        const graphOutput=path.join(dir,'graph.wav')
        await writeFile(job,JSON.stringify({input:wavIn,output:graphOutput,tailSeconds:.1,graph:{version:1,inputGainDb:0,outputGainDb:0,nodes:[{id:'amp-cab',kind:'builtin',prepared}]}}))
        const graph=spawnSync(pluginHost,['--render',job],{encoding:'utf8'})
        if(graph.error||graph.status)throw new Error(graph.error?.message||graph.stderr)
        const rendered=await readFile(graphOutput);let graphData
        for(let p=12;p+8<=rendered.length;) {const size=rendered.readUInt32LE(p+4);if(rendered.toString('ascii',p,p+4)==='data')graphData=rendered.subarray(p+8,p+8+size);p+=8+size+(size%2)}
        if(!graphData?.equals(data))throw new Error('Plugin host builtin amp/cabinet differs from audio host')
        console.log('Plugin host builtin chain: sample-exact native WAV parity passed')
      }
      // A nonlinear pedal after the other modules must not render the same as before them.
      const originalOrder = prepared.chain.order
      if(originalOrder.includes('drive')){
        prepared.chain.order=[...originalOrder.filter(block=>block!=='drive'),'drive']
        await writeFile(manifest,JSON.stringify(prepared));run([manifest,padded,out,'128'])
        if((await readFile(out)).equals(raw))throw new Error('Module reordering had no effect')
      }
      prepared.chain.order = originalOrder
      console.log('Native WAV export: exact latency compensation, tail length and reordered chain passed')
    }
    const str=JSON.stringify(prepared);await writeFile(manifest,str)
    console.log(run([manifest,input,out,'127']))
    let bytes=await readFile(out);const reference=Float32Array.from(new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4))
    // Same algorithm state must not depend on callback quantum size.
    run([manifest,input,out,'257']);bytes=await readFile(out)
    if(rmsError(reference,new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4))!==0) throw new Error('Callback partition changed output')
    const jsonPtr=cString(str),processor=m._bb_create(jsonPtr,48000);m._free(jsonPtr)
    if(!processor) throw new Error(m.UTF8ToString(m._bb_error()))
    const inPtr=m._malloc(source.byteLength),outPtr=m._malloc(source.byteLength)
    try {
      m.HEAPF32.set(source,inPtr/4)
      for(let n=0;n<frames;n+=113) m._bb_process(processor,inPtr+n*8,outPtr+n*8,Math.min(113,frames-n),2)
      const actual=m.HEAPF32.slice(outPtr/4,outPtr/4+source.length),error=rmsError(reference,actual)
      if(error>1e-4) throw new Error(`${device}/${oversampling} native/WASM relative RMS ${error}`)
      const captured = new Uint8Array(m.HEAPF32.slice(inPtr/4,inPtr/4+source.length).buffer)
      if(createHash('sha256').update(captured).digest('hex')!==hash)throw new Error('Dry capture altered')
      if(variant.head){
        const changed=structuredClone(chain);changed.amp.classic.gain=.3
        const ptr=cString(JSON.stringify(changed));const ok=m._bb_update(processor,ptr);m._free(ptr);if(!ok)throw new Error('Amp parameter update rejected')
        changed.amp.classic.oversampling=variant.quality===4?2:4
        const bad=cString(JSON.stringify(changed));const rejected=m._bb_update(processor,bad);m._free(bad);if(rejected)throw new Error('Amp structural change must require preparation')
      }
      if(variant.pedalMod){
        const changed=structuredClone(chain);changed.mod.depth=.3
        const ptr=cString(JSON.stringify(changed));const ok=m._bb_update(processor,ptr);m._free(ptr);if(!ok)throw new Error('Pedal knob update rejected')
        if(variant.mod==='aqueduct-vibrato'||variant.mod==='step-flanger'){
          if(variant.mod==='aqueduct-vibrato')changed.mod.waveform=chain.mod.waveform==='sine'?'random':'sine'
          else changed.mod.sweepMode=chain.mod.sweepMode==='step'?'sweep':'step'
          const ptr=cString(JSON.stringify(changed));const accepted=m._bb_update(processor,ptr);m._free(ptr);if(accepted)throw new Error('Mode switch must prepare a new processor for host crossfade')
        }
      }
      results.push({device,oversampling,classic:variant.classic,mod:variant.mod,modControls:variant.modControls,head:variant.head,quality:variant.quality,cabinet:variant.cabinet,relativeRms:error})
    } finally {m._bb_destroy(processor);m._free(inPtr);m._free(outPtr)}
  }
  console.log(JSON.stringify({passed:true,rate:48000,frames,results},null,2))
} finally {await rm(dir,{recursive:true,force:true})}

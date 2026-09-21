// Run after building the native effects-test target and scripts/build-effects.mjs.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import createModule from '../src/renderer/src/arsenal/dsp/arsenal-dsp.js'

const root = process.cwd()
const platform = `${process.platform}-${process.arch}`
const native = process.env.BB_EFFECTS_TEST || path.join(root, 'native/audio-host/build', platform, 'effects', `bandbuddy-effects-test${process.platform === 'win32' ? '.exe' : ''}`)
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
  console.log(run([]))
  const input=path.join(dir,'input.f32'),manifest=path.join(dir,'chain.json'),out=path.join(dir,'output.f32')
  await writeFile(input, new Uint8Array(source.buffer))
  const hash = createHash('sha256').update(new Uint8Array(source.buffer)).digest('hex')
  for (const device of ['ts808','sd1','rat']) for (const oversampling of [2,4]) {
    const chain = {version:1, order:['drive','amp','eq','delay','reverb'],inputGainDb:0,outputGainDb:-6,
      drive:{enabled:true,device,revision:1,drive:.7,tone:.4,level:.8,inputVolts:1,oversampling},
      amp:{enabled:false,assetId:null,quality:'full'},cab:{enabled:true,assetId:null,gainDb:0,lowCut:40,highCut:16000},
      eq:{enabled:true,bands:[0,1,0,-2,1,0,0],gainDb:0},
      delay:{enabled:true,timeMs:10,feedback:.3,mix:.15,tone:6000,sync:false,division:'1/4',bpm:120},
      reverb:{enabled:true,decay:.4,preDelayMs:0,damping:.4,mix:.1}}
    const prepared = {chain,model:null,modelRate:48000,ir:[[1,0,.1],[.8,0,-.1]],irRate:48000}
    if (device === 'rat' && oversampling === 4) {
      // Exercise an actual native WAV export, including latency compensation and a 100 ms tail.
      const header=Buffer.alloc(44)
      header.write('RIFF');header.writeUInt32LE(36+source.byteLength,4);header.write('WAVEfmt ',8)
      header.writeUInt32LE(16,16);header.writeUInt16LE(3,20);header.writeUInt16LE(2,22)
      header.writeUInt32LE(48000,24);header.writeUInt32LE(48000*8,28);header.writeUInt16LE(8,32);header.writeUInt16LE(32,34)
      header.write('data',36);header.writeUInt32LE(source.byteLength,40)
      const wavIn=path.join(dir,'dry.wav'),wavOut=path.join(dir,'wet.wav'),job=path.join(dir,'job.json')
      await writeFile(wavIn,Buffer.concat([header,Buffer.from(source.buffer)]))
      await writeFile(job,JSON.stringify({input:wavIn,output:wavOut,prepared,tailSeconds:.1}))
      const host=process.env.BB_AUDIO_HOST || path.resolve(path.dirname(native),'..',`bandbuddy-audio-host${process.platform==='win32'?'.exe':''}`)
      const result=spawnSync(host,['--render-effects',job],{encoding:'utf8'})
      if(result.error||result.status)throw new Error(result.error?.message||result.stderr)
      const wave=await readFile(wavOut);let data
      for(let p=12;p+8<=wave.length;) {const size=wave.readUInt32LE(p+4);if(wave.toString('ascii',p,p+4)==='data')data=wave.subarray(p+8,p+8+size);p+=8+size+(size%2)}
      if(!data || data.length!==(frames+4800)*8)throw new Error('Offline tail length incorrect')
      const padding=new Float32Array((frames+4800+160)*2);padding.set(source)
      const padded=path.join(dir,'padded.f32');await writeFile(padded,new Uint8Array(padding.buffer));await writeFile(manifest,JSON.stringify(prepared))
      run([manifest,padded,out,'128']);const raw=await readFile(out)
      const compensated=raw.subarray(160*8)
      if(!data.equals(compensated))throw new Error('Offline DSP latency compensation differs from streaming')
      // A nonlinear pedal after the other modules must not render the same as before them.
      prepared.chain.order=['amp','eq','delay','reverb','drive']
      await writeFile(manifest,JSON.stringify(prepared));run([manifest,padded,out,'128'])
      if((await readFile(out)).equals(raw))throw new Error('Module reordering had no effect')
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
      results.push({device,oversampling,relativeRms:error})
    } finally {m._bb_destroy(processor);m._free(inPtr);m._free(outPtr)}
  }
  console.log(JSON.stringify({passed:true,rate:48000,frames,results},null,2))
} finally {await rm(dir,{recursive:true,force:true})}

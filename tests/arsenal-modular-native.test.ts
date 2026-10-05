import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createEffectModule, defaultEffectChain, moduleChain, type EffectModule, type PreparedEffects } from '../packages/shared/src/arsenal.js'

const executable = path.resolve('native/audio-host/build/win32-x64/effects/Release/bandbuddy-effects-test.exe')
let directory: string
const frames = 24000
const source = new Float32Array(frames * 2)
for (let n = 0; n < 16000; n++) {
  source[n * 2] = .2 * Math.sin(n * .057) + .09 * Math.sin(n * .31)
  source[n * 2 + 1] = .13 * Math.sin(n * .083)
}
beforeAll(async () => { directory = await mkdtemp(path.join(tmpdir(), 'bb-modular-')); await writeFile(path.join(directory, 'input.f32'), Buffer.from(source.buffer)) })
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })
async function render(modules: EffectModule[], chunk = 127, extra:Partial<PreparedEffects>={}): Promise<Float32Array> {
  const prepared = { chain: { ...defaultEffectChain(), modules }, modules: modules.map(m => ({ chain: moduleChain(m), model: null, modelRate: 48000, ir: null, irRate: 48000 })) }
  for(const child of prepared.modules)Object.assign(child,extra)
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(prepared))
  const result = spawnSync(executable, [path.join(directory, 'manifest.json'), path.join(directory, 'input.f32'), path.join(directory, 'out.f32'), String(chunk)], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  const bytes = await readFile(path.join(directory, 'out.f32'))
  const output = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  expect(output.length).toBe(source.length)
  expect(output.every(v => Number.isFinite(v) && Math.abs(v) < 30)).toBe(true)
  expect(output.some(v => Math.abs(v) > 1e-5)).toBe(true)
  return output
}
const native = it.skipIf(!existsSync(executable))
native('preserves dry bytes and is independent of callback block boundaries', async () => {
  const modules = ['dynamic', 'drive', 'amp', 'cab', 'eq', 'mod', 'delay', 'reverb'].map(type => createEffectModule(type as EffectModule['type']))
  const a = await render(modules, 127), b = await render(modules, 512)
  expect(a).toEqual(b)
  expect(await readFile(path.join(directory, 'input.f32'))).toEqual(Buffer.from(source.buffer))
}, 30000)
native('repeated nonlinear modules preserve order and independent controls', async () => {
  const drive = createEffectModule('drive'), eq = createEffectModule('eq')
  drive.settings.drive.device = 'ds1'; eq.settings.eq.bands = [12, -12, 8, -8, 6, -6, 0]
  const first = await render([drive, eq]), second = await render([eq, drive])
  expect(first.some((v, i) => Math.abs(v - second[i]!) > .001)).toBe(true)
  expect(await render([drive, { ...drive, id: 'second' }])).not.toEqual(await render([drive]))
})
native('all added amp, drive, modulation, delay and reverb variants produce distinct bounded output', async () => {
  for (const [type, field, variants] of [
    ['amp', 'classic', ['orange', 'mesa', 'vox', '2203-pre']],
    ['drive', 'device', ['ts808', 'sd1', 'ds1', 'bd2', 'fuzzface']],
    ['mod', 'device', ['chorus', 'flanger', 'vibrato', 'phase90']],
    ['delay', 'style', ['digital', 'analog', 'tape', 'reverse']],
    ['reverb', 'style', ['room', 'hall', 'plate', 'spring']]
  ] as const) {
    const results: Float32Array[] = []
    for (const variant of variants) {
      const module = createEffectModule(type)
      if (type === 'amp') module.settings.amp.classic.device = variant as typeof module.settings.amp.classic.device
      else (module.settings[type] as unknown as Record<string, unknown>)[field] = variant
      if (type === 'delay') { module.settings.delay.timeMs = 50; module.settings.delay.mix = .8 }
      if (type === 'reverb') module.settings.reverb.mix = .8
      const result = await render([module])
      for (const previous of results) expect(result.some((v, i) => Math.abs(v - previous[i]!) > .00001), `${type}/${variant}`).toBe(true)
      results.push(result)
    }
  }
}, 60000)
native('parametric Q, parallel compression and dual IR controls change actual audio',async()=>{
  const eq=createEffectModule('eq');eq.settings.eq.mode='parametric';eq.settings.eq.parametric[0]={frequency:440,gain:12,q:.4}
  const wide=await render([eq]);eq.settings.eq.parametric[0].q=8;expect(await render([eq])).not.toEqual(wide)
  const comp=createEffectModule('dynamic');comp.settings.dynamic.threshold=-35;comp.settings.dynamic.ratio=10;comp.settings.dynamic.mix=0;const dry=await render([comp]);comp.settings.dynamic.mix=1;const wet=await render([comp]);expect(wet.reduce((sum,x)=>sum+x*x,0)).toBeLessThan(dry.reduce((sum,x)=>sum+x*x,0)*.5)
  const cab=createEffectModule('cab');cab.settings.cab.engine='ir';cab.settings.cab.blend=0
  const extra={ir:[[1]],irRate:48000,secondaryIr:[[0,0,.5]],secondaryIrRate:48000};const a=await render([cab],127,extra);cab.settings.cab.blend=1;const b=await render([cab],127,extra);expect(b).not.toEqual(a);cab.settings.cab.secondaryPolarity=true;const inverted=await render([cab],127,extra);expect(inverted[10000]).toBeCloseTo(-b[10000]!,6)
},30000)

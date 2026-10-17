import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createEffectModule, defaultEffectChain, moduleChain, type PreparedEffects } from '../packages/shared/src/arsenal.js'

const executable = path.resolve('native/audio-host/build/win32-x64/Release/bandbuddy-audio-host.exe')
const native = it.skipIf(!existsSync(executable))
let directory: string, sequence = 0
beforeAll(async () => { directory = await mkdtemp(path.join(tmpdir(), 'bb-nam-boundary-')) })
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

function prepared(gain = 1): PreparedEffects {
  const chain = defaultEffectChain()
  chain.order = ['amp']; chain.dspRevision = 2
  chain.inputGainDb = 0; chain.outputGainDb = 0; chain.amp.enabled = true
  const leaf = { version: '0.7.0', architecture: 'Linear', config: { receptive_field: 1, bias: false }, weights: [gain], sample_rate: 48000 }
  const model = { ...leaf, architecture: 'SlimmableContainer', weights: [], config: { submodels: [
    { max_value: .5, model: leaf }, { max_value: 1, model: leaf }
  ] } }
  return { chain, model: JSON.stringify(model), modelRate: 48000, ir: null, irRate: 48000 }
}
async function render(effects: PreparedEffects, source: Float32Array, rate = 48000) {
  const prefix = path.join(directory, String(++sequence)), header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(36 + source.byteLength, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(2, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 8, 28); header.writeUInt16LE(8, 32)
  header.writeUInt16LE(32, 34); header.write('data', 36); header.writeUInt32LE(source.byteLength, 40)
  await writeFile(prefix + '.wav', Buffer.concat([header, Buffer.from(source.buffer)]))
  await writeFile(prefix + '.json', JSON.stringify({ input: prefix + '.wav', output: prefix + '-out.wav', prepared: effects, tailSeconds: 0 }))
  const result = spawnSync(executable, ['--render-effects', prefix + '.json'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
  expect(result.status, result.error?.message ?? result.stderr).toBe(0)
  const bytes = await readFile(prefix + '-out.wav')
  for (let p = 12; p + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(p + 4)
    if (bytes.toString('ascii', p, p + 4) === 'data') {
      const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset + p + 8, bytes.byteOffset + p + 8 + size))
      expect(samples.length).toBe(source.length)
      expect(samples.every(Number.isFinite)).toBe(true)
      return samples
    }
    p += 8 + size + size % 2
  }
  throw new Error('Missing rendered WAV samples')
}

native('rejects model DC while preserving a bypassed NAM signal', async () => {
  const input = new Float32Array(48000 * 2)
  input.fill(.125, 9600 * 2)
  const spec = prepared(), wet = await render(spec, input)
  expect(Math.max(...wet.subarray(12000 * 2, 12010 * 2))).toBeGreaterThan(.01)
  expect(wet.subarray(40000 * 2).every(x => Math.abs(x) < .0001)).toBe(true)
  spec.chain.amp.enabled = false
  const dry = await render(spec, input)
  expect(dry.subarray(9600 * 2)).toEqual(input.subarray(9600 * 2))
})

native('applies the output DC blocker once across multiple NAM modules', async () => {
  const input = new Float32Array(48000 * 2)
  for (let i = 9600; i < 48000; i++) {
    input[i * 2] = .125 + .1 * Math.sin(i * .03)
    input[i * 2 + 1] = -.0625 + .05 * Math.sin(i * .019)
  }
  const single = await render(prepared(.25), input)
  const modules = [createEffectModule('amp'), createEffectModule('amp')]
  for (const module of modules) { module.settings.amp.engine = 'nam'; module.settings.amp.enabled = true }
  const spec = prepared()
  spec.chain.modules = modules
  spec.modules = modules.map(module => ({ ...prepared(.5), chain: moduleChain(module) }))
  const serial = await render(spec, input)
  expect(serial.subarray(9600 * 2)).toEqual(single.subarray(9600 * 2))
})

native.each([44100, 48000, 96000])('compensates the resampled NAM pulse delay to within one sample at %i Hz', async rate => {
  const input = new Float32Array(rate * 2), position = Math.round(rate * .2)
  // A pulse spans both decimation phases at 96 kHz, rather than testing
  // the retention of a single sample above the model's Nyquist frequency.
  for (let offset = -4; offset <= 4; offset++) {
    const value = .5 * Math.exp(-offset * offset / 4)
    input[(position + offset) * 2] = value
    input[(position + offset) * 2 + 1] = -value / 2
  }
  const output = await render(prepared(), input, rate)
  let peak = 0
  for (let i = 1; i < rate; i++) if (Math.abs(output[i * 2]!) > Math.abs(output[peak * 2]!)) peak = i
  // Integer PDC rounds the converter's fractional phase to host samples.
  expect(Math.abs(peak - position)).toBeLessThanOrEqual(rate === 48000 ? 0 : 1)
  expect(output[position * 2]).toBeGreaterThan(.2)
  expect(output[position * 2 + 1]).toBeCloseTo(-output[position * 2]! / 2, 6)
})

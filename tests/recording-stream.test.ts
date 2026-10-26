import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultEffectChain } from '../packages/shared/src/arsenal.js'
import { PluginWorker } from '../src/main/audio-plugins.js'
import { runProcess } from '../src/main/process.js'

const executable = path.resolve('resources/audio-host/win32-x64/bandbuddy-audio-host.exe')
const pluginHost = path.resolve('resources/audio-host/win32-x64/bandbuddy-plugin-host.exe')
const fixturePlugin = path.resolve('native/audio-host/build/win32-x64/VST3/Release/bandbuddy-test-delay.vst3')
const namModel = path.resolve('native/audio-host/build/win32-x64/_deps/nam_core-src/example_models/wavenet.nam')

describe.skipIf(process.platform !== 'win32' || !existsSync(executable))('bounded native recording DSP', () => {
  let root: string, source: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'BandBuddy 流式录音-')); source = path.join(root, 'source.wav')
    const rate = 44100, frames = rate * 3, bytes = Buffer.alloc(44 + frames * 4)
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16)
    bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28)
    bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(32, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 4, 40)
    for (let f = 0; f < frames; f++) bytes.writeFloatLE(.2 * Math.sin(2 * Math.PI * 220 * f / rate), 44 + f * 4)
    await writeFile(source, bytes)
  })
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  async function render(config: Record<string, unknown> = {}, frames = 48000) {
    const started = performance.now(), child = spawn(executable, ['--recording-stream'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const bytes: Buffer[] = []; let stderr = '', firstMs = 0
    child.stdout.on('data', chunk => { if (!firstMs) firstMs = performance.now() - started; bytes.push(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const done = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr))) })
    child.stdin.end(JSON.stringify({ path: source, sampleRate: 48000, durationMs: 1800000, endByte: 79 + frames * 8, ...config }) + '\n')
    const timer = setTimeout(() => child.kill(), 5000)
    try { await done } finally { clearTimeout(timer) }
    const wav = Buffer.concat(bytes), audio = new Float32Array(frames)
    expect(wav.length).toBe(80 + frames * 8)
    let leftEnergy = 0, rightEnergy = 0
    for (let f = 0; f < frames; f++) {
      audio[f] = wav.readFloatLE(80 + f * 8)
      const right = wav.readFloatLE(84 + f * 8); expect(Number.isFinite(right)).toBe(true)
      if (!config.pitch && (!config.rate || config.rate === 1)) expect(right).toBe(audio[f])
      leftEnergy += audio[f]! ** 2; rightEnergy += right ** 2
    }
    // Signalsmith can vary stereo phase during pitch shifting; both channels
    // must retain the centered mono input's level, not become silent.
    expect(Math.abs(rightEnergy / leftEnergy - 1)).toBeLessThan(.05)
    expect(audio.every(Number.isFinite)).toBe(true)
    return { audio, firstMs }
  }
  function frequency(audio: Float32Array) {
    const begin = Math.floor(audio.length * .25), end = Math.floor(audio.length * .9)
    const crossings: number[] = []
    for (let f = begin + 1; f < end; f++) if (audio[f - 1]! <= 0 && audio[f]! > 0) crossings.push(f - 1 - audio[f - 1]! / (audio[f]! - audio[f - 1]!))
    return (crossings.length - 1) * 48000 / (crossings.at(-1)! - crossings[0]!)
  }
  it('resamples compact mono capture and applies speed/pitch at an arbitrary timeline offset', async () => {
    const dry = await render()
    expect(frequency(dry.audio)).toBeCloseTo(220, 0)
    const changed = await render({ rate: .75, pitch: 12, offsetMs: 1500000, outputStartMs: 2000000, durationMs: 2400000 })
    expect(Math.abs(frequency(changed.audio) - 440)).toBeLessThan(3)
    expect(Math.max(...changed.audio)).toBeGreaterThan(.05)
    expect(changed.firstMs).toBeLessThan(1000)
  })
  it('compensates the builtin effect block latency without shifting the recording', async () => {
    const dry = await render(), chain = { ...defaultEffectChain(), modules: [], outputGainDb: -6 }
    const wet = await render({ prepared: { chain, modules: [] } })
    let error = 0
    for (let f = 512; f < dry.audio.length; f++) error = Math.max(error, Math.abs(wet.audio[f]! - dry.audio[f]! * 10 ** (-6 / 20)))
    expect(error).toBeLessThan(1e-6)
  })
  it.skipIf(!existsSync(namModel))('streams a real NAM model without rendering the 30 minute timeline', async () => {
    const model = await readFile(namModel, 'utf8'), chain = defaultEffectChain()
    delete chain.modules; chain.order = ['amp']; chain.amp = { ...chain.amp, enabled: true, engine: 'nam' }
    const wet = await render({ prepared: { chain, model, modelRate: JSON.parse(model).sample_rate ?? 48000, ir: null, irRate: 48000 } }, 6000)
    expect(Math.max(...wet.audio.map(Math.abs))).toBeGreaterThan(.0001)
    expect(wet.firstMs).toBeLessThan(1000)
  })
  it.skipIf(!existsSync(fixturePlugin))('streams through the real isolated VST3 worker and releases it', async () => {
    const scan = await runProcess(pluginHost, ['--scan', fixturePlugin])
    expect(scan.code).toBe(0)
    const definition = JSON.parse(scan.stdout).find((value: { validation: string }) => value.validation === 'available')
    const worker = new PluginWorker(pluginHost, path.join(root, 'plugin-worker'))
    try {
      await worker.start({ version: 1, inputGainDb: 0, outputGainDb: 0, nodes: [{ ...definition, kind: 'plugin', id: 'test', statePath: null }] }, 48000)
      const wet = await render({ pluginMapping: worker.mapping }, 96000)
      expect(Math.max(...wet.audio.map(Math.abs))).toBeGreaterThan(.001)
      expect((await worker.status()).fault).toBe(false)
    } finally { await worker.stop() }
    expect(existsSync(worker.mapping)).toBe(false)
  }, 15000)
})

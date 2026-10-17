// Opt-in comparison against the actual installed TONE3000 0.0.12 VST3.
// Captures and results stay local. No audio device or GUI is opened.
// node scripts/test-nam-plugin.mjs --model C:/captures/amp.nam --out output/nam-parity
import './lib/source-imports.mjs'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { tone3000State } from './lib/tone3000-state.mjs'
import createModule from '../src/renderer/src/arsenal/dsp/arsenal-dsp.js'

const { defaultEffectChain } = await import('../packages/shared/src/arsenal.ts')
const { namNormalizationGain } = await import('../src/main/nam.ts')
const { values } = parseArgs({ options: {
  model: { type: 'string', multiple: true }, out: { type: 'string' },
  rates: { type: 'string', default: '44100,48000,96000' },
  qualities: { type: 'string', default: 'full,lite' }, modes: { type: 'string', default: 'raw,normalized' },
  resume: { type: 'boolean', default: false },
  calibration: { type: 'string' }, plugin: { type: 'string', default: 'C:/Program Files/Common Files/VST3/TONE3000.vst3' }
} })
assert.ok(values.model?.length, 'Pass one or more --model paths to locally held A2 captures')
assert.equal(process.platform, 'win32', 'This installed-plugin regression currently supports Windows')
const rates = values.rates.split(',').map(Number), qualities = values.qualities.split(','), modes = values.modes.split(',')
assert.ok(rates.length && rates.every(rate => Number.isInteger(rate) && rate >= 8000 && rate <= 192000))
assert.ok(qualities.length && qualities.every(quality => ['full', 'lite'].includes(quality)))
assert.ok(modes.length && modes.every(mode => ['raw', 'normalized'].includes(mode)))
const calibration = values.calibration === undefined ? null : Number(values.calibration)
assert.ok(calibration === null || Number.isFinite(calibration) && calibration >= -30 && calibration <= 40)
const root = path.resolve(values.out ?? `output/nam-parity-${Date.now()}`)
await mkdir(root, { recursive: true })
const build = path.resolve('native/audio-host/build/win32-x64')
const host = process.env.BB_AUDIO_HOST ?? path.join(build, 'Release/bandbuddy-audio-host.exe')
const worker = process.env.BB_PLUGIN_HOST ?? path.join(build, 'plugin-host/Release/bandbuddy-plugin-host.exe')
const probe = path.join(build, 'Release/bandbuddy-audio-core-tests.exe')
const children = new Set(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 90000, windowsHide: true })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  return result.stdout
}
async function startWorker(manifest) {
  const child = spawn(worker, ['--worker', manifest], { windowsHide: true })
  children.add(child)
  let sequence = 0, stderr = '', resolveReady
  const pending = new Map(), lines = createInterface({ input: child.stdout })
  const ready = new Promise(resolve => { resolveReady = resolve })
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16000) })
  lines.on('line', line => {
    let message; try { message = JSON.parse(line) } catch { return }
    if (message.event === 'ready') resolveReady(message.data)
    const request = pending.get(message.id)
    if (request) {
      clearTimeout(request.timer); pending.delete(message.id)
      message.ok ? request.resolve(message.result) : request.reject(new Error(message.error))
    }
  })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => {
      children.delete(child); lines.close()
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Plugin Worker exited')) }
      pending.clear()
      code === 0 ? resolve() : reject(new Error(`Plugin Worker exited ${code}: ${stderr}`))
    })
  })
  done.catch(() => undefined)
  const lifetime = setTimeout(() => child.kill(), 90000)
  child.once('exit', () => clearTimeout(lifetime))
  await Promise.race([ready, done.then(() => { throw new Error('Plugin Worker did not become ready') })])
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  return { rpc, close: async () => { child.stdin.end(); await done } }
}
function inputSignal(rate) {
  // One second of leading silence lets both chains' start/swap fades settle.
  // Four seconds of plucked harmonics, transients and seeded broadband noise;
  // independent right channel exercises dual mono, followed by a second of tail.
  const samples = new Float32Array(rate * 6 * 2)
  let seed = 12345
  for (let frame = rate; frame < rate * 5; frame++) {
    const time = (frame - rate) / rate, age = time % .5
    let value = 0
    for (let harmonic = 1; harmonic <= 12; harmonic++) {
      value += Math.sin(2 * Math.PI * 82.4069 * harmonic * time + .13 * harmonic)
        * Math.exp(-age * (3 + harmonic * .6)) / harmonic
    }
    seed = (1664525 * seed + 1013904223) >>> 0
    value = .08 * value + .004 * (seed / 2 ** 32 - .5)
    samples[frame * 2] = value
    samples[frame * 2 + 1] = .6 * value + .015 * Math.sin(2 * Math.PI * 246.9417 * time)
  }
  return samples
}
function wave(samples, rate) {
  const bytes = Buffer.alloc(44 + samples.byteLength)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(2, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 8, 28); bytes.writeUInt16LE(8, 32)
  bytes.writeUInt16LE(32, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples.byteLength, 40)
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(bytes, 44)
  return bytes
}
function waveSamples(bytes) {
  for (let position = 12; position + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(position + 4)
    if (bytes.toString('ascii', position, position + 4) === 'data') {
      assert.ok(position + 8 + size <= bytes.length && size % 8 === 0)
      return new Float32Array(bytes.buffer.slice(bytes.byteOffset + position + 8, bytes.byteOffset + position + 8 + size))
    }
    position += 8 + size + size % 2
  }
  throw new Error('Missing WAV audio')
}
function metrics(actual, reference, firstFrame, lastFrame, referenceDelay = 0) {
  let error = 0, energy = 0, maxError = 0, frames = 0
  for (let frame = firstFrame; frame < lastFrame; frame++) for (let channel = 0; channel < 2; channel++) {
    const x = actual[frame * 2 + channel], y = reference[(frame + referenceDelay) * 2 + channel]
    assert.ok(Number.isFinite(x) && Number.isFinite(y), 'Invalid or truncated audio')
    error += (x - y) ** 2; energy += y * y; maxError = Math.max(maxError, Math.abs(x - y)); frames++
  }
  assert.ok(energy / frames > 1e-10, 'Reference output is silent')
  return { relativeRms: Math.sqrt(error / energy), maxError, samples: frames }
}
function wasmRender(module, prepared, source, rate) {
  const text = JSON.stringify(prepared), size = module.lengthBytesUTF8(text) + 1
  const spec = module._malloc(size)
  module.stringToUTF8(text, spec, size)
  const handle = module._bb_create(spec, rate)
  module._free(spec)
  assert.ok(handle, module.UTF8ToString(module._bb_error()))
  const latency = module._bb_latency(handle)
  const input = module._malloc(512 * 2 * 4), output = module._malloc(512 * 2 * 4)
  const result = new Float32Array(source.length + latency * 2)
  try {
    // 257-frame callbacks deliberately cross the DSP's 128-frame quantum.
    for (let frame = 0; frame < result.length / 2; frame += 257) {
      const frames = Math.min(257, result.length / 2 - frame)
      module.HEAPF32.fill(0, input / 4, input / 4 + frames * 2)
      module.HEAPF32.set(source.subarray(frame * 2, (frame + frames) * 2), input / 4)
      module._bb_process(handle, input, output, frames, 2)
      result.set(module.HEAPF32.subarray(output / 4, output / 4 + frames * 2), frame * 2)
    }
  } finally { module._bb_destroy(handle); module._free(input); module._free(output) }
  return { samples: result.subarray(latency * 2), latency }
}

const definitions = JSON.parse(run(worker, ['--scan', path.resolve(values.plugin)]))
const definition = definitions.find(item => item.name === 'TONE3000' && item.validation === 'available')
assert.ok(definition, 'Installed TONE3000 VST3 did not validate')
assert.equal(definition.version, '0.0.12', 'Reference state adapter must be reviewed for this installed plugin version')
const plugin = { ...definition, id: 'reference', kind: 'plugin' }
const wasmBytes = await readFile('src/renderer/src/arsenal/dsp/arsenal-dsp.wasm')
const module = await createModule({ wasmBinary: wasmBytes })
let report = { passed: false, plugin: definition, pluginSha256: hash(await readFile(path.join(values.plugin, 'Contents/x86_64-win/TONE3000.vst3'))),
  wasmSha256: hash(wasmBytes), nativeSha256: hash(await readFile(host)), workerSha256: hash(await readFile(worker)),
  settings: { inputGainDb: 0, outputGainDb: 0, inputMode: 'dual', oversampling: false,
    noiseGate: false, eq: false, cabinetIr: false, pitchShift: false, spread: false, calibration,
    leadingSilenceSeconds: 1, comparedSeconds: [1.2, 4.9], tolerance: 1e-4, maximumSampleError: 1e-4 }, cases: [] }
const reportPath = path.join(root, 'report.json')
if (values.resume) {
  const previous = JSON.parse(await readFile(reportPath, 'utf8'))
  for (const key of ['plugin', 'pluginSha256', 'wasmSha256', 'nativeSha256', 'workerSha256', 'settings']) {
    assert.deepEqual(previous[key], report[key], `Cannot resume after ${key} changed`)
  }
  assert.ok(previous.cases.every(c => values.model.some(model => path.resolve(model) === c.modelPath)
    && rates.includes(c.rate) && qualities.includes(c.quality) && modes.includes(c.mode)), 'Resume matrix differs')
  assert.equal(new Set(previous.cases.map(c => c.name)).size, previous.cases.length)
  report = { ...previous, passed: false }
  if (previous.error) report.previousFailures = [...(previous.previousFailures ?? []), { error: previous.error, casesCompleted: previous.cases.length }]
  delete report.error
}
const persist = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
await persist()
try {
  const mapping = path.join(root, `default-${randomUUID()}.shm`), manifest = path.join(root, 'default.json')
  await writeFile(manifest, JSON.stringify({ mapping, generation: 1, sampleRate: 48000,
    graph: { version: 1, nodes: [plugin], inputGainDb: 0, outputGainDb: 0 } }))
  const initial = await startWorker(manifest), defaultPath = path.join(root, `default-${randomUUID()}.bin`)
  try { await initial.rpc('save', { instanceId: 'reference', path: defaultPath }) } finally { await initial.close(); await rm(mapping, { force: true }) }
  const defaultState = await readFile(defaultPath)
  for (const modelArgument of values.model) {
    const modelPath = path.resolve(modelArgument), modelBytes = await readFile(modelPath), model = JSON.parse(modelBytes)
    assert.equal(model.architecture, 'SlimmableContainer', 'Use a Full/Lite A2 container for this regression')
    if (calibration !== null) assert.ok(typeof model.metadata?.input_level_dbu === 'number' && Number.isFinite(model.metadata.input_level_dbu), 'The model lacks input calibration')
    for (const rate of rates) for (const quality of qualities) for (const mode of modes) {
      const name = `${path.basename(modelPath).replace(/[^\w.-]/g, '_')}-${hash(modelBytes).slice(0, 8)}-${quality}-${rate}-${mode}`
      const directory = path.join(root, name); await mkdir(directory, { recursive: true })
      const source = inputSignal(rate), input = path.join(directory, 'input.wav')
      const inputBytes = wave(source, rate), existing = report.cases.find(c => c.name === name)
      const chain = defaultEffectChain(); chain.order = ['amp']; chain.dspRevision = 2
      chain.inputGainDb = 0; chain.outputGainDb = 0
      chain.amp.enabled = true; chain.amp.quality = quality; chain.amp.outputMode = mode
      chain.amp.calibration = calibration !== null; chain.amp.inputDbU = calibration
      const prepared = { chain, model: modelBytes.toString('utf8'), modelRate: model.sample_rate,
        ir: null, irRate: 48000, namInputGain: calibration === null ? 1 : 10 ** ((calibration - model.metadata.input_level_dbu) / 20),
        namOutputGain: mode === 'normalized' ? namNormalizationGain(model.metadata?.loudness) : 1 }
      if (existing) {
        // Revalidate the retained audio, not just a previous passed flag.
        assert.equal(existing.modelSha256, hash(modelBytes))
        assert.equal(existing.inputSha256, hash(inputBytes))
        assert.equal(hash(await readFile(input)), existing.inputSha256)
        assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'native.json'), 'utf8')).prepared, prepared,
          'Cannot resume after model preparation changed')
        assert.equal(existing.bridge.invalid, 0); assert.equal(existing.bridge.misses, 0)
        const official = waveSamples(await readFile(path.join(directory, 'tone3000.wav')))
        const native = waveSamples(await readFile(path.join(directory, 'bandbuddy-native.wav')))
        const wasm = waveSamples(await readFile(path.join(directory, 'bandbuddy-wasm.wav')))
        const first = Math.round(rate * 1.2), last = Math.round(rate * 4.9)
        assert.equal(official.length, source.length); assert.equal(native.length, source.length); assert.equal(wasm.length, source.length)
        assert.deepEqual(metrics(native, official, first, last, existing.bridge.latencyFrames), existing.native)
        assert.deepEqual(metrics(wasm, official, first, last, existing.bridge.latencyFrames), existing.wasm)
        for (const checked of [existing.native, existing.wasm]) {
          assert.ok(checked.relativeRms < report.settings.tolerance && checked.maxError < report.settings.maximumSampleError)
        }
        console.log(`Revalidated: ${name}`)
        continue
      }
      await writeFile(input, inputBytes)
      const nativePath = path.join(directory, 'bandbuddy-native.wav'), nativeJob = path.join(directory, 'native.json')
      await writeFile(nativeJob, JSON.stringify({ input, output: nativePath, prepared, tailSeconds: 0 }))
      run(host, ['--render-effects', nativeJob])
      const native = waveSamples(await readFile(nativePath)); assert.equal(native.length, source.length)
      const statePath = path.join(directory, 'reference.bin')
      await writeFile(statePath, tone3000State(defaultState, { modelPath, modelBytes, quality, normalized: mode === 'normalized', calibration }))
      const mapping = path.join(directory, `reference-${randomUUID()}.shm`), workerManifest = path.join(directory, 'worker.json')
      await writeFile(workerManifest, JSON.stringify({ mapping, generation: 1, sampleRate: rate,
        graph: { version: 1, inputGainDb: 0, outputGainDb: 0, nodes: [{ ...plugin, statePath }] } }))
      const officialPath = path.join(directory, 'tone3000.wav'), active = await startWorker(workerManifest)
      let bridge, status
      try {
        // The reference restores models asynchronously. The host message loop
        // remains active during this bounded settle period, before audio starts.
        await sleep(750)
        bridge = JSON.parse(run(probe, ['--bridge', mapping, input, officialPath]))
        status = await active.rpc('status')
      } finally { await active.close(); await rm(mapping, { force: true }) }
      assert.equal(bridge.invalid, 0); assert.equal(bridge.misses, 0, `Plugin deadline miss: ${JSON.stringify(bridge)}`)
      assert.equal(status.fault, 0, status.error)
      const official = waveSamples(await readFile(officialPath)); assert.equal(official.length, source.length)
      const first = Math.round(rate * 1.2), last = Math.round(rate * 4.9)
      // Apply only the published host/plugin PDC; no lag search, gain fitting,
      // normalization of rendered files, or other post-hoc correction.
      const nativeMetrics = metrics(native, official, first, last, bridge.latencyFrames)
      const wasm = wasmRender(module, prepared, source, rate)
      assert.equal(wasm.samples.length, source.length)
      const wasmMetrics = metrics(wasm.samples, official, first, last, bridge.latencyFrames)
      await writeFile(path.join(directory, 'bandbuddy-wasm.wav'), wave(wasm.samples, rate))
      const difference = new Float32Array(native.length)
      for (let i = 0; i + bridge.latencyFrames * 2 < official.length; i++) difference[i] = native[i] - official[i + bridge.latencyFrames * 2]
      await writeFile(path.join(directory, 'difference.wav'), wave(difference, rate))
      const result = { name, modelPath, modelSha256: hash(modelBytes), inputSha256: hash(inputBytes), rate, quality, mode,
        latencyFrames: { pluginAndBridge: bridge.latencyFrames, wasm: wasm.latency }, bridge, native: nativeMetrics, wasm: wasmMetrics }
      report.cases.push(result); await persist(); console.log(JSON.stringify(result))
      assert.ok(nativeMetrics.relativeRms < report.settings.tolerance, `Native mismatch: ${name}`)
      assert.ok(wasmMetrics.relativeRms < report.settings.tolerance, `WASM mismatch: ${name}`)
      assert.ok(nativeMetrics.maxError < report.settings.maximumSampleError, `Native peak mismatch: ${name}`)
      assert.ok(wasmMetrics.maxError < report.settings.maximumSampleError, `WASM peak mismatch: ${name}`)
    }
  }
  assert.equal(report.cases.length, values.model.length * rates.length * qualities.length * modes.length)
  report.passed = true; await persist(); console.log(`NAM/plugin comparison passed: ${reportPath}`)
} catch (error) { report.error = error.message; await persist(); throw error } finally {
  for (const child of children) child.kill()
}

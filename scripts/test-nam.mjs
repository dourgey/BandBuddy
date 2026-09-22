// Build native:audio and build:effects:wasm first. Optionally pass a downloaded
// Tone3000 A2 .nam file; captures stay local and are never bundled as fixtures.
// node scripts/test-nam.mjs [path/to/capture.nam]
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { defaultEffectChain } from '../packages/shared/src/arsenal.ts'
import createModule from '../src/renderer/src/arsenal/dsp/arsenal-dsp.js'

const root = process.cwd()
const nativeRoot = path.join(root, 'native/audio-host/build', `${process.platform}-${process.arch}`)
const suffix = process.platform === 'win32' ? '.exe' : ''
const native = process.env.BB_EFFECTS_TEST || path.join(nativeRoot, 'effects', `bandbuddy-effects-test${suffix}`)
const host = process.env.BB_AUDIO_HOST || path.join(nativeRoot, `bandbuddy-audio-host${suffix}`)
const m = await createModule({ wasmBinary: await readFile(path.join(root, 'src/renderer/src/arsenal/dsp/arsenal-dsp.wasm')) })
const dir = await mkdtemp(path.join(tmpdir(), 'bb-nam-dsp-'))
const leaf = gain => ({ version: '0.7.0', architecture: 'Linear', config: { receptive_field: 1, bias: false }, weights: [gain], sample_rate: 48000 })
const synthetic = { ...leaf(1), architecture: 'SlimmableContainer', weights: [], config: { submodels: [
  { max_value: .5, model: leaf(.25) }, { max_value: 1, model: leaf(.75) }
] } }
const models = [['synthetic', synthetic]]
if (process.argv[2]) models.push(['Tone3000', JSON.parse(await readFile(process.argv[2], 'utf8'))])
const frames = 8192, source = new Float32Array(frames * 2)
for (let i = 0; i < frames; ++i) {
  source[i * 2] = .15 * Math.sin(i * .053) + .025 * Math.sin(i * .197)
  source[i * 2 + 1] = .07 * Math.sin(i * .091)
}
function run(executable, args) {
  const r = spawnSync(executable, args, { encoding: 'utf8' })
  assert.equal(r.status, 0, r.error?.message || r.stderr)
}
function checkOutput(output) {
  assert.equal(output.length, source.length)
  assert.ok(output.every(Number.isFinite), 'non-finite audio')
  assert.ok(output.reduce((sum, x) => sum + x * x, 0) > 1e-8, 'silent audio')
}
function compare(a, b, tolerance = 1e-3) {
  let error = 0, energy = 0
  for (let i = 0; i < a.length; ++i) { error += (a[i] - b[i]) ** 2; energy += a[i] ** 2 }
  const relativeError = Math.sqrt(error / Math.max(energy, 1e-20))
  assert.ok(relativeError < tolerance, `render mismatch: ${relativeError}`)
  return relativeError
}
function wasm(prepared, rate = 48000) {
  const json = JSON.stringify(prepared), size = m.lengthBytesUTF8(json) + 1
  const spec = m._malloc(size), input = m._malloc(source.byteLength), output = m._malloc(source.byteLength)
  let handle = 0
  try {
    m.stringToUTF8(json, spec, size)
    handle = m._bb_create(spec, rate)
    assert.ok(handle, m.UTF8ToString(m._bb_error()))
    // Creating a model may grow WASM memory; read the current heap afterwards.
    m.HEAPF32.set(source, input / 4)
    m._bb_process(handle, input, output, frames, 2)
    const rendered = m.HEAPF32.slice(output / 4, output / 4 + source.length)
    checkOutput(rendered)
    return rendered
  } finally {
    if (handle) m._bb_destroy(handle)
    m._free(spec); m._free(input); m._free(output)
  }
}
async function renderNative(prepared, chunk = 128) {
  const spec = path.join(dir, 'prepared.json'), output = path.join(dir, 'wet.f32')
  await writeFile(spec, JSON.stringify(prepared))
  run(native, [spec, path.join(dir, 'dry.f32'), output, String(chunk)])
  const bytes = await readFile(output)
  const rendered = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  checkOutput(rendered)
  return rendered
}
try {
  await writeFile(path.join(dir, 'dry.f32'), new Uint8Array(source.buffer))
  for (const [name, model] of models) {
    assert.equal(model.architecture, 'SlimmableContainer')
    const outputs = []
    for (const quality of ['lite', 'full']) {
      const chain = defaultEffectChain(); chain.amp.enabled = true; chain.amp.quality = quality
      const prepared = { chain, model: JSON.stringify(model), modelRate: model.sample_rate, ir: null, irRate: 48000 }
      const rendered = await renderNative(prepared)
      const wasmError = compare(rendered, wasm(prepared))
      compare(rendered, await renderNative(prepared, 257), 1e-7)
      const children = model.config.submodels
      const child = children[quality === 'lite' ? 0 : children.length - 1].model
      const standalone = { ...prepared, model: JSON.stringify(child) }
      compare(rendered, await renderNative(standalone), 1e-7)
      compare(wasm(prepared), wasm(standalone), 1e-7)
      wasm(prepared, 44100) // Also exercise model-rate conversion in browser playback.
      // The actual audio-host executable must retain parsers as well.
      const header = Buffer.alloc(44)
      header.write('RIFF'); header.writeUInt32LE(36 + source.byteLength, 4); header.write('WAVEfmt ', 8)
      header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(2, 22)
      header.writeUInt32LE(48000, 24); header.writeUInt32LE(48000 * 8, 28)
      header.writeUInt16LE(8, 32); header.writeUInt16LE(32, 34); header.write('data', 36); header.writeUInt32LE(source.byteLength, 40)
      const input = path.join(dir, 'dry.wav'), output = path.join(dir, 'wet.wav'), job = path.join(dir, 'job.json')
      await writeFile(input, Buffer.concat([header, Buffer.from(source.buffer)]))
      await writeFile(job, JSON.stringify({ input, output, prepared, tailSeconds: 0 }))
      run(host, ['--render-effects', job])
      const wave = await readFile(output)
      let audio
      for (let p = 12; p + 8 <= wave.length;) {
        const size = wave.readUInt32LE(p + 4)
        if (wave.toString('ascii', p, p + 4) === 'data') audio = wave.subarray(p + 8, p + 8 + size)
        p += 8 + size + size % 2
      }
      assert.ok(audio, 'export missing audio')
      checkOutput(new Float32Array(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength)))
      outputs.push(rendered)
      console.log(`${name} ${quality}: native/WASM RMS error=${wasmError}; child selection, chunking, 44.1 kHz and WAV export passed`)
    }
    assert.ok(outputs[0].some((x, i) => Math.abs(x - outputs[1][i]) > 1e-5), 'Full/Lite selected the same model')
  }
} finally { await rm(dir, { recursive: true, force: true }) }

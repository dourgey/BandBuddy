import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Build with BANDBUDDY_AUDIO_CORE_TESTS=ON and BANDBUDDY_PLUGIN_TEST_FIXTURE=ON.
const build = path.resolve(process.argv[2] ?? `native/audio-host/build/${process.platform}-${process.arch}`)
const win = process.platform === 'win32', suffix = win ? '.exe' : ''
const host = process.env.BANDBUDDY_TEST_AUDIO_HOST ?? path.join(build, ...(win ? ['Release'] : []), `bandbuddy-audio-host${suffix}`)
const workerExe = process.env.BANDBUDDY_TEST_PLUGIN_HOST ?? path.join(build, 'plugin-host', ...(win ? ['Release'] : []), `bandbuddy-plugin-host${suffix}`)
const probe = path.join(build, ...(win ? ['Release'] : []), `bandbuddy-audio-core-tests${suffix}`)
const plugin = path.join(build, 'VST3', 'Release', 'bandbuddy-test-delay.vst3')
const root = await mkdtemp(path.join(tmpdir(), 'BandBuddy 插件 🎸-'))
const children = new Set()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function launch(exe, args) {
  const child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); children.add(child)
  let stdout = '', stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', code => { children.delete(child); code === 0 ? resolve(stdout) : reject(new Error(`${path.basename(exe)} exited ${code}: ${stderr}`)) })
  }); completed.catch(() => undefined)
  return { child, completed }
}
function rpcProcess(exe, args) {
  const process = launch(exe, args), pending = new Map(), events = []; let sequence = 0, ready
  const initialized = new Promise(resolve => { ready = resolve })
  const lines = createInterface({ input: process.child.stdout })
  lines.on('line', line => {
    let message; try { message = JSON.parse(line) } catch { return }
    if (message.event) { events.push(message); if (message.event === 'ready') ready(message.data); return }
    const request = pending.get(message.id); if (!request) return
    clearTimeout(request.timer); pending.delete(message.id); message.ok ? request.resolve(message.result) : request.reject(new Error(message.error))
  })
  process.child.once('exit', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('RPC process exited')) }; pending.clear(); lines.close() })
  return { ...process, events, initialized, rpc: (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timer }); process.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  }) }
}
async function worker(name, definition, statePath = null) {
  const manifest = path.join(root, `${name}.json`), mapping = path.join(root, `${name}.shm`)
  const graph = { version: 1, inputGainDb: 0, outputGainDb: 0, nodes: [{ ...definition, id: 'delay', kind: 'plugin', statePath }] }
  await writeFile(manifest, JSON.stringify({ mapping, generation: 1, sampleRate: 48000, graph }))
  const child = rpcProcess(workerExe, ['--worker', manifest])
  const timeout = setTimeout(() => child.child.kill(), 30000)
  try { await Promise.race([child.initialized, child.completed.then(() => { throw new Error('worker not ready') })]) } finally { clearTimeout(timeout) }
  return { ...child, graph, mapping }
}
function waveSamples(bytes) {
  for (let p = 12; p + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(p + 4)
    if (bytes.toString('ascii', p, p + 4) === 'data') return new Float32Array(bytes.buffer.slice(bytes.byteOffset + p + 8, bytes.byteOffset + p + 8 + size))
    p += 8 + size + size % 2
  }
  throw new Error('WAV data chunk missing')
}
try {
  const scanned = JSON.parse((await launch(workerExe, ['--scan', plugin]).completed).trim())
  const definition = scanned.find(p => p.validation === 'available'); assert.ok(definition, 'real SDK VST3 scan')
  const first = await worker('live', definition)
  const parameters = await first.rpc('parameters', { instanceId: 'delay' })
  const delay = parameters.find(p => p.name === 'Delay'); assert.ok(delay)
  await first.rpc('parameter', { instanceId: 'delay', parameterId: delay.id, value: .125 })
  const input = path.join(root, 'input.wav'), wet = path.join(root, 'wet.wav'), state = path.join(root, 'state.bin')
  const data = Buffer.alloc(44 + 48000 * 3 * 8)
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16)
  data.writeUInt16LE(3, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(48000, 24); data.writeUInt32LE(384000, 28); data.writeUInt16LE(8, 32); data.writeUInt16LE(32, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40)
  for (let f = 0; f < 48000 * 3; ++f) for (let c = 0; c < 2; ++c) data.writeFloatLE(.2 * Math.sin((f + 1) * .057 + c * .31), 44 + (f * 2 + c) * 4)
  await writeFile(input, data)
  const bridge = JSON.parse((await launch(probe, ['--bridge', first.mapping, input, wet]).completed).trim())
  const workerStatus = await first.rpc('status')
  await first.rpc('save', { instanceId: 'delay', path: state }); first.child.stdin.end(); await first.completed
  const second = await worker('restored', definition, state)
  const restored = await second.rpc('parameters', { instanceId: 'delay' }); assert.ok(Math.abs(restored.find(p => p.id === delay.id).value - .125) < 1e-6, 'full component/controller restore')
  const offline = path.join(root, 'offline.wav'), renderManifest = path.join(root, 'render.json')
  await writeFile(renderManifest, JSON.stringify({ input, output: offline, graph: second.graph }))
  const rendered = JSON.parse((await launch(workerExe, ['--render', renderManifest]).completed).trim())
  const realtime = waveSamples(await readFile(wet)), reference = waveSamples(await readFile(offline))
  let compared = 0, maxError = 0, nonzero = 0
  for (let i = 4096; i < realtime.length; ++i) {
    if (Math.abs(realtime[i]) > .001) { ++nonzero; const error = Math.abs(realtime[i] - reference[i - bridge.latencyFrames * 2]); maxError = Math.max(maxError, error); if (error < 1e-5) ++compared }
  }
  assert.ok(nonzero > 100000 && compared / nonzero > .98, `real-time/offline match: ${compared}/${nonzero}, max ${maxError}; bridge ${JSON.stringify(bridge)}`)
  second.child.stdin.end(); await second.completed
  const variableBlocks = []
  for (const frames of [480, 1536]) {
    const variable = await worker(`variable-${frames}`, definition, state)
    const file = path.join(root, `variable-${frames}.wav`)
    const metrics = JSON.parse((await launch(probe, ['--bridge', variable.mapping, input, file, String(frames)]).completed).trim())
    const samples = waveSamples(await readFile(file)); let matches = 0, tested = 0
    for (let i = 48000; i < samples.length; ++i) if (Math.abs(samples[i]) > .001) { ++tested; if (Math.abs(samples[i] - reference[i - metrics.latencyFrames * 2]) < 1e-5) ++matches }
    assert.ok(tested > 150000 && matches / tested > .98, `variable ${frames}-frame bridge: ${matches}/${tested}`)
    variableBlocks.push({ frames, ...metrics, match: matches / tested }); variable.child.stdin.end(); await variable.completed
  }
  const crashing = await worker('crash', definition, state), core = rpcProcess(host, ['--simulate'])
  const [device] = await core.rpc('devices')
  await core.rpc('startTest', { backend: device.backend, inputDeviceId: device.id, outputDeviceId: device.id, inputChannels: [0, 1], sampleRate: 48000, bufferFrames: 128, monitorMode: 2, pluginMapping: crashing.mapping })
  const dry = path.join(root, 'surviving-dry.wav')
  await core.rpc('arsenalQuick', { action: 'record', path: dry }); await sleep(250)
  const before = await core.rpc('arsenalQuick', { action: 'state' }); crashing.child.kill(); await sleep(500)
  const after = await core.rpc('arsenalQuick', { action: 'stopRecord' })
  assert.ok(after.frames > before.frames + 12000, 'raw capture continues after plugin termination')
  assert.ok(core.events.some(e => e.event === 'meter' && e.data.plugin?.deadlineMisses > 0), 'missed wet blocks are diagnosed')
  const samples = waveSamples(await readFile(dry)); assert.ok(samples.some(v => Math.abs(v) > .1)); assert.ok(samples.every(v => Number.isFinite(v) && Math.abs(v) < .251))
  await core.rpc('stopTest'); await core.rpc('shutdown'); await core.completed
  console.log(JSON.stringify({ passed: true, plugin: definition.name, workerRealtimePriority: workerStatus.realtimePriority, bridge, variableBlocks, rendered, realtimeOfflineMatch: compared / nonzero, dryFramesBeforeCrash: before.frames, dryFramesAfterCrash: after.frames }))
} finally {
  for (const child of children) child.kill()
  await sleep(150); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

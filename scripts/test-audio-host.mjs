import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

const executable = process.argv[2] ?? path.join(
  process.cwd(),
  'resources',
  'audio-host',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'bandbuddy-audio-host.exe' : 'bandbuddy-audio-host'
)
if (!existsSync(executable)) throw new Error(`Audio host is missing: ${executable}`)

const root = mkdtempSync(path.join(tmpdir(), 'bandbuddy-audio-host-'))
const backingPath = path.join(root, 'backing.wav')
const capturePath = path.join(root, 'capture.part.wav')
const driftBackingPath = path.join(root, 'drift-backing.wav')
const driftCapturePath = path.join(root, 'drift-capture.part.wav')
const pauseBackingPath = path.join(root, 'pause-backing.wav')
const pauseCapturePath = path.join(root, 'pause-capture.part.wav')
const longBackingPath = path.join(root, 'long-backing.wav')
const longCapturePath = path.join(root, 'long-capture.part.wav')
writeFloatWave(backingPath, 48_000, 2, 4_800)
writeFloatWave(driftBackingPath, 48_000, 2, 288_000)
writeFloatWave(pauseBackingPath, 48_000, 2, 96_000)
writeSparseFloatWave(longBackingPath, 48_000, 2, 48_000 * 60 * 10)

const child = spawn(executable, ['--simulate'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
const lines = createInterface({ input: child.stdout })
let sequence = 0
const pending = new Map()
const eventWaiters = new Map()
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
const rejectPending = (reason) => {
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.reject(reason)
  }
  pending.clear()
}
child.once('error', rejectPending)
child.once('exit', (code, signal) => rejectPending(new Error(`Audio host exited during test: ${code ?? signal ?? 'unknown'}; ${stderr}`)))
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.event) {
    const waiters = eventWaiters.get(message.event) ?? []
    eventWaiters.delete(message.event)
    for (const resolve of waiters) resolve(message.data)
    return
  }
  const request = pending.get(message.id)
  if (!request) return
  clearTimeout(request.timer)
  pending.delete(message.id)
  if (message.ok) request.resolve(message.result)
  else request.reject(new Error(message.error || 'AUDIO_HOST_TEST_RPC_FAILED'))
})

function rpc(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out calling ${method}; ${stderr}`))
    }, 15_000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
      if (!error) return
      clearTimeout(timer)
      pending.delete(id)
      reject(error)
    })
  })
}

function nextEvent(name, timeoutMs = 15_000, label = name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}; ${stderr}`)), timeoutMs)
    const wrapped = (value) => { clearTimeout(timer); resolve(value) }
    eventWaiters.set(name, [...(eventWaiters.get(name) ?? []), wrapped])
  })
}

function waitForExit() {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    child.once('exit', resolve)
    child.once('error', reject)
  })
}

try {
  const devices = await rpc('devices')
  if (!Array.isArray(devices) || devices.length < 2 || devices[0].inputChannels !== 2) throw new Error('Simulated device enumeration failed')
  const device = devices[0]
  const base = {
    backend: device.backend,
    inputDeviceId: device.id,
    outputDeviceId: device.id,
    inputChannels: [0, 1],
    sampleRate: 48_000,
    bufferFrames: 128,
    softwareMonitoring: true,
    monitorGainDb: -6
  }
  const meterEvent = nextEvent('meter')
  await rpc('startTest', base)
  const meter = await meterEvent
  if (!Array.isArray(meter.peak) || meter.peak[0] <= meter.peak[1] || meter.peak[1] <= 0) throw new Error('Simulated channel meter failed')
  await rpc('stopTest')

  const finishedEvent = nextEvent('finished', 15_000, 'duplex finished')
  await rpc('start', {
    ...base,
    backingPath,
    capturePath,
    playbackRate: 1,
    startPositionMs: 0,
    endPositionMs: 100,
    metronomeEnabled: true,
    metronomeBpm: 600,
    metronomeOffsetMs: 0,
    countInBeats: 4,
    simulateXrunEveryCallbacks: 3
  })
  const finished = await finishedEvent
  if (finished.frames <= 0 || finished.channels !== 2 || finished.xruns <= 0) throw new Error('Simulated recording result failed')
  const capture = readFileSync(capturePath)
  if (capture.length <= 44 || capture.subarray(0, 4).toString('ascii') !== 'RIFF') throw new Error('Simulated WAV capture failed')
  const captureFrames = capture.readUInt32LE(40) / (finished.channels * 4)
  if (captureFrames !== finished.frames || captureFrames >= 4 * 60 / 600 * 48_000) {
    throw new Error('Count-in leaked into the simulated capture')
  }

  const pauseMeterEvent = nextEvent('meter')
  const pauseStart = await rpc('start', {
    ...base,
    backingPath: pauseBackingPath,
    capturePath: pauseCapturePath,
    playbackRate: 1,
    startPositionMs: 0,
    endPositionMs: 2_000,
    metronomeEnabled: false,
    metronomeBpm: 120,
    metronomeOffsetMs: 0,
    countInBeats: 0,
    simulateTimeScale: 0.5
  })
  if (!pauseStart.streamingBacking || pauseStart.backingBufferFrames > 48_000 * 10) {
    throw new Error('Backing file is not using the bounded streaming reader')
  }
  await pauseMeterEvent
  await rpc('pause')
  const pausedOne = await nextEvent('meter')
  const pausedTwo = await nextEvent('meter')
  if (!pausedOne.paused || !pausedTwo.paused
      || pausedOne.sourcePositionMs !== pausedTwo.sourcePositionMs
      || pausedOne.captureFrames !== pausedTwo.captureFrames) {
    throw new Error('Pause advanced transport or capture frames')
  }
  await rpc('resume')
  let resumed = await nextEvent('meter')
  for (let attempt = 0; attempt < 5 && resumed.sourcePositionMs <= pausedTwo.sourcePositionMs; attempt += 1) {
    resumed = await nextEvent('meter')
  }
  if (resumed.paused || resumed.sourcePositionMs <= pausedTwo.sourcePositionMs
      || resumed.captureFrames <= pausedTwo.captureFrames) {
    throw new Error('Resume did not continue the same take')
  }
  const pausedStop = await rpc('stop')
  if (!pausedStop || pausedStop.frames <= 0) throw new Error('Paused session did not save its capture')

  const longMeterEvent = nextEvent('meter')
  const longStart = await rpc('start', {
    ...base,
    backingPath: longBackingPath,
    capturePath: longCapturePath,
    playbackRate: 1,
    startPositionMs: 0,
    endPositionMs: 600_000,
    metronomeEnabled: false,
    metronomeBpm: 120,
    metronomeOffsetMs: 0,
    countInBeats: 0,
    simulateTimeScale: 1
  })
  if (!longStart.streamingBacking || longStart.backingBufferFrames !== 48_000 * 10) {
    throw new Error('Long backing exceeded the configured streaming buffer')
  }
  await longMeterEvent
  await rpc('stop')

  const driftFinishedEvent = nextEvent('finished', 30_000, 'split-clock finished')
  await rpc('start', {
    ...base,
    inputDeviceId: devices[1].id,
    outputDeviceId: devices[0].id,
    bufferFrames: 256,
    backingPath: driftBackingPath,
    capturePath: driftCapturePath,
    playbackRate: 1,
    startPositionMs: 0,
    endPositionMs: 6_000,
    metronomeEnabled: false,
    metronomeBpm: 120,
    metronomeOffsetMs: 0,
    countInBeats: 0,
    simulateInputClockPpm: 5_000,
    simulateTimeScale: 0.01
  })
  const driftFinished = await driftFinishedEvent
  if (!driftFinished.clockCorrectionRatio || Math.abs(driftFinished.clockCorrectionRatio - 1) < 0.001) throw new Error('Split-clock drift was not detected')
  if (!(driftFinished.inputStartOutputFrames > 0) || !(driftFinished.inputCaptureStartNs > 0) || !(driftFinished.outputTransportStartNs > 0)) {
    throw new Error('Split-clock timestamps were not captured')
  }
  const correctedMs = driftFinished.frames / (48_000 * driftFinished.clockCorrectionRatio) * 1000
  const masterMs = driftFinished.correctionOutputFrames / 48_000 * 1000
  if (Math.abs(correctedMs - masterMs) > 10) throw new Error(`Split-clock residual drift is ${Math.abs(correctedMs - masterMs)} ms`)
  await rpc('shutdown')
  await waitForExit()
  process.stdout.write(`${JSON.stringify({ ok: true, devices: devices.length, frames: finished.frames, xruns: finished.xruns, clockCorrectionRatio: driftFinished.clockCorrectionRatio })}\n`)
} finally {
  lines.close()
  if (child.exitCode === null) {
    child.kill()
    await waitForExit().catch(() => {})
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

function writeFloatWave(file, sampleRate, channels, frames) {
  const bytes = frames * channels * 4
  const buffer = Buffer.alloc(44 + bytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + bytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(3, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * 4, 28)
  buffer.writeUInt16LE(channels * 4, 32)
  buffer.writeUInt16LE(32, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(bytes, 40)
  writeFileSync(file, buffer)
}

function writeSparseFloatWave(file, sampleRate, channels, frames) {
  const bytes = frames * channels * 4
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + bytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(3, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 4, 28)
  header.writeUInt16LE(channels * 4, 32)
  header.writeUInt16LE(32, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(bytes, 40)
  const descriptor = openSync(file, 'w')
  try {
    writeSync(descriptor, header)
    ftruncateSync(descriptor, 44 + bytes)
  } finally {
    closeSync(descriptor)
  }
}

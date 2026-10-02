import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import assert from 'node:assert/strict'

// Opt-in hardware regression: requires a connected Hotone/Ampero interface.
const executable = process.argv[2] ?? 'resources/audio-host/win32-x64/bandbuddy-audio-host.exe'
for (const backend of ['asio', 'wasapi-shared']) {
  const child = spawn(executable, [], { windowsHide: true })
  const pending = new Map()
  let sequence = 0, meters = 0, peak = 0
  const lines = createInterface({ input: child.stdout })
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.stderr.pipe(process.stderr)
  lines.on('line', line => {
    const message = JSON.parse(line)
    if (message.event === 'meter') { meters++; peak = Math.max(peak, ...message.data.peak) }
    const callback = pending.get(message.id)
    if (callback) { pending.delete(message.id); callback(message) }
  })
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 10000)
    pending.set(id, message => {
      clearTimeout(timer)
      message.ok ? resolve(message.result) : reject(new Error(message.error))
    })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  try {
    const devices = await rpc('devices')
    const matches = devices.filter(d => d.backend === backend && /hotone|ampero/i.test(d.name))
    const input = matches.find(d => d.inputChannels)
    const output = matches.find(d => d.outputChannels)
    assert.ok(input && output, `Hotone ${backend} input/output missing`)
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await rpc('startTest', { backend, inputDeviceId: input.id, outputDeviceId: output.id,
        inputChannels: [0], sampleRate: 48000, bufferFrames: 256 })
      assert.equal(result.streamingBacking, false)
      assert.equal(result.backingBufferFrames, 0)
      const previousMeters = meters
      await new Promise(resolve => setTimeout(resolve, 1200))
      assert.ok(meters > previousMeters, 'No live input meter events')
      await rpc('stopTest')
    }
    await rpc('shutdown')
    assert.equal(await exited, 0)
    console.log(JSON.stringify({ backend, input: input.name, output: output.name, meters, peak, ok: true }))
  } finally { child.kill(); lines.close() }
}

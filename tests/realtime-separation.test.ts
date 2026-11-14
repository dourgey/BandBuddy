import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeSeparationService } from '../src/main/realtime-separation.js'
import { DEFAULT_REALTIME_CONFIG, realtimePassed, type RealtimeMetrics } from '../packages/shared/src/realtime-separation.js'
import type { AppPaths } from '../src/main/paths.js'
import type { RuntimeManager } from '../src/main/runtime.js'
import type { BandBuddyDatabase } from '../src/main/database.js'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), run: vi.fn() }))
vi.mock('electron', () => ({ app: { getAppMetrics: () => [{ pid: 17 }] }, shell: { openExternal: vi.fn() } }))
vi.mock('../src/main/process.js', () => ({ spawnSafe: mocks.spawn, runProcess: mocks.run }))
vi.mock('node:fs', () => ({ existsSync: () => true, statSync: () => ({ size: 10, mtimeMs: 100 }) }))
const devices = [{ id: 'source', name: 'virtual', kind: 'loopback', input: true, output: true }, { id: 'sink', name: 'speaker', kind: 'device', input: false, output: true }]
const metrics: RealtimeMetrics = { passed: true, signalVerified: true, p99Ms: 50, maxMs: 70, latencyMs: 500, inputDrops: 0, underruns: 0, overflows: 0, clockErrors: 0 }
let sqlite: DatabaseSync, service: RealtimeSeparationService, child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough }
let busy = false, job = false
beforeEach(() => {
  busy = false; job = false; sqlite = new DatabaseSync(':memory:')
  mocks.run.mockResolvedValue({ code: 0, stdout: JSON.stringify({ type: 'devices', devices }) })
  mocks.spawn.mockImplementation((_command, _args, options) => {
    child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
    child.stdin.on('data', data => { if (JSON.parse(data.toString()).op === 'stop') queueMicrotask(() => child.emit('close', 0)) })
    options.signal.addEventListener('abort', () => queueMicrotask(() => child.emit('close', 1)), { once: true })
    return child
  })
  service = new RealtimeSeparationService({ audioHostExecutable: () => '/native/host' } as AppPaths,
    { sqlite, getSettings: () => ({ modelRoot: '/models' }) } as unknown as BandBuddyDatabase,
    { getInfo: () => ({ status: 'ready', selectedDevice: 'cuda', torchVersion: 'test' }), onChange: vi.fn(), workerScript: () => '/worker/worker.py', pythonExecutable: () => '/python' } as unknown as RuntimeManager,
    vi.fn(), () => busy, () => job, vi.fn())
  service.configure({ ...DEFAULT_REALTIME_CONFIG, source: 'source', output: 'sink' })
})
afterEach(async () => { await service.shutdown(); sqlite.close(); vi.clearAllMocks() })
async function testSuccess(): Promise<void> {
  await service.begin(true)
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled())
  child.stdout.write(JSON.stringify({ type: 'result', result: metrics }) + '\n')
  child.emit('close', 0)
  await vi.waitFor(() => expect(service.active).toBe(false))
}
describe('realtime admission and lifecycle', () => {
  it('rejects start before testing and validates the complete gate', async () => {
    await expect(service.begin(false)).rejects.toThrow('性能测试')
    expect(realtimePassed(DEFAULT_REALTIME_CONFIG, metrics)).toBe(true)
    expect(realtimePassed({ ...DEFAULT_REALTIME_CONFIG, profile: 'lowLatency' }, metrics)).toBe(false)
    expect(realtimePassed(DEFAULT_REALTIME_CONFIG, { ...metrics, signalVerified: false })).toBe(false)
    expect(realtimePassed(DEFAULT_REALTIME_CONFIG, { ...metrics, underruns: 1 })).toBe(false)
  })
  it('allows mix changes after passing but revokes changed device settings', async () => {
    await testSuccess()
    expect(service.state().eligible).toBe(true)
    service.mix({ stems: ['drums', 'vocals'], mode: 'solo' })
    expect(service.state().eligible).toBe(true)
    service.configure({ ...service.state().config, rate: 44100 })
    await expect(service.begin(false)).rejects.toThrow('性能测试')
  })
  it('can cancel while waiting without spawning a worker', async () => {
    job = true; await service.begin(true)
    expect(service.state().phase).toBe('waiting')
    await expect(service.begin(true)).rejects.toThrow('已在运行')
    await service.stop()
    expect(service.active).toBe(false)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('excludes recording and releases an opened worker on stop', async () => {
    busy = true; await expect(service.begin(true)).rejects.toThrow('录音')
    busy = false; await service.begin(true)
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled())
    await service.stop()
    expect(service.state()).toMatchObject({ phase: 'idle', eligible: false })
  })
  it('revokes approval after device disappearance and worker errors', async () => {
    await testSuccess()
    await service.begin(false)
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2))
    child.stdout.write(JSON.stringify({ type: 'error', error: 'DEVICE_DISCONNECTED' }) + '\n'); child.emit('close', 1)
    await vi.waitFor(() => expect(service.state().phase).toBe('failed'))
    expect(service.state().eligible).toBe(false)
  })
  it.each(['PERMISSION_DENIED', 'INFERENCE_TIMEOUT', 'BUFFER_OVERFLOW'])('releases and permits retesting after %s', async error => {
    await service.begin(true)
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled())
    child.stdout.write(JSON.stringify({ type: 'error', error }) + '\n'); child.emit('close', 1)
    await vi.waitFor(() => expect(service.active).toBe(false))
    expect(service.state()).toMatchObject({ phase: 'failed', eligible: false, message: error })
    await testSuccess()
    expect(service.state().eligible).toBe(true)
  })
  it('invalidates the grant on device topology change and sleep', async () => {
    await testSuccess()
    mocks.run.mockResolvedValue({ code: 0, stdout: JSON.stringify({ type: 'devices', devices: devices.slice(0, 1) }) })
    await service.capabilities()
    expect(service.state().eligible).toBe(false)
    mocks.run.mockResolvedValue({ code: 0, stdout: JSON.stringify({ type: 'devices', devices }) })
    await testSuccess()
    await service.invalidate('系统休眠后需要重测')
    await expect(service.begin(false)).rejects.toThrow('性能测试')
  })
  it('applies mix updates without interrupting playback and awaits duplicate stops', async () => {
    await testSuccess()
    await service.begin(false)
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2))
    const writes = vi.spyOn(child.stdin, 'write')
    service.mix({ stems: ['guitar', 'piano'], mode: 'solo' })
    expect(writes).toHaveBeenCalledWith(JSON.stringify({ op: 'mix', stems: ['guitar', 'piano'], mode: 'solo' }) + '\n')
    expect(service.active).toBe(true)
    await Promise.all([service.stop(), service.stop()])
    expect(service.active).toBe(false)
    expect(service.state().eligible).toBe(true)
  })
  it('kills an unresponsive inference worker and clears admission', async () => {
    vi.useFakeTimers()
    try {
      await service.begin(true)
      await vi.advanceTimersByTimeAsync(121000)
      expect(service.active).toBe(false)
      expect(service.state()).toMatchObject({ phase: 'failed', eligible: false })
      expect(service.state().message).toContain('响应超时')
    } finally { vi.useRealTimers() }
  })
})

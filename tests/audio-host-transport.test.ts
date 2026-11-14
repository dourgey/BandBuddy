import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AudioHostClient } from '../src/main/audio-host.js'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('../src/main/process.js', () => ({ spawnSafe: mocks.spawn }))
vi.mock('node:fs', () => ({ existsSync: () => true }))

describe('native audio transport', () => {
  it('refreshes the ASIO clock before starting, but never probes a driver owned by a live session', async () => {
    let currentSampleRate = 44_100
    let probes = 0
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false, kill: vi.fn() })
      child.stdin.on('data', chunk => {
        const { id, method } = JSON.parse(chunk.toString())
        if (method === 'devices') probes++
        const result = method === 'devices' ? [{ id: 'asio:0', backend: 'asio', currentSampleRate }] : true
        child.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n')
        if (method === 'shutdown') child.emit('exit', 0, null)
      })
      return child
    })
    const client = new AudioHostClient({ audioHostExecutable: () => 'host' } as never, { warn: vi.fn(), error: vi.fn() } as never)
    expect((await client.devicesForSession('asio'))[0]?.currentSampleRate).toBe(44_100)
    currentSampleRate = 96_000
    expect((await client.devicesForSession('asio'))[0]?.currentSampleRate).toBe(96_000)
    expect(probes).toBe(2)
    await client.startTest({ backend: 'asio', sampleRate: 96_000 })
    await client.devicesForSession('asio')
    expect(probes).toBe(2)
    await client.shutdown()
  })

  it('preserves selected devices, native build/stage and the Windows exception code on a crash', async () => {
    const children: EventEmitter[] = []
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false, kill: vi.fn() })
      children.push(child)
      child.stdin.on('data', chunk => {
        const { id, method } = JSON.parse(chunk.toString())
        if (method === 'startTest') {
          child.stderr.write('{"stage":"host-ready","build":"test-build","portaudio":"19.7"}\n')
          child.stderr.write('{"stage":"startTest","backend":"asio"}\n')
          child.emit('exit', 3221225477, null)
        } else {
          child.stdout.write(JSON.stringify({ id, ok: true, result: true }) + '\n')
          if (method === 'shutdown') child.emit('exit', 0, null)
        }
      })
      return child
    })
    const client = new AudioHostClient({ audioHostExecutable: () => 'host' } as never, { warn: vi.fn(), error: vi.fn() } as never)
    const event = vi.fn()
    client.onEvent(event)
    await expect(client.startTest({ backend: 'asio', inputDeviceId: 'asio:1', outputDeviceId: 'asio:2', sampleRate: 48000, bufferFrames: 256, capturePath: 'private.wav' }))
      .rejects.toMatchObject({ code: 'AUDIO_HOST_EXITED', details: {
        backend: 'asio', inputDeviceId: 'asio:1', outputDeviceId: 'asio:2', operation: 'startTest',
        sampleRate: 48000, bufferFrames: 256, exitCodeHex: '0xC0000005', exception: 'ACCESS_VIOLATION',
        component: { build: 'test-build', portaudio: '19.7' },
        stderr: [expect.stringContaining('test-build'), expect.stringContaining('startTest')]
      } })
    const evidence = event.mock.calls.find(([value]) => value.event === 'crashed')?.[0].data.evidence
    expect(JSON.stringify(evidence)).not.toContain('private.wav')
    expect(evidence.details.backend).toBe('asio')
    // A subsequent process must not inherit the old device/driver evidence.
    await client.pause()
    children[1]!.emit('exit', -1073741819, null)
    expect(event.mock.calls.at(-1)?.[0].data.evidence.details).toMatchObject({ backend: 'not-selected', component: {}, stderr: [], exitCodeHex: '0xC0000005' })
  })
  it('probes only the selected recording backend and reuses a recent device inventory', async () => {
    const probes: string[] = []
    mocks.spawn.mockImplementation((_exe, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false, kill: vi.fn() })
      child.stdin.on('data', chunk => {
        const { id, method } = JSON.parse(chunk.toString())
        if (method === 'devices') probes.push(args[1]!)
        child.stdout.write(JSON.stringify({ id, ok: true, result: method === 'devices'
          ? [{ id: 'wasapi-shared:0', backend: 'wasapi-shared' }, { id: 'wasapi-exclusive:0', backend: 'wasapi-exclusive' }] : true }) + '\n')
        if (method === 'shutdown') child.emit('exit', 0, null)
      })
      return child
    })
    const client = new AudioHostClient({ audioHostExecutable: () => 'host' } as never, { warn: vi.fn(), error: vi.fn() } as never)
    expect(await client.devicesForSession('wasapi-shared')).toEqual([{ id: 'wasapi-shared:0', backend: 'wasapi-shared' }])
    expect(await client.devicesForSession('wasapi-exclusive')).toEqual([{ id: 'wasapi-exclusive:0', backend: 'wasapi-exclusive' }])
    await client.devicesForSession('wasapi-shared')
    expect(probes).toEqual(['wasapi'])
  })
  it('rejects an incompatible native core before publishing a timeline', async () => {
    const methods: string[] = []
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false, kill: vi.fn() })
      child.stdin.on('data', chunk => {
        const { id, method } = JSON.parse(chunk.toString()); methods.push(method)
        child.stdout.write(JSON.stringify({ id, ok: true, result: method === 'capabilities' ? { protocol: 1 } : true }) + '\n')
        if (method === 'shutdown') child.emit('exit', 0, null)
      })
      return child
    })
    const client = new AudioHostClient({ audioHostExecutable: () => 'host' } as never, { warn: vi.fn(), error: vi.fn() } as never)
    await expect(client.timeline({ action: 'play' })).rejects.toMatchObject({ code: 'AUDIO_HOST_PROTOCOL_MISMATCH' })
    expect(methods).toEqual(['capabilities'])
    await client.shutdown()
  })
  it('waits for core shutdown acknowledgement before releasing plugin mappings', async () => {
    let mappingsOpen = true
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false, kill: vi.fn() })
      child.stdin.on('data', chunk => {
        const { id, method } = JSON.parse(chunk.toString())
        if (method === 'shutdown') mappingsOpen = false
        child.stdout.write(JSON.stringify({ id, ok: true, result: { sampleRate: 48000 } }) + '\n')
        if (method === 'shutdown') child.emit('exit', 0, null)
      })
      return child
    })
    const client = new AudioHostClient({ audioHostExecutable: () => 'host' } as never, { warn: vi.fn(), error: vi.fn() } as never)
    const stop = vi.spyOn(client.plugins, 'stop').mockImplementation(async () => { expect(mappingsOpen).toBe(false) })
    await client.startTest({})
    await client.shutdown()
    expect(stop).toHaveBeenCalled()
  })
  it.skipIf(process.platform !== 'win32')('retains a failed unused backend without blocking a valid selection or opening the microphone', async () => {
    const methods: string[] = []
    mocks.spawn.mockImplementation((_exe, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false, kill: vi.fn() })
      child.stdin.on('data', chunk => {
        const { id, method } = JSON.parse(chunk.toString()); methods.push(method)
        const failed = args.includes('asio') && method === 'devices'
        child.stdout.write(JSON.stringify({ id, ok: !failed, error: failed ? 'AUDIO_DRIVER_PROBE_FAILED' : undefined, evidence: failed ? { driverCode: 5 } : undefined,
          result: method === 'devices' ? [{ id: 'wasapi', backend: 'wasapi-shared', name: 'Shared', inputChannels: 2, outputChannels: 2, sampleRates: [48000], defaultInput: true, defaultOutput: true }] : true }) + '\n')
        if (method === 'shutdown') child.emit('exit', 0, null)
      }); return child
    })
    const client = new AudioHostClient({ audioHostExecutable: () => 'host' } as never, { warn: vi.fn(), error: vi.fn() } as never)
    const result = await client.inspect({ backend: 'auto', sampleRate: 48000, inputChannels: [0] } as never, new AbortController().signal)
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'audio-device', status: 'passed' }))
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'audio-enumerate:asio', status: 'failed' }))
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.severity).toBe('warning')
    expect(JSON.stringify(result.issues[0]?.evidence)).toContain('driverCode')
    expect(methods.every(method => ['devices', 'shutdown'].includes(method))).toBe(true)
  })
  it.skipIf(process.platform !== 'win32')('kills a hung ASIO probe while preserving WASAPI and the live audio process', async () => {
    vi.useFakeTimers()
    const children: Array<{ backend: string; child: ReturnType<typeof mocks.spawn> }> = []
    mocks.spawn.mockImplementation((_exe, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false, kill: vi.fn() })
      const backend = args[1] ?? 'live'
      children.push({ backend, child })
      child.kill.mockImplementation(() => { child.killed = true; child.emit('exit', 0, null) })
      child.stdin.on('data', chunk => {
        const { id, method } = JSON.parse(chunk.toString())
        if (backend === 'asio' && method === 'devices') return
        child.stdout.write(JSON.stringify({ id, ok: true, result: method === 'devices' ? [{ id: 'shared', name: '共享设备' }] : {} }) + '\n')
        if (method === 'shutdown') child.emit('exit', 0, null)
      })
      return child
    })
    const client = new AudioHostClient({ audioHostExecutable: () => 'host' } as never, { warn: vi.fn(), error: vi.fn() } as never)
    try {
      await client.start({})
      const enumeration = client.devices()
      await vi.advanceTimersByTimeAsync(15_001)
      expect(await enumeration).toEqual([{ id: 'shared', name: '共享设备' }])
      expect(children.find(item => item.backend === 'asio')!.child.kill).toHaveBeenCalled()
      expect(children.find(item => item.backend === 'live')!.child.kill).not.toHaveBeenCalled()
      await client.shutdown()
    } finally { vi.useRealTimers() }
  })
  it('preserves Unicode in RPC and diagnostics split inside UTF-8 codepoints', async () => {
    const warn = vi.fn()
    mocks.spawn.mockImplementation((_exe, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false, kill: vi.fn() })
    child.stdin.on('data', async chunk => {
      const { id, method } = JSON.parse(chunk.toString())
      if (method === 'shutdown') { child.stdout.write(JSON.stringify({ id, ok: true }) + '\n'); child.emit('exit', 0, null); return }
      if (args.includes('asio')) { child.stdout.write(JSON.stringify({ id, ok: true, result: [] }) + '\n'); return }
      const response = Buffer.from(JSON.stringify({ id, ok: true, result: [{ name: '中文 🎸设备' }] }) + '\n')
      const diagnostics = Buffer.from('中文 🎸路径')
      const split = response.indexOf(Buffer.from('中')) + 1
      child.stdout.write(response.subarray(0, split))
      child.stderr.write(diagnostics.subarray(0, 1))
      await new Promise(resolve => setImmediate(resolve))
      child.stderr.write(diagnostics.subarray(1))
      child.stdout.write(response.subarray(split))
    })
    return child
    })
    const client = new AudioHostClient({ audioHostExecutable: () => 'host' } as never, { warn, error: vi.fn() } as never)
    expect(await client.devices()).toEqual([{ name: '中文 🎸设备' }])
    expect(warn.mock.calls.map(call => call[1]).join('')).toContain('中文 🎸路径')
  })
})

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AudioHostClient } from '../src/main/audio-host.js'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('../src/main/process.js', () => ({ spawnSafe: mocks.spawn }))
vi.mock('node:fs', () => ({ existsSync: () => true }))

describe('native audio transport', () => {
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

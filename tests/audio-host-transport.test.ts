import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AudioHostClient } from '../src/main/audio-host.js'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('../src/main/process.js', () => ({ spawnSafe: mocks.spawn }))
vi.mock('node:fs', () => ({ existsSync: () => true }))

describe('native audio transport', () => {
  it('preserves Unicode in RPC and diagnostics split inside UTF-8 codepoints', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false })
    mocks.spawn.mockReturnValue(child)
    const warn = vi.fn()
    child.stdin.once('data', async chunk => {
      const { id } = JSON.parse(chunk.toString())
      const response = Buffer.from(JSON.stringify({ id, ok: true, result: [{ name: '中文 🎸设备' }] }) + '\n')
      const diagnostics = Buffer.from('中文 🎸路径')
      const split = response.indexOf(Buffer.from('中')) + 1
      child.stdout.write(response.subarray(0, split))
      child.stderr.write(diagnostics.subarray(0, 1))
      await new Promise(resolve => setImmediate(resolve))
      child.stderr.write(diagnostics.subarray(1))
      child.stdout.write(response.subarray(split))
    })
    const client = new AudioHostClient({ audioHostExecutable: () => 'host' } as never, { warn, error: vi.fn() } as never)
    expect(await client.devices()).toEqual([{ name: '中文 🎸设备' }])
    expect(warn.mock.calls.map(call => call[1]).join('')).toBe('中文 🎸路径')
    child.emit('exit', 0, null)
  })
})

import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeManager } from '../src/main/runtime.js'
import { runProcess, spawnSafe } from '../src/main/process.js'

vi.mock('electron', () => ({ app: { getVersion: () => '3.0.1' }, session: {} }))
vi.mock('../src/main/process.js', () => ({
  runProcess: vi.fn(async () => ({ code: 0 })),
  spawnSafe: vi.fn(() => ({ stdout: new PassThrough(), stderr: new PassThrough() })),
  processFailure: vi.fn()
}))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('prevents both probe and separation workers from creating caches inside a signed app', async () => {
  vi.stubEnv('PYTHONDONTWRITEBYTECODE', '0')
  const settings = { runtimeRoot: '/tmp/bb-runtime', modelRoot: '/tmp/bb-models', preferredDevice: 'cpu', network: { proxyMode: 'none' } }
  const manager = new RuntimeManager(
    { cacheRoot: '/tmp/bb-cache', packagedResource: () => '/nonexistent/bb-resource' } as never,
    { getSettings: () => settings } as never,
    { info: vi.fn() } as never
  )
  vi.spyOn(manager, 'pythonExecutable').mockReturnValue(process.execPath)
  await manager.runWorker(['probe'])
  expect(vi.mocked(runProcess).mock.calls.at(-1)?.[2]?.env?.PYTHONDONTWRITEBYTECODE).toBe('1')
  manager.spawnWorker(['separate'], new AbortController().signal, vi.fn())
  expect(vi.mocked(spawnSafe).mock.calls.at(-1)?.[2]?.env?.PYTHONDONTWRITEBYTECODE).toBe('1')
})

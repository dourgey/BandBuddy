import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ensureSystemRuntime } from '../src/main/system-runtime-recovery.js'
const mocks = vi.hoisted(() => ({ detect: vi.fn(), helper: vi.fn(), process: vi.fn() }))
vi.mock('../src/main/system-helper.js', () => ({ systemHelper: mocks.helper }))
vi.mock('../src/main/windows-prerequisites.js', async load => ({ ...await load<typeof import('../src/main/windows-prerequisites.js')>(), detectWindowsVcRuntime: mocks.detect }))
vi.mock('../src/main/process.js', async load => ({ ...await load<typeof import('../src/main/process.js')>(), runProcess: mocks.process }))
vi.mock('node:fs', async load => ({ ...await load<typeof import('node:fs')>(), existsSync: () => true }))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.detect.mockResolvedValue({ installed: false, supported: false, version: null })
  mocks.process.mockResolvedValue({ code: 0, stdout: '{"ok":true}', stderr: '' })
})
async function paths() { const root = await mkdtemp(path.join(os.tmpdir(), 'bb-vc-')); roots.push(root); return { localRoot: root, audioHostExecutable: () => 'host.exe', packagedResource: (...parts: string[]) => path.join(root, ...parts) } }
it.each([[1223, 'VC_RUNTIME_ELEVATION_CANCELLED'], [3010, 'VC_RUNTIME_RESTART_REQUIRED'], [1641, 'VC_RUNTIME_RESTART_REQUIRED'], [1618, 'VC_RUNTIME_INSTALL_BUSY'], [1603, 'VC_RUNTIME_INSTALL_FAILED']])('persists installer exit %s without asking for authorization again automatically', async (code, expected) => {
  const root = await paths()
  mocks.helper.mockImplementation(async (args: string[]) => ({ code: args[0] === 'signature' ? 0 : code, stdout: args[0] === 'signature' ? '{"status":"Valid","subject":"O=Microsoft Corporation"}' : 'installer output', stderr: '' }))
  await expect(ensureSystemRuntime(root as never, new AbortController().signal)).rejects.toMatchObject({ code: expected, details: { exitCode: code } })
  expect(JSON.parse(await readFile(path.join(root.localRoot, 'system-install-state.json'), 'utf8')).code).toBe(code)
  await expect(ensureSystemRuntime(root as never, new AbortController().signal)).rejects.toThrow()
  expect(mocks.helper.mock.calls.filter(([args]) => args[0] === 'install-vc')).toHaveLength(1)
})
it('coalesces concurrent startup and environment repair and verifies the installed runtime', async () => {
  const root = await paths()
  mocks.detect.mockResolvedValueOnce({ installed: false, supported: false }).mockResolvedValue({ installed: true, supported: true, version: '14.44' })
  mocks.helper.mockResolvedValue({ code: 0, stdout: '{"status":"Valid","subject":"O=Microsoft Corporation"}', stderr: '' })
  const first = ensureSystemRuntime(root as never, new AbortController().signal)
  expect(ensureSystemRuntime(root as never, new AbortController().signal)).toBe(first)
  expect(await first).toBe('14.44')
  expect(mocks.helper.mock.calls.filter(([args]) => args[0] === 'install-vc')).toHaveLength(1)
  expect(mocks.process).toHaveBeenCalledOnce()
})
it('does not treat an installer zero exit as proof that the runtime is ready', async () => {
  const root = await paths()
  mocks.helper.mockResolvedValue({ code: 0, stdout: '{"status":"Valid","subject":"O=Microsoft Corporation"}', stderr: '' })
  await expect(ensureSystemRuntime(root as never, new AbortController().signal)).rejects.toMatchObject({ code: 'VC_RUNTIME_INSTALL_FAILED', details: { installed: { supported: false } } })
})

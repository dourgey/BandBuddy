import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { detectWindowsVcRuntime } from '../src/main/windows-prerequisites.js'
import { RuntimeManager } from '../src/main/runtime.js'
vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }))
vi.mock('../src/main/system-helper.js', () => ({ systemHelperPath: () => process.execPath }))

describe('system probe and interrupted installer evidence', () => {
  it.each([
    { code: 1, stdout: '', stderr: 'Access denied' },
    { code: 0, stdout: '{"installed":false,"version":"","probeError":5}', stderr: '' },
    { code: 0, stdout: 'not-json', stderr: '' }
    , { code: 0, stdout: '{"installed":true,"version":"invalid"}', stderr: '' }
  ])('keeps failed probes distinct from an absent VC runtime', async result => {
    const value = await detectWindowsVcRuntime(vi.fn(async () => result))
    expect(value.probeError).toBeDefined()
    expect(value.supported).toBe(false)
  })
  it('accepts explicit absence and a successful supported probe', async () => {
    expect(await detectWindowsVcRuntime(vi.fn(async () => ({ code: 0, stdout: '{"installed":false,"version":"","probeError":0}', stderr: '' })))).toMatchObject({ installed: false, supported: false })
    expect(await detectWindowsVcRuntime(vi.fn(async () => ({ code: 0, stdout: '{"installed":true,"version":"14.44.35211.0","probeError":0}', stderr: '' })))).toMatchObject({ installed: true, supported: true })
  })
  it('holds a reboot-required result through manual retries until a different boot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bb-restart-'))
    const runtime = new RuntimeManager({ localRoot: root } as never, { getSettings: () => ({ preferredDevice: 'auto' }) } as never, {} as never)
    const check = () => (runtime as unknown as { checkPendingSystemRestart(): Promise<void> }).checkPendingSystemRestart()
    try {
      await writeFile(path.join(root, 'system-install-state.json'), JSON.stringify({ code: 3010, bootTime: Date.now() - os.uptime() * 1000 }))
      await expect(check()).rejects.toMatchObject({ code: 'VC_RUNTIME_RESTART_REQUIRED', details: { exitCode: 3010 } })
      runtime.allowSystemInstallerRetry()
      await expect(check()).rejects.toMatchObject({ code: 'VC_RUNTIME_RESTART_REQUIRED' })
      await writeFile(path.join(root, 'system-install-state.json'), JSON.stringify({ code: 3010, bootTime: 1 }))
      await expect(check()).resolves.toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

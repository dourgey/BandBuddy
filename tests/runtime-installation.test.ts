import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeManager } from '../src/main/runtime.js'
import { validateIntelWheel, validateIntelRuntimeLock } from '../src/main/runtime-wheel-manifest.js'

vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }))

describe('recoverable runtime preparation', () => {
  it('releases the installation lock after a directory preparation failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bandbuddy-install-'))
    const occupied = path.join(root, 'not-a-directory')
    await writeFile(occupied, 'keep me')
    const error = vi.fn()
    const manager = new RuntimeManager({} as never, { getSettings: () => ({ runtimeRoot: occupied, modelRoot: path.join(root, 'models'), preferredDevice: 'auto' }) } as never, { error, warn: vi.fn() } as never)
    try {
      expect((await manager.install()).status).toBe('failed')
      expect((await manager.install()).status).toBe('failed')
      expect(error).toHaveBeenCalledTimes(2)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('requires an exact Intel wheel, immutable digest, and a first-party release location', () => {
    const filename = 'sphn-0.1.12-cp312-cp312-macosx_13_0_x86_64.whl'
    const wheel = { name: 'sphn', version: '0.1.12', filename, sha256: 'a'.repeat(64), url: `https://github.com/dourgey/BandBuddy/releases/download/runtime-v1/${filename}` }
    expect(validateIntelWheel(wheel)).toEqual(wheel)
    expect(() => validateIntelWheel({ ...wheel, sha256: '' })).toThrow('INTEL_RUNTIME_WHEEL_INVALID')
    expect(() => validateIntelWheel({ ...wheel, url: `https://example.com/${filename}` })).toThrow('INTEL_RUNTIME_WHEEL_SOURCE_INVALID')
    expect(() => validateIntelWheel({ ...wheel, filename: 'sphn-arm64.whl' })).toThrow('INTEL_RUNTIME_WHEEL_INVALID')
  })

  it('accepts the complete direct-wheel lock and rejects source archives or foreign release URLs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bandbuddy-lock-'))
    const lock = path.join(root, 'intel.lock')
    const base = 'https://github.com/dourgey/BandBuddy/releases/download/runtime-r1/'
    const sphn = `${base}sphn-0.1.12-cp312-cp312-macosx_13_0_x86_64.whl`
    const digest = 'b'.repeat(64)
    const text = `torch @ ${base}torch-2.2.2-cp312-none-macosx_10_9_x86_64.whl --hash=sha256:${digest}\nnumpy @ ${base}numpy-1.26.4-cp312-cp312-macosx_10_9_x86_64.whl --hash=sha256:${digest}\nsphn @ ${sphn} --hash=sha256:${digest}\n`
    try {
      await writeFile(lock, text)
      await expect(validateIntelRuntimeLock(lock, `sphn @ ${sphn}#sha256=${digest}`)).resolves.toBeUndefined()
      await writeFile(lock, text.replace('torch-2.2.2-cp312-none-macosx_10_9_x86_64.whl', 'torch-2.2.2.tar.gz'))
      await expect(validateIntelRuntimeLock(lock, `sphn @ ${sphn}#sha256=${digest}`)).rejects.toThrow('INTEL_RUNTIME_LOCK_SOURCE_INVALID')
      await writeFile(lock, text.replace(`${base}torch`, 'https://untrusted.example/torch'))
      await expect(validateIntelRuntimeLock(lock, `sphn @ ${sphn}#sha256=${digest}`)).rejects.toThrow('INTEL_RUNTIME_LOCK_SOURCE_INVALID')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

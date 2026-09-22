import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/domain.js'
import { migrateDataRoots } from '../src/main/data-migration.js'
import { activeEnvironment } from '../src/main/runtime-environments.js'

const hooks = vi.hoisted(() => ({ afterCopy: null as null | (() => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real, copyFile: async (...args: Parameters<typeof real.copyFile>) => { await real.copyFile(...args); await hooks.afterCopy?.() } }
})
const temporary: string[] = []
afterEach(async () => { hooks.afterCopy = null; await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(): Promise<{ previous: AppSettings; next: AppSettings; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'BandBuddy 迁移 🎸-'))
  temporary.push(root)
  const settings = (name: string): AppSettings => ({ libraryRoot: path.join(root, name, 'music'), runtimeRoot: path.join(root, name, 'envs'), modelRoot: path.join(root, name, 'envs', 'models') }) as AppSettings
  const previous = settings('原始'), next = settings('新目录')
  await mkdir(previous.libraryRoot, { recursive: true })
  await mkdir(previous.modelRoot, { recursive: true })
  await mkdir(path.join(previous.runtimeRoot, 'env'), { recursive: true })
  await writeFile(path.join(previous.libraryRoot, '中文 (guitar).wav'), 'song bytes')
  await writeFile(path.join(previous.modelRoot, 'model.bin'), 'model bytes')
  return { previous, next, root }
}

describe('verified data directory migration', () => {
  it('commits only after copying both data roots and keeps the venv at its original absolute path', async () => {
    const { previous, next } = await fixture()
    const save = vi.fn(() => {
      expect(existsSync(path.join(next.libraryRoot, '中文 (guitar).wav'))).toBe(true)
      expect(existsSync(path.join(next.modelRoot, 'model.bin'))).toBe(true)
      expect(activeEnvironment(next.runtimeRoot)).toBe(path.join(previous.runtimeRoot, 'env'))
    })
    await migrateDataRoots(previous, next, save)
    expect(save).toHaveBeenCalledTimes(1)
    expect(await readFile(path.join(previous.libraryRoot, '中文 (guitar).wav'), 'utf8')).toBe('song bytes')
    expect(await readFile(path.join(next.modelRoot, 'model.bin'), 'utf8')).toBe('model bytes')
  })

  it('rolls back copied targets and its pointer when saving settings fails', async () => {
    const { previous, next } = await fixture()
    await expect(migrateDataRoots(previous, next, () => { throw new Error('disk full') })).rejects.toThrow('disk full')
    expect(existsSync(next.libraryRoot)).toBe(false)
    expect(existsSync(next.runtimeRoot)).toBe(false)
    expect(existsSync(path.join(previous.runtimeRoot, 'env'))).toBe(true)
  })

  it('keeps the original settings if an external disk is missing', async () => {
    const { previous, next } = await fixture()
    await rm(previous.libraryRoot, { recursive: true })
    const save = vi.fn()
    await expect(migrateDataRoots(previous, next, save)).rejects.toThrow('请连接原磁盘')
    expect(save).not.toHaveBeenCalled()
    expect(existsSync(next.libraryRoot)).toBe(false)
  })

  it('refuses nonempty destinations and symlinks inside the source', async () => {
    const { previous, next } = await fixture()
    await mkdir(next.libraryRoot, { recursive: true })
    await writeFile(path.join(next.libraryRoot, 'unrelated.txt'), 'keep')
    await expect(migrateDataRoots(previous, next, vi.fn())).rejects.toThrow('不是空目录')
    expect(await readFile(path.join(next.libraryRoot, 'unrelated.txt'), 'utf8')).toBe('keep')
    await rm(next.libraryRoot, { recursive: true })
    await symlink(previous.modelRoot, path.join(previous.libraryRoot, 'alias'), 'dir')
    await expect(migrateDataRoots(previous, next, vi.fn())).rejects.toThrow('符号链接')
  })

  it('detects files added by another program during a long copy before committing', async () => {
    const { previous, next } = await fixture()
    const save = vi.fn()
    hooks.afterCopy = async () => { hooks.afterCopy = null; await writeFile(path.join(previous.libraryRoot, 'new recording.wav'), 'new bytes') }
    await expect(migrateDataRoots(previous, next, save)).rejects.toThrow('迁移期间发生变化')
    expect(save).not.toHaveBeenCalled()
    expect(existsSync(next.libraryRoot)).toBe(false)
    expect(existsSync(next.runtimeRoot)).toBe(false)
    expect(await readFile(path.join(previous.libraryRoot, 'new recording.wav'), 'utf8')).toBe('new bytes')
  })

  it('does not delete a runtime pointer replaced by another owner during rollback', async () => {
    const { previous, next } = await fixture()
    const pointer = path.join(next.runtimeRoot, 'active-environment.json')
    await expect(migrateDataRoots(previous, next, () => { writeFileSync(pointer, 'external owner'); throw new Error('save failed') })).rejects.toThrow('save failed')
    expect(await readFile(pointer, 'utf8')).toBe('external owner')
  })
})

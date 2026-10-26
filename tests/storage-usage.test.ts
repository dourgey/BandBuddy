import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { readStorageUsage } from '../src/main/storage-usage.js'
it('counts nested models once, ignores missing roots and reports disk space', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bb-storage-'))
  try {
    const libraryRoot = path.join(root, 'music'), runtimeRoot = path.join(root, 'envs'), modelRoot = path.join(runtimeRoot, 'models')
    await mkdir(modelRoot, { recursive: true }); await mkdir(libraryRoot)
    await writeFile(path.join(libraryRoot, 'take.flac'), Buffer.alloc(123))
    await writeFile(path.join(runtimeRoot, 'python'), Buffer.alloc(234))
    await writeFile(path.join(modelRoot, 'model'), Buffer.alloc(345))
    const usage = await readStorageUsage({ libraryRoot, runtimeRoot, modelRoot })
    expect(usage.entries.map(e => e.bytes)).toEqual([123, 234, 345]); expect(usage.totalBytes).toBe(702)
    expect(usage.entries.every(e => !e.incomplete)).toBe(true); expect(usage.freeBytes).toBeGreaterThan(0)
    expect((await readStorageUsage({ libraryRoot, runtimeRoot, modelRoot: path.join(root, 'missing') })).totalBytes).toBe(702)
  } finally { await rm(root, { recursive: true, force: true }) }
})

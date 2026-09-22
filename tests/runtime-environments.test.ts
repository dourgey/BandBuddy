import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { activeEnvironment, activateEnvironment, createEnvironment, linkMigratedEnvironment } from '../src/main/runtime-environments.js'

const roots: string[] = []
const root = async (): Promise<string> => { const value = await mkdtemp(path.join(os.tmpdir(), 'bandbuddy-环境 ')); roots.push(value); return value }
afterEach(async () => { await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true }))) })

describe('versioned environments', () => {
  it('keeps the previous environment active until the new one is explicitly committed', async () => {
    const directory = await root()
    const first = await createEnvironment(directory)
    await activateEnvironment(directory, first)
    const next = await createEnvironment(directory)
    expect(activeEnvironment(directory)).toBe(first)
    await rm(next, { recursive: true })
    expect(activeEnvironment(directory)).toBe(first)
    const ready = await createEnvironment(directory)
    await activateEnvironment(directory, ready)
    expect(activeEnvironment(directory)).toBe(ready)
    expect(JSON.parse(await readFile(path.join(directory, 'active-environment.json'), 'utf8')).directory).toBe(path.basename(ready))
  })

  it('rejects escaping pointers and preserves legacy env installations', async () => {
    const directory = await root()
    await writeFile(path.join(directory, 'active-environment.json'), JSON.stringify({ directory: '../../other' }))
    expect(activeEnvironment(directory)).toBe(path.join(directory, 'env'))
    await expect(activateEnvironment(directory, path.join(directory, '../other'))).rejects.toThrow('INVALID_RUNTIME_DIRECTORY')
  })

  it('retains an old venv at its original absolute path during data migration', async () => {
    const from = await root()
    const to = await root()
    await mkdir(path.join(from, 'env'))
    await linkMigratedEnvironment(from, to)
    expect(activeEnvironment(to)).toBe(path.join(from, 'env'))
    const next = await createEnvironment(to)
    await activateEnvironment(to, next)
    expect(activeEnvironment(to)).toBe(next)
    expect(activeEnvironment(from)).toBe(path.join(from, 'env'))
  })
})

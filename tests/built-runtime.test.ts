import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = pathToFileURL(path.resolve(import.meta.dirname, '../scripts/verify-built-runtime.mjs')).href
const { verifyBuiltRuntime } = await import(/* @vite-ignore */ script)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bandbuddy-built-runtime-'))
  roots.push(root)
  await Promise.all(['out/main/chunks', 'out/preload'].map(directory => mkdir(path.join(root, directory), { recursive: true })))
  await Promise.all([
    writeFile(path.join(root, 'out/preload/index.cjs'), 'const {contextBridge}=require("electron"); contextBridge.exposeInMainWorld("bandbuddy",{});'),
    writeFile(path.join(root, 'out/preload/lyrics.cjs'), 'const {contextBridge}=require("electron"); contextBridge.exposeInMainWorld("desktopLyrics",{});'),
    writeFile(path.join(root, 'out/main/index.js'), 'import {app} from "electron"; import Database from "better-sqlite3";'),
    writeFile(path.join(root, 'out/main/analysis-worker.js'), 'import { parentPort } from "node:worker_threads";'),
    writeFile(path.join(root, 'out/main/database-boot-worker.js'), 'import { parentPort } from "node:worker_threads";')
  ])
  return root
}

describe('production runtime build guard', () => {
  it('accepts two self-contained sandbox preloads with external main dependencies', async () => {
    expect(await verifyBuiltRuntime(await fixture())).toMatchObject({ analysisWorker: true, databaseWorker: true })
  })
  it('accepts native imports in reachable shared main chunks', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'out/main/index.js'), 'import {app} from "electron"; import {db} from "./chunks/database.js";')
    await writeFile(path.join(root, 'out/main/chunks/database.js'), 'import Database from "better-sqlite3"; export const db = Database;')
    expect(await verifyBuiltRuntime(root)).toMatchObject({ databaseWorker: true })
    await writeFile(path.join(root, 'out/main/index.js'), 'import {app} from "electron";')
    await expect(verifyBuiltRuntime(root)).rejects.toThrow('MAIN_NATIVE_DEPENDENCY_NOT_EXTERNAL:better-sqlite3')
  })
  it('rejects missing database migration worker output', async () => {
    const root = await fixture()
    await rm(path.join(root, 'out/main/database-boot-worker.js'))
    await expect(verifyBuiltRuntime(root)).rejects.toThrow('database-boot-worker.js')
  })
  it.each(['index', 'lyrics'])('rejects a relative shared chunk from the %s preload', async entry => {
    const root = await fixture()
    await appendFile(path.join(root, `out/preload/${entry}.cjs`), '\nrequire("./chunks/shared.cjs");')
    await expect(verifyBuiltRuntime(root)).rejects.toThrow('SANDBOX_PRELOAD_EXTERNAL_MODULE')
  })
  it('rejects a non-sandbox package import from a preload', async () => {
    const root = await fixture()
    await appendFile(path.join(root, 'out/preload/index.cjs'), '\nrequire("zod");')
    await expect(verifyBuiltRuntime(root)).rejects.toThrow('SANDBOX_PRELOAD_EXTERNAL_MODULE')
  })
  it('rejects bundled Electron or native SQLite implementations, including in a shared main chunk', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'out/main/chunks/native.js'), '//#region node_modules/.pnpm/better-sqlite3@1/node_modules/better-sqlite3/lib/database.js\nconst bundled = true;')
    await expect(verifyBuiltRuntime(root)).rejects.toThrow('MAIN_NATIVE_IMPLEMENTATION_BUNDLED')
  })
  it('rejects missing native external imports and missing worker output', async () => {
    const root = await fixture()
    const main = path.join(root, 'out/main/index.js')
    await writeFile(main, 'import {app} from "electron";')
    await expect(verifyBuiltRuntime(root)).rejects.toThrow('MAIN_NATIVE_DEPENDENCY_NOT_EXTERNAL:better-sqlite3')
    await writeFile(main, 'import {app} from "electron"; import Database from "better-sqlite3";')
    await rm(path.join(root, 'out/main/analysis-worker.js'))
    await expect(verifyBuiltRuntime(root)).rejects.toThrow('analysis-worker.js')
  })
})

import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const sqliteHarness = vi.hoisted(() => ({ statements: [] as string[], closed: [] as string[] }))
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { existsSync } = await import('node:fs')
  class TestDatabase extends DatabaseSync {
    filename: string
    constructor(filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }) {
      if (options?.fileMustExist && !existsSync(filename)) throw new Error('Cannot open database because the file does not exist')
      super(filename, { readOnly: options?.readonly ?? false })
      this.filename = filename
    }
    pragma(statement: string): void { this.exec(`PRAGMA ${statement}`) }
    prepare(statement: string) { sqliteHarness.statements.push(statement); return super.prepare(statement) }
    close(): void { super.close(); sqliteHarness.closed.push(this.filename) }
    transaction(fn: (...args: unknown[]) => unknown) {
      const run = (...args: unknown[]) => {
        this.exec('BEGIN')
        try { const result = fn(...args); this.exec('COMMIT'); return result }
        catch (error) { this.exec('ROLLBACK'); throw error }
      }
      return Object.assign(run, { deferred: run, immediate: run, exclusive: run })
    }
  }
  return { default: TestDatabase }
})

import { BandBuddyDatabase, DATABASE_MIGRATIONS, type DatabasePaths } from '../src/main/database.js'
import { databaseNeedsPreparation, startDatabasePreparation } from '../src/main/database-preparation.js'

const roots: string[] = []
const originalExitCode = process.exitCode
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  sqliteHarness.statements.length = 0
  sqliteHarness.closed.length = 0
  process.exitCode = originalExitCode
  vi.doUnmock('node:worker_threads')
  vi.restoreAllMocks()
})
function locations(): DatabasePaths {
  const root = mkdtempSync(path.join(tmpdir(), 'BandBuddy 数据库 中文路径 '))
  roots.push(root)
  return {
    databasePath: path.join(root, '曲库 数据.db'),
    backupRoot: path.join(root, '迁移备份'),
    defaultLibraryRoot: path.join(root, '我的音乐'),
    pythonRoot: path.join(root, '离线环境'),
    modelRoot: path.join(root, '本地模型')
  }
}

class FakeWorker extends EventEmitter {
  private resolveTermination: ((code: number) => void) | null = null
  terminate = vi.fn(() => new Promise<number>((resolve) => { this.resolveTermination = resolve }))
  exit(code: number): void {
    this.emit('exit', code)
    this.resolveTermination?.(code)
  }
}
const createPreparation = (paths = locations()) => {
  const worker = new FakeWorker()
  const workerFactory = vi.fn((_url: URL, _options: { workerData: DatabasePaths }) => worker)
  return { worker, workerFactory, task: startDatabasePreparation(paths, { workerFactory }) }
}

describe('database startup probe and prepared open', () => {
  it('does not create a missing database during its read-only probe', () => {
    const paths = locations()
    expect(databaseNeedsPreparation(paths)).toBe(true)
    expect(existsSync(paths.databasePath)).toBe(false)
    expect(() => new BandBuddyDatabase(paths, { prepared: true })).toThrow()
    expect(existsSync(paths.databasePath)).toBe(false)
  })

  it('opens a migrated Chinese-path database quickly without migration, backup, recovery or persisted settings defaults', () => {
    const paths = locations()
    new BandBuddyDatabase(paths).close()
    sqliteHarness.statements.length = 0
    expect(databaseNeedsPreparation(paths)).toBe(false)
    expect(sqliteHarness.statements.length).toBeLessThanOrEqual(4)
    expect(sqliteHarness.statements.every((statement) => /^\s*SELECT\b/i.test(statement))).toBe(true)
    sqliteHarness.statements.length = 0
    const database = new BandBuddyDatabase(paths, { prepared: true })
    expect(sqliteHarness.statements).toHaveLength(2)
    expect(sqliteHarness.statements.every((statement) => /^\s*SELECT\b/i.test(statement))).toBe(true)
    expect(database.getSettings()).toMatchObject({ libraryRoot: paths.defaultLibraryRoot, runtimeRoot: paths.pythonRoot, modelRoot: paths.modelRoot })
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = 'app'").get()).toMatchObject({ count: 0 })
    expect(existsSync(paths.backupRoot)).toBe(false)
    database.close()
  })

  it('refuses to skip an older or incomplete schema and closes a rejected prepared connection', () => {
    const paths = locations()
    const database = new BandBuddyDatabase(paths)
    database.sqlite.prepare('DELETE FROM schema_version WHERE version = ?').run(DATABASE_MIGRATIONS.length)
    database.close()
    expect(databaseNeedsPreparation(paths)).toBe(true)
    const closed = sqliteHarness.closed.length
    expect(() => new BandBuddyDatabase(paths, { prepared: true })).toThrow('DATABASE_PREPARATION_REQUIRED')
    expect(sqliteHarness.closed).toHaveLength(closed + 1)

    const raw = new DatabaseSync(paths.databasePath)
    raw.prepare('INSERT INTO schema_version VALUES (?, ?)').run(DATABASE_MIGRATIONS.length, '2026-09-22')
    raw.prepare('DELETE FROM schema_version WHERE version = 1').run()
    raw.close()
    expect(() => databaseNeedsPreparation(paths)).toThrow('DATABASE_SCHEMA_INVALID')
    expect(() => new BandBuddyDatabase(paths, { prepared: true })).toThrow('DATABASE_PREPARATION_REQUIRED')
  })

  it('reports corrupt and future-version databases instead of starting a migration', () => {
    const corrupt = locations()
    writeFileSync(corrupt.databasePath, '这不是 SQLite 数据库')
    expect(() => databaseNeedsPreparation(corrupt)).toThrow()
    const future = locations()
    const database = new BandBuddyDatabase(future)
    database.sqlite.prepare('INSERT INTO schema_version VALUES (?, ?)').run(DATABASE_MIGRATIONS.length + 1, '2027-01-01')
    database.close()
    expect(() => databaseNeedsPreparation(future)).toThrow('DATABASE_SCHEMA_NEWER_THAN_APPLICATION')
  })

  it('routes pending job recovery and unrepaired interrupted songs through preparation, then returns to the fast path', () => {
    const paths = locations()
    const database = new BandBuddyDatabase(paths)
    database.sqlite.prepare("INSERT INTO songs(id,title,artist,status,progress,created_at,updated_at) VALUES ('song','练习','乐队','processing',0.4,'now','now')").run()
    database.sqlite.prepare("INSERT INTO jobs(id,song_id,type,status,created_at) VALUES ('job','song','separate','separating','now')").run()
    database.close()
    expect(databaseNeedsPreparation(paths)).toBe(true)
    const prepared = new BandBuddyDatabase(paths, { prepared: true })
    expect(prepared.sqlite.prepare("SELECT status FROM jobs WHERE id='job'").get()).toMatchObject({ status: 'separating' })
    prepared.close()
    new BandBuddyDatabase(paths).close()
    expect(databaseNeedsPreparation(paths)).toBe(false)

    const raw = new DatabaseSync(paths.databasePath)
    raw.exec("UPDATE songs SET status='processing',phase=NULL,active_separation_id='base'; UPDATE jobs SET type='guitarSplit'")
    raw.close()
    expect(databaseNeedsPreparation(paths)).toBe(true)
    const recovered = new BandBuddyDatabase(paths)
    expect(recovered.sqlite.prepare("SELECT status,progress,phase FROM songs WHERE id='song'").get()).toMatchObject({ status: 'ready', progress: 1, phase: '吉他细分未完成，基础分轨可继续' })
    recovered.close()
    expect(databaseNeedsPreparation(paths)).toBe(false)
  })
})

describe('database preparation worker coordination', () => {
  it('projects only serializable paths and waits for exit after a ready message', async () => {
    const paths = { ...locations(), ensure() { throw new Error('not a worker value') } }
    const { worker, workerFactory, task } = createPreparation(paths)
    const call = workerFactory.mock.calls[0]!
    expect(call[0].pathname).toMatch(/database-boot-worker\.js$/)
    expect(Object.keys(call[1].workerData).sort()).toEqual(['backupRoot', 'databasePath', 'defaultLibraryRoot', 'modelRoot', 'pythonRoot'])
    expect(structuredClone(call[1].workerData).databasePath).toBe(paths.databasePath)
    let ready = false
    void task.ready.then(() => { ready = true })
    worker.emit('message', { type: 'ready' })
    await Promise.resolve()
    expect(ready).toBe(false)
    worker.exit(0)
    await task.ready
    expect(ready).toBe(true)
    expect(worker.eventNames()).toHaveLength(0)
  })

  it.each([
    { message: undefined, code: 0, error: 'DATABASE_PREPARATION_EARLY_EXIT' },
    { message: { type: 'ready' }, code: 7, error: 'DATABASE_PREPARATION_WORKER_EXIT_7' },
    { message: { type: 'error', message: '磁盘空间不足' }, code: 0, error: '磁盘空间不足' }
  ])('rejects early exits, nonzero exits and worker-reported failures: $error', async ({ message, code, error }) => {
    const { worker, task } = createPreparation()
    if (message) worker.emit('message', message)
    worker.exit(code)
    await expect(task.ready).rejects.toThrow(error)
  })

  it('retains the worker exception and handles worker-construction errors', async () => {
    const { worker, task } = createPreparation()
    worker.emit('error', new Error('NATIVE_MODULE_LOAD_FAILED'))
    worker.exit(1)
    await expect(task.ready).rejects.toThrow('NATIVE_MODULE_LOAD_FAILED')
    const failed = startDatabasePreparation(locations(), { workerFactory: () => { throw new Error('WORKER_START_FAILED') } })
    await expect(failed.ready).rejects.toThrow('WORKER_START_FAILED')
    await failed.cancel()
  })

  it('cancels once, waits for termination and rejects ready even after an early ready message', async () => {
    const { worker, task } = createPreparation()
    worker.emit('message', { type: 'ready' })
    const cancellation = task.cancel()
    expect(task.cancel()).toBe(cancellation)
    expect(worker.terminate).toHaveBeenCalledOnce()
    let stopped = false
    void cancellation.then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    worker.exit(1)
    await cancellation
    await expect(task.ready).rejects.toMatchObject({ name: 'AbortError', message: 'DATABASE_PREPARATION_CANCELLED' })
    expect(stopped).toBe(true)
    expect(worker.eventNames()).toHaveLength(0)
  })

  it('does not terminate a completed worker', async () => {
    const { worker, task } = createPreparation()
    worker.emit('message', { type: 'ready' })
    worker.exit(0)
    await task.ready
    await task.cancel()
    expect(worker.terminate).not.toHaveBeenCalled()
  })

  it('posts ready from the worker only after SQLite has closed successfully', async () => {
    const paths = locations()
    const port = {
      postMessage: vi.fn((message: unknown) => {
        expect(sqliteHarness.closed).toContain(paths.databasePath)
        expect(message).toEqual({ type: 'ready' })
        expect(databaseNeedsPreparation(paths)).toBe(false)
      }),
      close: vi.fn()
    }
    vi.doMock('node:worker_threads', () => ({ parentPort: port, workerData: paths }))
    await import('../src/main/database-boot-worker.js')
    expect(port.postMessage).toHaveBeenCalledOnce()
    expect(port.close).toHaveBeenCalledOnce()
    const check = new BandBuddyDatabase(paths, { prepared: true })
    expect(check.getSettings().libraryRoot).toBe(paths.defaultLibraryRoot)
    check.close()
  })
})

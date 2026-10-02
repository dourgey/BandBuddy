import Database from 'better-sqlite3'
import type { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { DATABASE_MIGRATIONS, type DatabasePaths } from './database.js'

type PreparationWorker = Pick<EventEmitter, 'on' | 'off'> & Pick<Worker, 'terminate'>
export interface DatabasePreparationOptions {
  workerFactory?: (url: URL, options: { workerData: DatabasePaths }) => PreparationWorker
}
export interface DatabasePreparation {
  ready: Promise<void>
  cancel(): Promise<void>
}

/** A read-only, indexed probe keeps already migrated databases off the worker path. */
export function databaseNeedsPreparation(paths: DatabasePaths): boolean {
  if (!existsSync(paths.databasePath)) return true
  const database = new Database(paths.databasePath, { readonly: true, fileMustExist: true })
  try {
    const hasVersion = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get()
    if (!hasVersion) return true
    const version = database.prepare('SELECT COUNT(*) AS count, MIN(version) AS first, COALESCE(MAX(version), 0) AS latest FROM schema_version').get() as { count: number; first: number | null; latest: number }
    if (version.latest > DATABASE_MIGRATIONS.length) throw new Error('DATABASE_SCHEMA_NEWER_THAN_APPLICATION')
    if (version.count !== version.latest || (version.latest > 0 && version.first !== 1)) throw new Error('DATABASE_SCHEMA_INVALID')
    if (version.latest < DATABASE_MIGRATIONS.length) return true
    if (database.prepare("SELECT 1 FROM jobs WHERE status IN ('preparing', 'separating', 'postprocessing', 'cancelling') LIMIT 1").get()) return true
    return Boolean(database.prepare(`
      SELECT 1 FROM jobs AS job JOIN songs AS song ON song.id = job.song_id
      WHERE job.status = 'interrupted' AND (
        (song.active_separation_id IS NOT NULL AND job.type = 'guitarSplit'
          AND (song.status != 'ready' OR song.progress != 1 OR song.phase IS NOT '吉他细分未完成，基础分轨可继续'))
        OR (song.active_separation_id IS NULL
          AND (song.status != 'failed' OR song.phase IS NOT '任务已中断'))
      ) LIMIT 1
    `).get())
  } finally {
    database.close()
  }
}

export function startDatabasePreparation(paths: DatabasePaths, options: DatabasePreparationOptions = {}): DatabasePreparation {
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // Shutdown can cancel before its startup caller reaches await ready.
  void ready.catch(() => {})
  const workerData: DatabasePaths = {
    databasePath: paths.databasePath,
    backupRoot: paths.backupRoot,
    defaultLibraryRoot: paths.defaultLibraryRoot,
    pythonRoot: paths.pythonRoot,
    modelRoot: paths.modelRoot
  }
  let worker: PreparationWorker
  try {
    worker = (options.workerFactory ?? ((url, workerOptions) => new Worker(url, workerOptions)))(
      new URL('./database-boot-worker.js', import.meta.url), { workerData }
    )
  } catch (error) {
    rejectReady(asError(error))
    return { ready, cancel: async () => {} }
  }

  let receivedReady = false
  let failure: Error | null = null
  let exited = false
  let cancelled = false
  let cancellation: Promise<void> | null = null
  let resolveExit!: () => void
  const exit = new Promise<void>((resolve) => { resolveExit = resolve })
  const onMessage = (message: unknown): void => {
    if (!message || typeof message !== 'object') return
    const value = message as { type?: unknown; message?: unknown }
    if (value.type === 'ready') receivedReady = true
    else if (value.type === 'error') failure = new Error(typeof value.message === 'string' ? value.message : 'DATABASE_PREPARATION_FAILED')
  }
  const onError = (error: unknown): void => { failure = asError(error) }
  const onExit = (code: number): void => {
    if (exited) return
    exited = true
    worker.off('message', onMessage)
    worker.off('error', onError)
    worker.off('messageerror', onError)
    worker.off('exit', onExit)
    resolveExit()
    if (cancelled) rejectReady(cancellationError())
    else if (failure) rejectReady(failure)
    else if (code !== 0) rejectReady(new Error(`DATABASE_PREPARATION_WORKER_EXIT_${code}`))
    else if (!receivedReady) rejectReady(new Error('DATABASE_PREPARATION_EARLY_EXIT'))
    else resolveReady()
  }
  worker.on('message', onMessage)
  worker.on('error', onError)
  worker.on('messageerror', onError)
  worker.on('exit', onExit)

  return {
    ready,
    cancel: () => {
      if (cancellation) return cancellation
      if (exited) return Promise.resolve()
      cancelled = true
      cancellation = (async () => {
        try {
          const code = await worker.terminate()
          // Worker.terminate resolves after exit; supporting factories may only
          // report the code through this promise rather than emit the event.
          if (!exited) onExit(code)
          await exit
        } catch (error) {
          rejectReady(asError(error))
          throw error
        }
      })()
      return cancellation
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
function cancellationError(): Error {
  const error = new Error('DATABASE_PREPARATION_CANCELLED')
  error.name = 'AbortError'
  return error
}

import { parentPort, workerData } from 'node:worker_threads'
import { BandBuddyDatabase, type DatabasePaths } from './database.js'

let database: BandBuddyDatabase | null = null
let failure: unknown
try {
  database = new BandBuddyDatabase(workerData as DatabasePaths)
} catch (error) {
  failure = error
} finally {
  try { database?.close() }
  catch (error) { failure ??= error }
}

// A ready message certifies that migrations/recovery and connection close have
// all completed. The parent additionally waits for this worker to exit.
if (failure) {
  process.exitCode = 1
  parentPort?.postMessage({ type: 'error', message: failure instanceof Error ? failure.message : String(failure) })
} else {
  parentPort?.postMessage({ type: 'ready' })
}
parentPort?.close()

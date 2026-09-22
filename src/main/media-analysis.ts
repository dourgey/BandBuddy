import { Worker } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import type { MusicalKeyAnalysis, StemType } from '@shared/domain.js'
import type { BpmAnalysis } from './bpm-detection.js'

export interface PeaksAnalysis { version: 1; sampleRate: number; min: number[]; max: number[] }
export interface MediaAnalysisRequest {
  kind: 'peaks' | 'bpm' | 'key'
  ffmpeg: string
  args: string[]
  sampleRate: number
  durationMs?: number
  bins?: number
  stems?: StemType[]
}
export interface MediaAnalysisResults { peaks: PeaksAnalysis; bpm: BpmAnalysis | null; key: MusicalKeyAnalysis | null }
interface Waiter { start(): void; reject(error: Error): void; signal?: AbortSignal; abort(): void }

/** A bounded worker queue prevents concurrent user actions from exhausting RAM. */
export function createMediaAnalysisRunner(workerUrl = new URL('./analysis-worker.js', import.meta.url)) {
  let active = 0
  const lifecycle = new AbortController()
  const stopped = new Set<() => void>()
  const waiting: Waiter[] = []
  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(new Error('JOB_CANCELLED'))
    if (active < 2) { active += 1; return Promise.resolve() }
    if (waiting.length >= 32) return Promise.reject(new Error('MEDIA_ANALYSIS_BUSY'))
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal, reject,
        start() { signal?.removeEventListener('abort', waiter.abort); active += 1; resolve() },
        abort() { const at = waiting.indexOf(waiter); if (at >= 0) waiting.splice(at, 1); reject(new Error('JOB_CANCELLED')) }
      }
      signal?.addEventListener('abort', waiter.abort, { once: true })
      waiting.push(waiter)
    })
  }
  const run = async <K extends MediaAnalysisRequest['kind']>(request: MediaAnalysisRequest & { kind: K }, signal?: AbortSignal): Promise<MediaAnalysisResults[K]> => {
    signal = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal
    await acquire(signal)
    try {
      signal?.throwIfAborted()
      return await new Promise((resolve, reject) => {
        const worker = new Worker(workerUrl, { workerData: request })
        let childPid: number | null = null
        let finished = false
        const killChild = (): void => {
          if (!childPid) return
          if (process.platform === 'win32') {
            const killer = spawn('taskkill.exe', ['/PID', String(childPid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
            killer.on('error', () => undefined)
          } else {
            try { process.kill(-childPid, 'SIGKILL') } catch { try { process.kill(childPid, 'SIGKILL') } catch { /* already exited */ } }
          }
          childPid = null
        }
        const finish = (error?: Error, value?: MediaAnalysisResults[K]): void => {
          if (finished) return
          finished = true
          clearTimeout(timeout)
          signal?.removeEventListener('abort', abort)
          if (error) {
            killChild()
            worker.postMessage({ cancel: true })
            // Allow an in-flight spawn to report its PID before terminating the
            // worker, so cancellation cannot orphan a decoder process.
            setTimeout(() => {
              killChild()
              void worker.terminate().finally(() => reject(error))
            }, 100)
          } else {
            void worker.terminate().finally(() => resolve(value!))
          }
        }
        const abort = (): void => finish(new Error('JOB_CANCELLED'))
        const timeout = setTimeout(() => finish(new Error('MEDIA_ANALYSIS_TIMEOUT')), 20 * 60_000)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        worker.on('message', (message: { pid?: number; childExited?: boolean; result?: MediaAnalysisResults[K]; error?: string }) => {
          if (message.pid) { childPid = message.pid; if (finished) killChild(); return }
          if (message.childExited) { childPid = null; return }
          finish(message.error ? new Error(message.error) : undefined, message.result)
        })
        worker.once('error', error => finish(error))
        worker.once('exit', code => { if (!finished) finish(new Error(`MEDIA_ANALYSIS_WORKER_EXITED:${code}`)) })
      })
    } finally {
      active -= 1
      waiting.shift()?.start()
      if (!active && !waiting.length) { for (const resolve of stopped) resolve(); stopped.clear() }
    }
  }
  return Object.assign(run, { shutdown: async (): Promise<void> => {
    lifecycle.abort()
    if (!active && !waiting.length) return
    await new Promise<void>(resolve => stopped.add(resolve))
  } })
}

export const runMediaAnalysis = createMediaAnalysisRunner()
export const shutdownMediaAnalysis = (): Promise<void> => runMediaAnalysis.shutdown()

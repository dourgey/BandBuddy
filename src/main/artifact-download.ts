import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface Artifact {
  id: string
  filename: string
  urls: string[]
  sha256: string
  size?: number
  expandedSize?: number
}
export interface DownloadProgress { id: string; received: number; total: number | null; source: string; attempt: number }
export interface DownloadAttempt { id: string; source: string; attempt: number; at: string; result: string }
type Fetcher = (url: string, options: RequestInit) => Promise<Response>

// All runtime clients share this limit, including repair and model downloads.
let running = 0
const queue: Array<() => void> = []
async function slot(signal: AbortSignal): Promise<() => void> {
  if (running >= 2) await new Promise<void>((resolve, reject) => {
    const wake = (): void => { signal.removeEventListener('abort', cancel); resolve() }
    const cancel = (): void => { const i = queue.indexOf(wake); if (i >= 0) queue.splice(i, 1); reject(signal.reason ?? new Error('INSTALL_CANCELLED')) }
    queue.push(wake); signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
  // A released slot is reserved for the waiter before new callers can enter.
  else running++
  return () => { const next = queue.shift(); if (next) next(); else running-- }
}
export async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}
export async function artifactValid(file: string, artifact: Pick<Artifact, 'size' | 'sha256'>): Promise<boolean> {
  try { return (artifact.size === undefined || (await stat(file)).size === artifact.size) && await fileDigest(file) === artifact.sha256 } catch { return false }
}
async function recoverRestart(partial: string, artifact: Artifact): Promise<void> {
  const restart = partial + '.restart'
  const size = await stat(restart).then(info => info.size).catch(() => 0)
  if (!size) return
  const previous = await stat(partial).then(info => info.size).catch(() => 0)
  // A server ignoring Range downloads into a separate file. Keep the longest
  // incomplete prefix, or a fully verified replacement, across interruptions.
  if ((size > previous && (artifact.size === undefined || size < artifact.size)) || await artifactValid(restart, artifact)) await rename(restart, partial)
  else await rm(restart, { force: true })
}

/** Streaming, resumable, hash-bound downloads. An HTTP success is never readiness. */
export class ArtifactDownloader {
  private readonly pending = new Map<string, Promise<string>>()
  private readonly attempts: DownloadAttempt[] = []
  diagnostics(): DownloadAttempt[] { return structuredClone(this.attempts) }
  private record(artifact: Artifact, url: string, attempt: number, result: string): void {
    this.attempts.push({ id: artifact.id, source: new URL(url).hostname, attempt, at: new Date().toISOString(), result: result.replace(/https?:\/\/\S+/g, '<url>').slice(0, 300) })
    if (this.attempts.length > 300) this.attempts.shift()
  }
  constructor(private readonly fetcher: Fetcher, private readonly timing = { connect: 10_000, idle: 60_000 }) {}
  download(artifact: Artifact, destination: string, signal: AbortSignal, progress?: (value: DownloadProgress) => void): Promise<string> {
    const previous = this.pending.get(destination)
    if (previous) return previous
    const work = this.perform(artifact, destination, signal, progress).finally(() => this.pending.delete(destination))
    this.pending.set(destination, work)
    return work
  }
  private async perform(artifact: Artifact, destination: string, signal: AbortSignal, progress?: (value: DownloadProgress) => void): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !artifact.urls.length || artifact.urls.some(url => new URL(url).protocol !== 'https:')) throw new Error('ARTIFACT_MANIFEST_INVALID')
    const release = await slot(signal)
    const partial = `${destination}.part`
    const metadata = `${partial}.json`
    try {
      signal.throwIfAborted()
      if (await artifactValid(destination, artifact)) {
        progress?.({ id: artifact.id, received: (await stat(destination)).size, total: artifact.size ?? null, source: 'cache', attempt: 0 })
        return destination
      }
      await mkdir(path.dirname(destination), { recursive: true })
      const identity = JSON.stringify([artifact.sha256, artifact.size ?? null])
      if (await readFile(metadata, 'utf8').catch(() => '') !== identity) {
        await rm(partial, { force: true }); await rm(partial + '.restart', { force: true }); await writeFile(metadata, identity)
      }
      let last: unknown = new Error('DOWNLOAD_FAILED')
      for (const url of [...new Set(artifact.urls)]) for (let attempt = 1; attempt <= 2; attempt++) {
        signal.throwIfAborted()
        try {
          await recoverRestart(partial, artifact)
          if (!await artifactValid(partial, artifact)) await this.transfer(artifact, url, partial, signal, attempt, progress)
          if (!await artifactValid(partial, artifact)) {
            await rm(partial, { force: true }); throw new Error(`ARTIFACT_HASH_MISMATCH:${artifact.id}`)
          }
          await rename(partial, destination)
          await rm(metadata, { force: true })
          progress?.({ id: artifact.id, received: (await stat(destination)).size, total: artifact.size ?? null, source: new URL(url).hostname, attempt })
          this.record(artifact, url, attempt, 'verified')
          return destination
        } catch (error) {
          this.record(artifact, url, attempt, signal.aborted ? 'paused' : String(error))
          signal.throwIfAborted(); last = error
          if (/ENOSPC|EACCES|EPERM|EROFS/.test(String(error))) throw error
        }
      }
      throw last
    } finally { release() }
  }
  private async transfer(artifact: Artifact, url: string, partial: string, signal: AbortSignal, attempt: number, progress?: (value: DownloadProgress) => void): Promise<void> {
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    let timer = setTimeout(() => controller.abort(new Error('DOWNLOAD_CONNECT_TIMEOUT')), this.timing.connect)
    const armIdle = (): void => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error('DOWNLOAD_IDLE_TIMEOUT')), this.timing.idle) }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      signal.throwIfAborted()
      let offset = await stat(partial).then(info => info.size).catch(() => 0)
      if (artifact.size !== undefined && offset >= artifact.size) { await rm(partial, { force: true }); offset = 0 }
      const response = await this.fetcher(url, { signal: controller.signal, headers: { 'Accept-Encoding': 'identity', ...(offset ? { Range: `bytes=${offset}-` } : {}) } })
      armIdle()
      if (response.status === 416) { await response.body?.cancel(); await rm(partial, { force: true }); throw new Error('DOWNLOAD_RANGE_INVALID') }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`DOWNLOAD_HTTP_${response.status}`) }
      reader = response.body.getReader()
      controller.signal.addEventListener('abort', () => { void reader?.cancel(controller.signal.reason).catch(() => {}) }, { once: true })
      if (/text\/html/i.test(response.headers.get('content-type') ?? '')) throw new Error('DOWNLOAD_UNEXPECTED_HTML')
      let output = partial
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
        if (!range || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[2]) >= Number(range[3]) || (artifact.size !== undefined && Number(range[3]) !== artifact.size)) throw new Error('DOWNLOAD_RANGE_INVALID')
      } else { if (offset) output = partial + '.restart'; offset = 0 }
      handle = await open(output, offset ? 'a' : 'w')
      let received = offset
      const limit = artifact.size ?? 512 * 1024 * 1024
      while (true) {
        controller.signal.throwIfAborted()
        const next = await reader.read()
        controller.signal.throwIfAborted()
        if (next.done) break
        signal.throwIfAborted(); armIdle()
        received += next.value.byteLength
        if (received > limit) throw new Error('DOWNLOAD_TOO_LARGE')
        // FileHandle.write can write fewer bytes than requested.
        let written = 0
        while (written < next.value.byteLength) written += (await handle.write(next.value, written, next.value.byteLength - written)).bytesWritten
        progress?.({ id: artifact.id, received, total: artifact.size ?? null, source: new URL(url).hostname, attempt })
      }
      await handle.sync()
      if (artifact.size !== undefined && received !== artifact.size) throw new Error('DOWNLOAD_INCOMPLETE')
      if (output !== partial) {
        await handle.close(); handle = undefined
        if (!await artifactValid(output, artifact)) { await rm(output, { force: true }); throw new Error(`ARTIFACT_HASH_MISMATCH:${artifact.id}`) }
        await rename(output, partial)
      }
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      controller.abort(); await reader?.cancel().catch(() => {}); await handle?.close()
    }
  }
}

/** Cancel failed-batch siblings and wait for their file handles before repair. */
export async function downloadBatch<T>(items: T[], signal: AbortSignal, work: (item: T, signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const controller = new AbortController()
  const combined = AbortSignal.any([signal, controller.signal])
  let failure: unknown
  await Promise.all(items.map(async item => {
    try { await work(item, combined) } catch (error) { failure ??= error; controller.abort(error) }
  }))
  signal.throwIfAborted()
  if (failure !== undefined) throw failure
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.part`
  try { await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8'); await rename(temporary, file) }
  finally { await rm(temporary, { force: true }) }
}

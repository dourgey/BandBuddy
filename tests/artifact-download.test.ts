import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactDownloader, downloadBatch, type Artifact } from '../src/main/artifact-download.js'
import { remainingDownloadBytes } from '../src/main/environment-storage.js'

const directories: string[] = []
const bytes = Buffer.from('verified component 中文')
const artifact: Artifact = { id: 'test', filename: 'test.whl', urls: ['https://one.example/component', 'https://two.example/component'], sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
async function destination(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), 'bb-download-')); directories.push(root); return path.join(root, artifact.filename) }
afterEach(async () => { await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const signal = (): AbortSignal => new AbortController().signal

describe('verified resumable downloads', () => {
  it.each([403, 404, 429, 503])('limits HTTP %s retries and switches the actual file source', async status => {
    const fetcher = vi.fn(async (url: string) => url.includes('one.example') ? new Response('', { status }) : new Response(bytes))
    const file = await destination(), downloader = new ArtifactDownloader(fetcher)
    await downloader.download(artifact, file, signal())
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(await readFile(file)).toEqual(bytes)
    expect(downloader.diagnostics().map(item => item.result)).toEqual([`Error: DOWNLOAD_HTTP_${status}`, `Error: DOWNLOAD_HTTP_${status}`, 'verified'])
  })
  it.each(['html', 'wrong-hash', 'DNS'])('never installs a %s response as a successful component', async kind => {
    const fetcher = vi.fn(async () => {
      if (kind === 'DNS') throw new Error('ENOTFOUND')
      return kind === 'html' ? new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }) : new Response(Buffer.alloc(bytes.length))
    })
    const file = await destination()
    await expect(new ArtifactDownloader(fetcher).download(artifact, file, signal())).rejects.toThrow()
    await expect(readFile(file)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it.each([true, false])('resumes an interrupted file when server supports Range=%s', async supportsRange => {
    const file = await destination(), controller = new AbortController()
    const first = new ArtifactDownloader(async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(bytes.subarray(0, 7)) } })))
    const paused = first.download(artifact, file, controller.signal, () => controller.abort())
    await expect(paused).rejects.toThrow()
    expect(await readFile(file + '.part')).toEqual(bytes.subarray(0, 7))
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.headers).toMatchObject({ Range: 'bytes=7-' })
      return supportsRange ? new Response(bytes.subarray(7), { status: 206, headers: { 'content-range': `bytes 7-${bytes.length - 1}/${bytes.length}` } }) : new Response(bytes)
    })
    await new ArtifactDownloader(fetcher).download(artifact, file, signal())
    expect(await readFile(file)).toEqual(bytes)
  })
  it('does not append invalid ranges and ignores partials from a different hash', async () => {
    const file = await destination()
    await writeFile(file + '.part', bytes.subarray(0, 5)); await writeFile(file + '.part.json', JSON.stringify([artifact.sha256, artifact.size]))
    const wrongRange = new ArtifactDownloader(async () => new Response(bytes, { status: 206, headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` } }))
    await expect(wrongRange.download(artifact, file, signal())).rejects.toThrow('DOWNLOAD_RANGE_INVALID')
    expect(await readFile(file + '.part')).toEqual(bytes.subarray(0, 5))
    await writeFile(file + '.part.json', '["old",1]')
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => { expect(options.headers).not.toHaveProperty('Range'); return new Response(bytes) })
    await new ArtifactDownloader(fetcher).download(artifact, file, signal())
  })
  it('reuses verified files without network and replaces a corrupted cache file', async () => {
    const file = await destination(); await writeFile(file, bytes)
    const fetcher = vi.fn(async () => new Response(bytes)), downloader = new ArtifactDownloader(fetcher)
    await downloader.download(artifact, file, signal()); expect(fetcher).not.toHaveBeenCalled()
    await writeFile(file, Buffer.alloc(bytes.length))
    await downloader.download(artifact, file, signal()); expect(fetcher).toHaveBeenCalledOnce()
  })
  it('aborts connection waits and advances through only the bounded sources', async () => {
    const fetcher = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })))
    await expect(new ArtifactDownloader(fetcher, { connect: 5, idle: 5 }).download(artifact, await destination(), signal())).rejects.toThrow('DOWNLOAD_CONNECT_TIMEOUT')
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it('recovers from a server rejecting a saved range', async () => {
    const file = await destination()
    await writeFile(file + '.part', bytes.subarray(0, 7)); await writeFile(file + '.part.json', JSON.stringify([artifact.sha256, artifact.size]))
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => new Headers(options.headers).has('Range') ? new Response(null, { status: 416 }) : new Response(bytes))
    await new ArtifactDownloader(fetcher).download(artifact, file, signal())
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await readFile(file)).toEqual(bytes)
  })
  it('times out a stalled body without losing the saved bytes', async () => {
    const file = await destination()
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => new Response(new ReadableStream({ start(stream) {
      if (!new Headers(options.headers).has('Range')) stream.enqueue(bytes.subarray(0, 7))
    } }), new Headers(options.headers).has('Range') ? { status: 206, headers: { 'content-range': `bytes 7-${bytes.length - 1}/${bytes.length}` } } : {}))
    await expect(new ArtifactDownloader(fetcher, { connect: 100, idle: 10 }).download(artifact, file, signal())).rejects.toThrow('DOWNLOAD_IDLE_TIMEOUT')
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(await readFile(file + '.part')).toEqual(bytes.subarray(0, 7))
  })
  it('retains a saved prefix when a non-Range server stalls during replacement', async () => {
    const file = await destination()
    await writeFile(file + '.part', bytes.subarray(0, 7)); await writeFile(file + '.part.json', JSON.stringify([artifact.sha256, artifact.size]))
    const downloader = new ArtifactDownloader(async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(bytes.subarray(0, 3)) } })), { connect: 100, idle: 30 })
    await expect(downloader.download(artifact, file, signal())).rejects.toThrow('DOWNLOAD_IDLE_TIMEOUT')
    expect(await readFile(file + '.part')).toEqual(bytes.subarray(0, 7))
  })
  it('reserves replacement space for a corrupt complete partial while reusing valid partials', async () => {
    const file = await destination()
    await writeFile(file + '.part.json', JSON.stringify([artifact.sha256, artifact.size]))
    await writeFile(file + '.part', bytes.subarray(0, 7))
    expect(await remainingDownloadBytes(artifact, file)).toBe(bytes.length - 7)
    await writeFile(file + '.part', Buffer.alloc(bytes.length))
    expect(await remainingDownloadBytes(artifact, file)).toBe(bytes.length)
    await writeFile(file + '.part', bytes)
    expect(await remainingDownloadBytes(artifact, file)).toBe(0)
  })
  it('limits active transfers to two and cancels failed-batch siblings before returning', async () => {
    let active = 0, peak = 0
    const downloader = new ArtifactDownloader(async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; return new Response(bytes) })
    const files = await Promise.all(Array.from({ length: 7 }, destination))
    await Promise.all(files.map(file => downloader.download(artifact, file, signal())))
    expect(peak).toBe(2)
    let closed = false
    await expect(downloadBatch([1, 2], signal(), async (item, childSignal) => {
      if (item === 1) { await new Promise(resolve => setTimeout(resolve, 5)); throw new Error('failed') }
      await new Promise<void>(resolve => childSignal.addEventListener('abort', () => { closed = true; resolve() }, { once: true }))
    })).rejects.toThrow('failed')
    expect(closed).toBe(true)
  })
})

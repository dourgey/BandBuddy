import { randomBytes, createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, rename } from 'node:fs/promises'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces, tmpdir } from 'node:os'
import path from 'node:path'
import type { LanStatus, SongDetail } from '@shared/domain.js'
import { isStemVisible, STEM_META } from '@shared/domain.js'
import type { BandBuddyDatabase } from './database.js'
import type { MediaService } from './media.js'
import type { AppPaths } from './paths.js'
import type { Logger } from './logger.js'
import { parseByteRange } from './media-range.js'
import { runProcess } from './process.js'
import { runSignalsmithPitchShift } from './pitch-shift.js'

export const LAN_PORT = 60232
export const LAN_PROTOCOL = 'bandbuddy-lan'
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }

export function lanAddresses(): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap((entries) =>
    (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address)))]
}

export function isLocalAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/, '')
  const parts = ip.split('.').map(Number)
  return ip === '::1' || parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 169 && parts[1] === 254)
}

/** Session-only opt-in. Disabling revokes URLs, stops downloads and aborts render work. */
export class LanService {
  private server: Server | null = null
  private udp: Socket | null = null
  private token = ''
  private port: number | null = null
  private error: string | null = null
  private cacheRoot = ''
  private controller = new AbortController()
  private renders = new Map<string, Promise<string>>()
  private hashes = new Map<string, Promise<string>>()
  private renderQueue: Promise<unknown> = Promise.resolve()
  private transition: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly database: BandBuddyDatabase,
    private readonly media: MediaService,
    private readonly paths: AppPaths,
    private readonly logger: Logger,
    private readonly rendererRoot: string,
    private readonly discoveryPort = LAN_PORT
  ) {}

  status(): LanStatus {
    return { enabled: this.server !== null && this.port !== null, port: this.port,
      urls: this.port ? lanAddresses().map((host) => `http://${host}:${this.port}/s/${this.token}/`) : [], error: this.error }
  }

  setEnabled(enabled: boolean): Promise<LanStatus> {
    const operation = this.transition.then(async () => {
      if (!enabled) { await this.stop(); return this.status() }
      if (this.server) return this.status()
      this.error = null
      this.token = randomBytes(24).toString('hex')
      this.controller = new AbortController()
      this.cacheRoot = await mkdtemp(path.join(tmpdir(), 'bandbuddy-lan-'))
      try {
        if (!existsSync(path.join(this.rendererRoot, 'lan.html'))) throw new Error('请先构建局域网页面（pnpm build）')
        const server = createServer((request, response) => {
          void this.handle(request, response).catch((error) => {
            this.logger.warn('LAN request failed', String(error))
            if (!response.headersSent) this.json(response, 500, { error: '无法读取或准备歌曲，请在桌面端检查文件后重试' })
            else response.destroy()
          })
        })
        server.requestTimeout = 120_000
        server.headersTimeout = 15_000
        this.server = server
        for (const candidate of [...Array.from({ length: 101 }, (_, index) => LAN_PORT + index), 0]) {
          try {
            await new Promise<void>((resolve, reject) => {
              const onError = (error: Error): void => { server.off('listening', onListening); reject(error) }
              const onListening = (): void => { server.off('error', onError); resolve() }
              server.once('error', onError).once('listening', onListening).listen(candidate, '0.0.0.0')
            })
            const address = server.address()
            this.port = typeof address === 'object' && address ? address.port : candidate
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || candidate === 0) throw error
          }
        }
        server.on('error', (error) => { this.error = error.message; this.logger.warn('LAN server error', error) })
        this.startDiscovery()
      } catch (error) {
        await this.stop()
        this.error = String(error instanceof Error ? error.message : error)
      }
      return this.status()
    })
    this.transition = operation.catch(() => undefined)
    return operation
  }

  async stop(): Promise<void> {
    this.controller.abort()
    const server = this.server
    this.server = null; this.port = null; this.token = ''; this.error = null
    this.udp?.close(); this.udp = null
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    }
    await this.renderQueue.catch(() => undefined)
    this.renderQueue = Promise.resolve(); this.renders.clear(); this.hashes.clear()
    if (this.cacheRoot) await rm(this.cacheRoot, { recursive: true, force: true }).catch(() => undefined)
    this.cacheRoot = ''
  }

  private discovery(): object {
    return { service: LAN_PROTOCOL, version: 1, name: 'BandBuddy', port: this.port,
      handshake: '/api/v1/handshake', capabilities: ['stems', 'lyrics', 'video', 'range', 'sha256'] }
  }

  private startDiscovery(): void {
    const udp = createSocket('udp4')
    this.udp = udp
    udp.on('error', (error) => { this.logger.warn('LAN UDP discovery unavailable; HTTP discovery remains available', error); udp.close(); if (this.udp === udp) this.udp = null })
    udp.on('message', (message, peer) => {
      if (!this.port || !isLocalAddress(peer.address) || message.length > 512) return
      try {
        const value = JSON.parse(message.toString())
        if (value.service === LAN_PROTOCOL && value.type === 'discover' && value.version === 1) {
          udp.send(Buffer.from(JSON.stringify(this.discovery())), peer.port, peer.address)
        }
      } catch { /* Ignore unrelated LAN datagrams. */ }
    })
    udp.bind(this.discoveryPort, '0.0.0.0')
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
    response.end(JSON.stringify(value))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isLocalAddress(request.socket.remoteAddress ?? '')) return this.json(response, 403, { error: 'LAN_ONLY' })
    // Native clients omit Origin. Browsers must use this exact origin; no CORS surface.
    if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return this.json(response, 403, { error: 'ORIGIN_REJECTED' })
    const host = request.headers.host?.split(':')[0]
    if (!host || !['127.0.0.1', 'localhost', ...lanAddresses()].includes(host)) return this.json(response, 403, { error: 'HOST_REJECTED' })
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/api/v1/discovery' && request.method === 'GET') return this.json(response, 200, this.discovery())
    if (url.pathname === '/api/v1/handshake' && request.method === 'POST') {
      if (!request.headers['content-type']?.startsWith('application/json')) return this.json(response, 415, { error: 'JSON_REQUIRED' })
      let body = ''
      for await (const chunk of request) {
        body += chunk.toString()
        if (body.length > 4096) { this.json(response, 413, { error: 'BODY_TOO_LARGE' }); return }
      }
      let client: { service?: string; version?: number; platform?: string }
      try { client = JSON.parse(body) } catch { return this.json(response, 400, { error: 'INVALID_JSON' }) }
      if (!client || client.service !== LAN_PROTOCOL || client.version !== 1 || !['ios', 'android', 'desktop'].includes(client.platform ?? '')) return this.json(response, 400, { error: 'UNSUPPORTED_CLIENT' })
      return this.json(response, 200, { ...this.discovery(), basePath: `/s/${this.token}/`, expires: 'when LAN mode stops', songs: 'api/v1/songs' })
    }
    if (!['GET', 'HEAD'].includes(request.method ?? '')) return this.json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    const prefix = `/s/${this.token}/`
    if (!this.token || !url.pathname.startsWith(prefix)) return this.json(response, 404, { error: 'NOT_FOUND' })
    const route = url.pathname.slice(prefix.length)
    if (route === 'api/v1/songs') {
      const songs = this.database.listSongs('', 'all').filter((song) => song.status === 'ready')
      return this.json(response, 200, { version: 1, songs: songs.map((song) => ({
        id: song.id, title: song.title, artist: song.artist, durationMs: song.durationMs,
        updatedAt: song.updatedAt, stemCount: song.stemTypes.length,
        manifest: `api/v1/songs/${song.id}/manifest`
      })) })
    }
    const manifest = /^api\/v1\/songs\/([0-9a-f-]{36})\/manifest$/.exec(route)
    if (manifest) {
      const song = this.database.getSong(manifest[1]!)
      if (!song || song.status !== 'ready') return this.json(response, 404, { error: 'SONG_NOT_READY' })
      return this.json(response, 200, await this.manifest(song))
    }
    const asset = /^media\/([0-9a-f-]{36})\/(stem|peaks|video|artwork)(?:\/([0-9a-f-]{36}))?$/.exec(route)
    if (asset) {
      const [, songId, kind, assetId] = asset
      const song = this.database.getSong(songId!)
      if (!song || song.status !== 'ready' || ((kind === 'stem' || kind === 'peaks') && !song.stems.some((stem) => stem.id === assetId))) return this.json(response, 404, { error: 'NOT_FOUND' })
      const input = this.media.resolveProtocolPath(new URL(`bandbuddy-media://song/${songId}/${kind}${assetId ? `/${assetId}` : ''}`))
      if (!input) return this.json(response, 404, { error: 'NOT_FOUND' })
      const pitch = Number(url.searchParams.get('pitch') ?? '0')
      if (!Number.isInteger(pitch) || pitch < -12 || pitch > 12) return this.json(response, 400, { error: 'INVALID_PITCH' })
      const output = url.searchParams.get('web') === '1' && (kind === 'stem' || kind === 'video')
        ? await this.webMedia(input, kind, pitch) : input
      return this.file(request, response, output)
    }
    // Serve only generated web assets, never arbitrary renderer or library paths.
    if (route === '' || /^assets\/[a-zA-Z0-9_.-]+$/.test(route)) {
      return this.file(request, response, path.join(this.rendererRoot, route || 'lan.html'))
    }
    this.json(response, 404, { error: 'NOT_FOUND' })
  }

  private async assetInfo(songId: string, kind: string, id?: string): Promise<object | null> {
    const relative = `media/${songId}/${kind}${id ? `/${id}` : ''}`
    const file = this.media.resolveProtocolPath(new URL(`bandbuddy-media://song/${songId}/${kind}${id ? `/${id}` : ''}`))
    if (!file) return null
    const info = await stat(file)
    const key = `${file}:${info.size}:${info.mtimeMs}`
    let digest = this.hashes.get(key)
    if (!digest) {
      digest = (async () => {
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(file)) hash.update(chunk)
        return hash.digest('hex')
      })()
      this.hashes.set(key, digest)
      void digest.catch(() => this.hashes.delete(key))
    }
    return { url: relative, bytes: info.size, sha256: await digest, mimeType: MIME[path.extname(file)] ?? 'application/octet-stream' }
  }

  private async manifest(song: SongDetail): Promise<object> {
    return {
      version: 1, id: song.id, title: song.title, artist: song.artist, durationMs: song.durationMs,
      updatedAt: song.updatedAt, lyrics: song.lyrics, bpm: song.bpm, musicalKey: song.musicalKey,
      stems: await Promise.all(song.stems.map(async (stem) => ({
        id: stem.id, type: stem.type, name: stem.name || STEM_META[stem.type].label,
        durationMs: stem.durationMs, sampleRate: stem.sampleRate, channels: stem.channels,
        defaultVisible: song.sourceFormat === 'existing-stems' || isStemVisible(stem.type, song.practice.guitarSplitEnabled),
        audio: await this.assetInfo(song.id, 'stem', stem.id),
        peaks: stem.peaksUrl ? await this.assetInfo(song.id, 'peaks', stem.id) : null
      }))),
      artwork: song.artworkUrl ? await this.assetInfo(song.id, 'artwork') : null,
      video: song.videoUrl ? await this.assetInfo(song.id, 'video') : null
    }
  }

  private async webMedia(input: string, kind: string, pitch: number): Promise<string> {
    const info = await stat(input)
    const key = createHash('sha256').update(`${input}:${info.size}:${info.mtimeMs}:${kind}:${pitch}`).digest('hex')
    const existing = this.renders.get(key)
    if (existing) return existing
    // Bound cache/CPU growth from simultaneous clients and pitch changes.
    if (this.renders.size >= 128) throw new Error('LAN_CACHE_LIMIT: 请重新开启局域网模式以清理缓存')
    const root = this.cacheRoot
    const signal = this.controller.signal
    const render = this.renderQueue.catch(() => undefined).then(async () => {
      if (signal.aborted) throw new Error('LAN_STOPPED')
      const ffmpeg = this.media.tool('ffmpeg')
      if (!ffmpeg) throw new Error('FFMPEG_MISSING')
      const directory = path.join(root, key)
      await mkdir(directory, { recursive: true })
      const output = path.join(directory, kind === 'video' ? 'video.mp4' : 'audio.mp3')
      const temporary = path.join(directory, kind === 'video' ? 'video.part.mp4' : 'audio.part.mp3')
      try {
        let source = input
        if (kind === 'stem' && pitch !== 0) {
          const decoded = path.join(directory, 'decoded.wav')
          await this.media.decodeAudio(input, path.join(directory, 'decoded.part.wav'), decoded, signal)
          source = path.join(directory, 'pitched.wav')
          await runSignalsmithPitchShift(this.paths, decoded, source, pitch, signal)
        }
        const args = kind === 'video'
          ? ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
          : ['-vn', '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k']
        const result = await runProcess(ffmpeg, ['-y', '-v', 'error', '-i', source, ...args, temporary], { signal })
        if (signal.aborted || result.code !== 0) throw new Error('LAN_MEDIA_RENDER_FAILED')
        await rename(temporary, output)
        await Promise.all(['decoded.wav', 'pitched.wav'].map((name) => rm(path.join(directory, name), { force: true })))
        return output
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      }
    })
    this.renders.set(key, render)
    this.renderQueue = render.catch(() => undefined)
    void render.catch(() => this.renders.delete(key))
    return render
  }

  private async file(request: IncomingMessage, response: ServerResponse, file: string): Promise<void> {
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) return this.json(response, 404, { error: 'NOT_FOUND' })
    const range = request.headers.range ? parseByteRange(request.headers.range, info.size) : null
    if (request.headers.range && !range) {
      response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return
    }
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
    response.writeHead(range ? 206 : 200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': range ? range.end - range.start + 1 : info.size,
      'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-cache', ETag: etag,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
      ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` } : {})
    })
    if (request.method === 'HEAD') { response.end(); return }
    const stream = createReadStream(file, range ?? undefined)
    response.once('close', () => stream.destroy())
    stream.once('error', () => response.destroy())
    stream.pipe(response)
  }
}

import type { WebSocket } from 'ws'
import { LAN_PCM_HEADER, LAN_PCM_MAGIC, LAN_PCM_RATE, type LanPcmConfig } from '@shared/lan.js'
import { stemPlaybackGain, STEM_GROUPS, type SongDetail } from '@shared/domain.js'
import type { MediaService } from './media.js'
import type { AppPaths } from './paths.js'
import { LanPcmRenderer, type LanPcmSource } from './lan-pcm.js'

export function validPcmConfig(value: unknown): value is LanPcmConfig {
  if (!value || typeof value !== 'object') return false
  const v = value as LanPcmConfig
  return v.type === 'configure' && Number.isSafeInteger(v.generation) && v.generation > 0 && v.generation <= 0xffffffff
    && typeof v.songId === 'string' && /^[0-9a-f-]{36}$/.test(v.songId)
    && Number.isFinite(v.position) && v.position >= 0 && Number.isFinite(v.rate) && v.rate >= .5 && v.rate <= 2
    && Number.isInteger(v.pitch) && Math.abs(v.pitch) <= 12 && typeof v.playing === 'boolean'
    && Array.isArray(v.mix) && v.mix.length > 0 && v.mix.length <= 16 && v.mix.every(m => m && Number.isFinite(m.gain)
      && m.gain >= 0 && m.gain <= 1.5 && typeof m.muted === 'boolean' && typeof m.solo === 'boolean' && typeof m.visible === 'boolean')
    && (v.loop === null || typeof v.loop === 'object' && Number.isFinite(v.loop?.start) && Number.isFinite(v.loop?.end)
      && v.loop.start >= 0 && v.loop.end > v.loop.start + .1)
}

/** A session never controls the desktop transport or owns an audio device. */
export class LanStreamSession {
  private generation = 0
  private operation = new AbortController()
  private renderer: LanPcmRenderer | null = null
  private config: LanPcmConfig | null = null
  private credits = 0
  private pumping = false
  private sequence = 0
  private closed = false
  private lastActivity = Date.now()
  private windowStart = Date.now()
  private messages = 0
  private heartbeat: NodeJS.Timeout
  private timeout: NodeJS.Timeout | undefined
  constructor(private socket: WebSocket, private getSong: (id: string) => SongDetail | null,
    private media: MediaService, private paths: AppPaths, private onClose: () => void) {
    socket.on('message', (data, binary) => {
      this.lastActivity = Date.now()
      if (Date.now() - this.windowStart > 1000) { this.windowStart = Date.now(); this.messages = 0 }
      if (binary || ++this.messages > 120) { socket.close(1008, 'INVALID_COMMAND'); return }
      try {
        const value = JSON.parse(data.toString())
        if (value.type === 'configure') {
          if (!validPcmConfig(value) || value.generation <= this.generation) throw new Error('INVALID_CONFIG')
          void this.configure(value).catch(() => this.fail(value.generation))
        } else if (value.type === 'mix' && value.generation === this.generation && this.config) {
          const config = { ...this.config, mix: value.mix }
          const song = this.getSong(config.songId)
          if (!validPcmConfig(config) || !song || !this.validMix(song, config)) throw new Error('INVALID_MIX')
          this.config = config; this.renderer?.setGains(this.gains(song, config))
        } else if (value.type === 'pull' && value.generation === this.generation && Number.isInteger(value.count) && value.count > 0 && value.count <= 24) {
          this.credits = Math.min(24, this.credits + value.count); void this.pump()
        } else throw new Error('INVALID_COMMAND')
      } catch { socket.close(1008, 'INVALID_COMMAND') }
    })
    socket.on('close', () => this.dispose())
    socket.on('error', () => this.dispose())
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastActivity > 20_000) { this.renderer?.dispose(); this.renderer = null }
      if (Date.now() - this.lastActivity > 60_000) this.socket.terminate()
      else this.socket.ping()
    }, 10_000)
    socket.on('pong', () => { this.lastActivity = Date.now() })
    this.heartbeat.unref()
  }
  private send(value: object): void { if (!this.closed && this.socket.readyState === 1) this.socket.send(JSON.stringify(value)) }
  private async configure(config: LanPcmConfig): Promise<void> {
    this.operation.abort(); this.renderer?.dispose(); this.renderer = null
    clearTimeout(this.timeout)
    this.operation = new AbortController(); this.config = config; this.generation = config.generation; this.credits = 0; this.sequence = 0
    const song = this.getSong(config.songId)
    if (!song || song.status !== 'ready' || config.mix.length !== song.stems.length || config.position > song.durationMs / 1000
      || config.loop && config.loop.end > song.durationMs / 1000) { this.fail(config.generation); return }
    if (!this.validMix(song, config)) { this.fail(config.generation); return }
    if (config.playing) {
      const signal = this.operation.signal
      const renderer = await this.open(song, config.position, signal)
      if (signal.aborted || this.closed) { renderer.dispose(); return }
      renderer.setGains(this.gains(song, this.config!))
      this.renderer = renderer
    }
    this.send({ type: 'ready', generation: config.generation })
    void this.pump()
  }
  private validMix(song: SongDetail, config: LanPcmConfig): boolean {
    if (song.stems.length !== config.mix.length) return false
    if (song.sourceFormat === 'existing-stems') return true
    for (const group of STEM_GROUPS) {
      const visible = (type: string): boolean => song.stems.some((stem, i) => stem.type === type && config.mix[i]!.visible)
      if (visible(group.parent) && group.children.some(visible)) return false
    }
    return true
  }
  private gains(song: SongDetail, config: LanPcmConfig): number[] {
    const solo = config.mix.some(m => m.visible && !m.muted && m.solo)
    return song.stems.map((stem, index) => {
      const m = config.mix[index]!
      return m.visible && !m.muted && (!solo || m.solo) ? m.gain * stemPlaybackGain(stem) : 0
    })
  }
  private async open(song: SongDetail, position: number, signal: AbortSignal): Promise<LanPcmRenderer> {
    const config = this.config!
    const gains = this.gains(song, config)
    const sources: LanPcmSource[] = song.stems.map((stem, index) => {
      const file = this.media.resolveProtocolPath(new URL(`bandbuddy-media://song/${song.id}/stem/${stem.id}`))
      if (!file) throw new Error('LAN_SOURCE_MISSING')
      return { path: file, drums: stem.type === 'drums', gain: gains[index]! }
    })
    const ffmpeg = await this.media.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    return LanPcmRenderer.create(ffmpeg, this.paths.audioHostExecutable(), sources,
      position, config.loop?.end ?? song.durationMs / 1000, config.rate, config.pitch, signal)
  }
  private fail(generation: number): void {
    if (generation !== this.generation || this.closed) return
    this.operation.abort(); this.renderer?.dispose(); this.renderer = null; this.credits = 0
    this.send({ type: 'error', generation, message: '电脑端音频流准备失败，请检查歌曲文件与音频组件后重试' })
  }
  private async pump(): Promise<void> {
    if (this.pumping || !this.renderer || !this.config?.playing || this.closed) return
    this.pumping = true
    const generation = this.generation, signal = this.operation.signal
    // A decoder stall must not leave either endpoint waiting forever.
    this.timeout = setTimeout(() => this.fail(generation), 15_000)
    try {
      while (this.credits > 0 && this.renderer && !signal.aborted && !this.closed) {
        if (this.socket.bufferedAmount > 256_000) break
        const chunk = await this.renderer.next()
        if (signal.aborted || this.closed) break
        if (!chunk) {
          const loop = this.config!.loop
          if (!loop) { this.send({ type: 'ended', generation }); this.renderer.dispose(); this.renderer = null; this.credits = 0; break }
          const song = this.getSong(this.config!.songId)
          if (!song) throw new Error('SONG_REMOVED')
          this.renderer.dispose()
          const next = await this.open(song, loop.start, signal)
          if (signal.aborted || this.closed) { next.dispose(); break }
          next.setGains(this.gains(song, this.config!))
          this.renderer = next; continue
        }
        this.credits--
        const header = Buffer.alloc(LAN_PCM_HEADER)
        header.writeUInt32LE(LAN_PCM_MAGIC, 0); header.writeUInt32LE(generation, 4); header.writeUInt32LE(this.sequence++, 8)
        header.writeUInt32LE(chunk.frames, 12); header.writeDoubleLE(chunk.position, 16); header.writeDoubleLE(this.config!.rate, 24)
        header.writeUInt32LE(LAN_PCM_RATE, 32); header.writeUInt32LE(chunk.ended && !this.config!.loop ? 1 : 0, 36)
        this.socket.send(Buffer.concat([header, chunk.pcm]))
      }
    } catch { if (!signal.aborted) this.fail(generation) }
    finally {
      clearTimeout(this.timeout); this.pumping = false
      if (generation !== this.generation) void this.pump()
    }
  }
  dispose(): void {
    if (this.closed) return
    this.closed = true; clearTimeout(this.timeout); clearInterval(this.heartbeat)
    this.operation.abort(); this.renderer?.dispose(); this.renderer = null
    this.socket.terminate(); this.onClose()
  }
}

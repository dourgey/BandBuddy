import { LAN_PCM_FRAMES, LAN_PCM_HEADER, LAN_PCM_MAGIC, LAN_PCM_RATE,
  type LanMixState, type LanPcmConfig, type LanPcmEvent, type LanSong } from '@shared/lan.js'

export type MixState = LanMixState
interface Packet { samples: Float32Array; frames: number; position: number; rate: number; last: boolean }
interface Scheduled { source: AudioBufferSourceNode; gain: GainNode; start: number; end: number; position: number; rate: number }

/** HTTP-compatible PCM playback. One audio clock, bounded look-ahead, no local DSP. */
export class LanPlayer {
  private context: AudioContext
  private socket: WebSocket | null = null
  private song: LanSong | null = null
  private states: MixState[] = []
  private generation = 0
  private sequence = 0
  private outstanding = 0
  private ready = false
  private playing = false
  private position = 0
  private rate = 1
  private pitch = 0
  private loop: { start: number; end: number } | null = null
  private scheduled: Scheduled[] = []
  private pending: Packet[] = []
  private priming = true
  private nextTime = 0
  private ended = false
  private video: HTMLVideoElement | null = null
  private timer: number | null = null
  private mixTimer: number | undefined
  private watchdog: number | undefined
  private lastPacketAt = 0
  private transport = 0
  private loadReject: ((error: Error) => void) | null = null
  private loadResolve: (() => void) | null = null
  private abortLoad: (() => void) | null = null
  onTime: (seconds: number) => void = () => undefined
  onPlaying: (playing: boolean) => void = () => undefined
  onError: (message: string) => void = () => undefined
  onProgress: (progress: number) => void = () => undefined
  onBuffering: (buffering: boolean) => void = () => undefined

  constructor() {
    const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Constructor) throw new Error('此浏览器不支持 Web Audio，请更新浏览器')
    this.context = new Constructor({ sampleRate: LAN_PCM_RATE })
  }
  unlock(): void {
    void this.context.resume().catch(() => undefined)
    const source = this.context.createBufferSource()
    source.buffer = this.context.createBuffer(1, 1, this.context.sampleRate)
    source.connect(this.context.destination); source.start(); source.onended = () => source.disconnect()
  }
  attachVideo(video: HTMLVideoElement | null): void {
    this.video = video
    if (video) { video.muted = true; video.playbackRate = this.rate }
  }
  async load(song: LanSong, base: URL, pitch: number, signal: AbortSignal): Promise<void> {
    this.clear(); signal.throwIfAborted()
    this.song = song; this.pitch = pitch
    this.states = song.stems.map(stem => ({ gain: 1, muted: false, solo: false, visible: stem.defaultVisible }))
    const url = new URL('api/v1/pcm', base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url); socket.binaryType = 'arraybuffer'; this.socket = socket
    await new Promise<void>((resolve, reject) => {
      this.loadResolve = resolve; this.loadReject = reject
      const abort = (): void => { if (this.socket === socket) this.clear() }
      this.abortLoad = () => signal.removeEventListener('abort', abort)
      signal.addEventListener('abort', abort, { once: true })
      this.watchdog = window.setTimeout(() => this.fail('连接电脑超时，请检查局域网连接后重试'), 15_000)
      socket.onopen = () => { if (socket === this.socket) this.configure(false) }
      socket.onmessage = event => {
        if (socket !== this.socket) return
        try {
          if (event.data instanceof ArrayBuffer) this.receive(event.data)
          else this.event(JSON.parse(event.data) as LanPcmEvent)
        } catch { this.fail('收到的音频流无效，请重新连接电脑') }
      }
      socket.onerror = () => { if (socket === this.socket) this.fail('无法连接电脑端音频流，请检查网络后重试') }
      socket.onclose = () => { if (socket === this.socket) this.fail('与电脑的连接已断开，请重新连接') }
    })
    signal.throwIfAborted()
    this.timer = window.setInterval(() => this.tick(), 25)
  }
  private event(event: LanPcmEvent): void {
    if (event.generation !== this.generation) return
    if (event.type === 'error') { this.fail(event.message); return }
    if (event.type === 'ended') { this.ended = true; this.outstanding = 0; this.drain(true); return }
    if (event.type !== 'ready') return
    this.ready = true; this.lastPacketAt = performance.now()
    window.clearTimeout(this.watchdog)
    this.loadResolve?.(); this.loadResolve = null; this.loadReject = null
    this.onProgress(1); this.pull()
  }
  private configure(smooth: boolean): void {
    if (!this.song || this.socket?.readyState !== WebSocket.OPEN) return
    window.clearTimeout(this.mixTimer); this.mixTimer = undefined
    let position = this.currentPosition()
    const last = this.scheduled.at(-1)
    if (smooth && this.playing && last && last.end > this.context.currentTime + .025) {
      position = this.endPosition(last) - .01 * last.rate; this.nextTime = last.end - .01
    } else { this.stopScheduled(); this.nextTime = 0 }
    if (this.loop && (position < this.loop.start || position >= this.loop.end)) position = this.loop.start
    this.position = position; this.pending = []; this.priming = true; this.ready = false; this.ended = false
    this.outstanding = 0; this.sequence = 0; this.lastPacketAt = performance.now()
    const config: LanPcmConfig = { type: 'configure', generation: ++this.generation, songId: this.song.id,
      playing: this.playing, position, rate: this.rate, pitch: this.pitch, mix: this.states, loop: this.loop }
    this.socket.send(JSON.stringify(config))
    if (this.playing) this.onBuffering(!this.scheduled.length)
  }
  private pull(): void {
    if (!this.ready || !this.playing || this.ended || this.socket?.readyState !== WebSocket.OPEN) return
    const scheduledSeconds = Math.max(0, (this.scheduled.at(-1)?.end ?? 0) - this.context.currentTime)
    const queued = Math.ceil(scheduledSeconds * LAN_PCM_RATE / LAN_PCM_FRAMES) + this.pending.length + this.outstanding
    const count = Math.max(0, Math.min(24, 20 - queued))
    if (count > 0) { this.outstanding += count; this.socket.send(JSON.stringify({ type: 'pull', generation: this.generation, count })) }
  }
  private receive(data: ArrayBuffer): void {
    if (data.byteLength < LAN_PCM_HEADER) throw new Error('SHORT_PCM')
    const header = new DataView(data)
    if (header.getUint32(0, true) !== LAN_PCM_MAGIC) throw new Error('INVALID_PCM')
    if (header.getUint32(4, true) !== this.generation || !this.playing) return
    const frames = header.getUint32(12, true), position = header.getFloat64(16, true), rate = header.getFloat64(24, true)
    if (header.getUint32(8, true) !== this.sequence++ || !frames || frames > LAN_PCM_FRAMES
      || header.getUint32(32, true) !== LAN_PCM_RATE || data.byteLength !== LAN_PCM_HEADER + frames * 8
      || !Number.isFinite(position) || position < 0 || rate !== this.rate) throw new Error('INVALID_PCM_TIMELINE')
    this.outstanding = Math.max(0, this.outstanding - 1); this.lastPacketAt = performance.now()
    const samples = new Float32Array(data, LAN_PCM_HEADER)
    if (samples.some(value => !Number.isFinite(value))) throw new Error('INVALID_PCM_SAMPLE')
    if (this.pending.length >= 24) throw new Error('PCM_QUEUE_OVERFLOW')
    const last = Boolean(header.getUint32(36, true) & 1)
    this.pending.push({ samples, frames, position, rate, last })
    this.drain(last); this.pull()
  }
  private drain(force = false): void {
    if (!this.pending.length || this.priming && !force && this.pending.reduce((n, p) => n + p.frames, 0) < LAN_PCM_RATE * .16) return
    let first = this.priming
    if (this.nextTime < this.context.currentTime + .01) this.nextTime = this.context.currentTime + .04
    this.priming = false; this.onBuffering(false)
    for (const packet of this.pending.splice(0)) {
      const buffer = this.context.createBuffer(2, packet.frames, LAN_PCM_RATE)
      for (let c = 0; c < 2; c++) {
        const channel = buffer.getChannelData(c)
        for (let f = 0; f < packet.frames; f++) channel[f] = packet.samples[f * 2 + c]!
      }
      const source = this.context.createBufferSource(), gain = this.context.createGain()
      source.buffer = buffer; source.connect(gain).connect(this.context.destination)
      let start = this.nextTime
      if (first) {
        const old = this.scheduled.at(-1)
        if (old && old.end > this.context.currentTime + .025) {
          start = old.end - .01
          old.gain.gain.setValueAtTime(1, start); old.gain.gain.linearRampToValueAtTime(0, old.end)
        }
        gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(1, start + .01)
        first = false
      }
      const end = start + buffer.duration
      const previous = this.scheduled.at(-1)
      if (previous && Math.abs(this.endPosition(previous) - packet.position) > .005) {
        // Loop wraps have a new source timestamp but retain the output clock.
        previous.gain.gain.setValueAtTime(1, Math.max(previous.start, previous.end - .005))
        previous.gain.gain.linearRampToValueAtTime(0, previous.end)
        gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(1, start + .005)
      }
      if (packet.last) { gain.gain.setValueAtTime(1, Math.max(start, end - .01)); gain.gain.linearRampToValueAtTime(0, end) }
      source.start(start)
      const entry = { source, gain, start, end, position: packet.position, rate: packet.rate }
      this.scheduled.push(entry); this.nextTime = end
      source.onended = () => {
        this.position = this.currentPosition()
        source.disconnect(); gain.disconnect(); this.scheduled = this.scheduled.filter(item => item !== entry)
      }
    }
  }
  private endPosition(entry: Scheduled): number { return entry.position + (entry.end - entry.start) * entry.rate }
  private currentPosition(): number {
    const now = this.context.currentTime
    const current = this.scheduled.find(entry => now >= entry.start && now < entry.end)
    if (current) return current.position + (now - current.start) * current.rate
    const previous = this.scheduled.filter(entry => entry.end <= now).at(-1)
    if (previous) return this.endPosition(previous)
    return this.scheduled[0]?.position ?? this.position
  }
  private stopScheduled(): void {
    const now = this.context.currentTime
    for (const entry of this.scheduled) {
      entry.source.onended = null; entry.gain.gain.cancelScheduledValues(now); entry.gain.gain.setTargetAtTime(0, now, .003)
      entry.source.stop(now + .012)
      entry.source.onended = () => { entry.source.disconnect(); entry.gain.disconnect() }
    }
    this.scheduled = []; this.pending = []
  }
  async setTransform(rate: number, pitch: number): Promise<void> {
    if (!Number.isFinite(rate) || rate < .5 || rate > 2 || !Number.isInteger(pitch) || Math.abs(pitch) > 12) throw new Error('无效的播放速度或音调')
    if (rate === this.rate && pitch === this.pitch) return
    this.rate = rate; this.pitch = pitch; this.configure(true)
  }
  async play(): Promise<void> {
    if (!this.song || this.playing) return
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('音频连接已断开，请重试')
    const transport = ++this.transport
    this.unlock(); await this.context.resume()
    if (!this.song || transport !== this.transport) return
    if (this.position >= this.song.durationMs / 1000 - .01) this.position = this.loop?.start ?? 0
    this.playing = true; this.configure(false); this.onPlaying(true)
  }
  pause(): void {
    this.transport++
    this.position = this.currentPosition(); this.playing = false; this.stopScheduled()
    this.configure(false); this.video?.pause(); this.onPlaying(false); this.onBuffering(false); this.onTime(this.position)
  }
  seek(seconds: number): void {
    this.stopScheduled(); this.position = Math.max(0, Math.min(this.song?.durationMs ? this.song.durationMs / 1000 : 0, seconds))
    this.configure(false); this.onTime(this.position)
    if (this.video) this.video.currentTime = this.position
  }
  setLoop(loop: { start: number; end: number } | null): void {
    if (JSON.stringify(this.loop) === JSON.stringify(loop)) return
    this.loop = loop; this.configure(false)
  }
  mix(states: MixState[]): void {
    if (JSON.stringify(states) === JSON.stringify(this.states)) return
    this.states = states.map(state => ({ ...state, visible: state.visible !== false }))
    window.clearTimeout(this.mixTimer)
    this.mixTimer = window.setTimeout(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'mix', generation: this.generation, mix: this.states }))
    }, 50)
  }
  private tick(): void {
    if (!this.playing) return
    this.position = this.currentPosition(); this.onTime(this.position)
    const hasAudio = this.scheduled.some(entry => entry.end > this.context.currentTime)
    if (!hasAudio) {
      this.video?.pause()
      if (this.ended) { this.pause(); this.seek(0); return }
      this.priming = true; this.onBuffering(true)
    }
    if (!this.ended && performance.now() - this.lastPacketAt > 15_000) { this.fail('音频传输中断，请检查网络后重试'); return }
    if (this.video && hasAudio) {
      const audible = this.scheduled.find(entry => this.context.currentTime >= entry.start && this.context.currentTime < entry.end)
      this.video.playbackRate = audible?.rate ?? this.rate
      if (Math.abs(this.video.currentTime - this.position) > .12) this.video.currentTime = this.position
      if (this.video.paused) void this.video.play().catch(() => undefined)
    }
    this.pull()
  }
  private fail(message: string): void {
    this.transport++
    const reject = this.loadReject; this.loadReject = null; this.loadResolve = null
    this.position = this.currentPosition(); this.playing = false; this.stopScheduled(); this.video?.pause()
    const socket = this.socket; this.socket = null; socket?.close()
    window.clearTimeout(this.watchdog); this.abortLoad?.(); this.abortLoad = null
    if (this.timer !== null) window.clearInterval(this.timer); this.timer = null
    reject?.(new Error(message)); this.onPlaying(false); this.onBuffering(false); this.onError(message)
  }
  clear(): void {
    this.transport++
    const socket = this.socket; this.socket = null; socket?.close()
    this.loadReject?.(new DOMException('Aborted', 'AbortError')); this.loadResolve = null; this.loadReject = null
    this.abortLoad?.(); this.abortLoad = null; window.clearTimeout(this.watchdog); window.clearTimeout(this.mixTimer)
    if (this.timer !== null) window.clearInterval(this.timer); this.timer = null
    this.playing = false; this.stopScheduled(); this.video?.pause(); this.video = null
    this.song = null; this.position = 0; this.rate = 1; this.pitch = 0; this.loop = null
    this.onPlaying(false); this.onBuffering(false); this.onTime(0)
  }
  dispose(): void { this.clear(); void this.context.close() }
}

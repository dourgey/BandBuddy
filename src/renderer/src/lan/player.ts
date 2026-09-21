import type { LanSong } from '@shared/lan.js'

export interface MixState { gain: number; muted: boolean; solo: boolean }
interface Track { element: HTMLAudioElement; source: MediaElementAudioSourceNode; gain: GainNode; state: MixState }

/** Streaming media avoids keeping every decoded song-length stem in mobile memory. */
export class LanPlayer {
  private context: AudioContext
  private tracks: Track[] = []
  private timer: number | null = null
  private playing = false
  private loop: { start: number; end: number } | null = null
  private video: HTMLVideoElement | null = null
  private generation = 0
  private duration = 0
  private position = 0
  onTime: (seconds: number) => void = () => undefined
  onPlaying: (playing: boolean) => void = () => undefined
  onError: (message: string) => void = () => undefined

  constructor() {
    this.context = new AudioContext()
  }
  unlock(): void { void this.context.resume().catch(() => undefined) }
  attachVideo(video: HTMLVideoElement | null): void { this.video = video }

  async load(song: LanSong, base: URL, pitch: number, signal: AbortSignal): Promise<void> {
    this.clear()
    const generation = this.generation
    this.duration = song.durationMs / 1000
    try {
      await Promise.all(song.stems.filter((stem) => stem.defaultVisible).map(async (stem) => {
        const element = new Audio()
        element.preload = 'auto'
        element.addEventListener('error', () => { if (this.playing) this.playbackError() })
        const source = this.context.createMediaElementSource(element)
        const gain = this.context.createGain()
        source.connect(gain).connect(this.context.destination)
        const track: Track = { element, source, gain, state: { gain: 1, muted: false, solo: false } }
        this.tracks.push(track)
        const url = new URL(stem.audio.url, base)
        url.searchParams.set('web', '1'); url.searchParams.set('pitch', String(pitch))
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => { clearTimeout(timeout); element.removeEventListener('canplay', ready); element.removeEventListener('error', failed); signal.removeEventListener('abort', aborted) }
          const ready = (): void => { cleanup(); resolve() }
          const failed = (): void => { cleanup(); reject(new Error('音轨加载失败，请检查电脑端连接或重新开启局域网模式')) }
          const aborted = (): void => { cleanup(); reject(new DOMException('Aborted', 'AbortError')) }
          // Pitch/video generation may take time on older desktop CPUs.
          const timeout = window.setTimeout(failed, 10 * 60_000)
          element.addEventListener('canplay', ready, { once: true })
          element.addEventListener('error', failed, { once: true })
          signal.addEventListener('abort', aborted, { once: true })
          element.src = url.href
          element.load()
          if (signal.aborted) aborted()
        })
        if (generation !== this.generation || signal.aborted) throw new DOMException('Aborted', 'AbortError')
      }))
    } catch (error) {
      if (generation === this.generation) this.clear()
      throw error
    }
  }

  async play(): Promise<void> {
    if (!this.tracks.length) return
    // Call every play synchronously within the user's gesture (Safari/iOS).
    const resumed = this.context.resume()
    const generation = this.generation
    if (this.position >= this.duration - 0.05) this.seek(this.loop?.start ?? 0)
    if (this.loop && (this.position < this.loop.start || this.position >= this.loop.end)) this.seek(this.loop.start)
    const promises = this.tracks.map(({ element }) => element.play())
    if (this.video) { this.video.currentTime = this.position; promises.push(this.video.play()) }
    try {
      await Promise.all([resumed, ...promises])
      if (generation !== this.generation) return
      this.playing = true; this.onPlaying(true)
      this.timer ??= window.setInterval(() => this.tick(), 20)
    } catch (error) { if (generation !== this.generation) return; this.pause(); throw error }
  }

  pause(): void {
    this.generation += 1
    this.playing = false
    this.tracks.forEach(({ element }) => element.pause())
    this.video?.pause()
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.onPlaying(false)
  }
  seek(seconds: number): void {
    this.position = Math.max(0, Math.min(this.duration, seconds))
    for (const { element } of this.tracks) element.currentTime = this.position
    if (this.video) this.video.currentTime = this.position
    this.onTime(this.position)
  }
  setLoop(loop: { start: number; end: number } | null): void { this.loop = loop }
  mix(states: MixState[]): void {
    const solo = states.some((state) => state.solo && !state.muted)
    this.tracks.forEach((track, index) => {
      const state = states[index]
      if (!state) return
      track.state = state
      const value = !state.muted && (!solo || state.solo) ? state.gain : 0
      track.gain.gain.setTargetAtTime(value, this.context.currentTime, 0.015)
    })
  }
  private tick(): void {
    const anchor = this.tracks[0]?.element
    if (!anchor || !this.playing) return
    // Freeze the group if any stream runs out, preventing tracks racing ahead.
    if (this.tracks.some(({ element }) => element.readyState < 3 && !element.ended)) {
      this.tracks.forEach(({ element }) => element.pause()); this.video?.pause()
      return
    }
    if (this.loop && (anchor.currentTime >= this.loop.end || anchor.ended)) {
      this.seek(this.loop.start)
      for (const { element } of this.tracks) void element.play().catch(() => this.playbackError())
      if (this.video) void this.video.play().catch(() => this.playbackError())
      return
    }
    if (anchor.ended || anchor.currentTime >= this.duration) { this.pause(); this.seek(0); return }
    for (const { element } of this.tracks) {
      if (Math.abs(element.currentTime - anchor.currentTime) > 0.04) element.currentTime = anchor.currentTime
      if (element.paused) void element.play().catch(() => this.playbackError())
    }
    if (this.video) {
      if (Math.abs(this.video.currentTime - anchor.currentTime) > 0.1) this.video.currentTime = anchor.currentTime
      if (this.video.paused && !this.video.ended) void this.video.play().catch(() => this.playbackError())
    }
    this.position = anchor.currentTime
    this.onTime(this.position)
  }
  private playbackError(): void { this.pause(); this.onError('播放中断，请检查连接后点击播放重试') }
  clear(): void {
    this.pause(); this.loop = null; this.video = null; this.position = 0
    for (const { element, source, gain } of this.tracks) {
      element.removeAttribute('src'); element.load(); source.disconnect(); gain.disconnect()
    }
    this.tracks = []
  }
  dispose(): void { this.clear(); void this.context.close() }
}

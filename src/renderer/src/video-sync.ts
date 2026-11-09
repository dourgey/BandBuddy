export interface VideoPlaybackState {
  currentMs: number
  playing: boolean
  playbackRate: number
  seekPositionMs: number
  outputLatencyMs: number
}

/** The stem clock owns transport; the muted picture only follows it. */
export class VideoSynchronizer {
  private state: VideoPlaybackState | null = null
  private pendingPlay = false
  private playGeneration = 0
  private failed = false
  private disposed = false

  constructor(private readonly video: HTMLVideoElement, private readonly onError: () => void) {
    video.muted = true
    video.addEventListener('loadedmetadata', this.ready)
    video.addEventListener('canplay', this.ready)
    video.addEventListener('error', this.mediaError)
    video.addEventListener('loadstart', this.resetFailed)
  }

  update(state: VideoPlaybackState): void {
    const previous = this.state
    this.state = state
    const force = !previous || previous.playing !== state.playing
      || previous.playbackRate !== state.playbackRate
      || previous.seekPositionMs !== state.seekPositionMs
      || previous.outputLatencyMs !== state.outputLatencyMs
      || state.currentMs < previous.currentMs - 1
    this.synchronize(force)
  }

  retry(): void {
    this.failed = false
    this.playGeneration += 1
    this.pendingPlay = false
    this.video.load()
  }

  dispose(): void {
    this.disposed = true
    this.playGeneration += 1
    this.video.pause()
    this.video.removeEventListener('loadedmetadata', this.ready)
    this.video.removeEventListener('canplay', this.ready)
    this.video.removeEventListener('error', this.mediaError)
    this.video.removeEventListener('loadstart', this.resetFailed)
    this.video.removeAttribute('src')
    this.video.load()
  }

  private resetFailed = (): void => {
    this.failed = false
  }

  private ready = (): void => { this.synchronize(true) }
  private mediaError = (): void => {
    if (this.disposed) return
    this.failed = true
    this.onError()
  }

  private synchronize(force: boolean): void {
    const state = this.state
    if (!state || this.disposed || this.failed) return
    const video = this.video
    video.muted = true
    video.playbackRate = state.playbackRate
    if (!state.playing && (!video.paused || this.pendingPlay)) {
      this.playGeneration += 1
      this.pendingPlay = false
      video.pause()
    }
    if (video.readyState < 1) return
    const duration = Number.isFinite(video.duration) ? video.duration : Infinity
    const latency = state.playing ? state.outputLatencyMs * state.playbackRate : 0
    const target = Math.max(0, Math.min((state.currentMs - latency) / 1000, duration))
    const tolerance = state.playing ? 0.1 : 0.015
    if ((force && Math.abs(video.currentTime - target) > 0.001) || Math.abs(video.currentTime - target) > tolerance) {
      video.currentTime = target
    }
    // A shorter video holds its final frame while the stems finish. A later
    // loop/seek starts it again; it must never end the audio transport itself.
    if (!state.playing || target >= duration - 0.015) return
    if (video.paused && !this.pendingPlay) {
      const generation = ++this.playGeneration
      this.pendingPlay = true
      void video.play().catch((error: unknown) => {
        if (generation !== this.playGeneration || this.disposed) return
        if (!(error instanceof Error) || error.name !== 'AbortError') this.mediaError()
      }).finally(() => {
        if (generation === this.playGeneration) this.pendingPlay = false
      })
    }
  }
}

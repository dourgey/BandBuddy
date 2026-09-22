import {
  dbToGain,
  type SongDetail
} from '@shared/domain.js'
import {
  rehearsalTimelinePosition,
  type RehearsalRecordingTake,
  type RehearsalRecordingTrackState,
  type RehearsalTimeline,
  type RehearsalTimelinePosition
} from '@shared/rehearsal.js'
import { MultiTrackAudioEngine } from './audio-engine.js'

interface RehearsalPlaybackConfiguration {
  timeline: RehearsalTimeline
  songs: SongDetail[]
  recordingTracks: RehearsalRecordingTrackState[]
  recordingTakes: RehearsalRecordingTake[]
  outputDeviceId: string
  latencyMode: AudioContextLatencyCategory
}

interface OverlayAudio {
  element: HTMLAudioElement
  source: MediaElementAudioSourceNode
  gain: GainNode
}

export class RehearsalAudioEngine {
  private readonly songEngine = new MultiTrackAudioEngine()
  private configuration: RehearsalPlaybackConfiguration | null = null
  private songs = new Map<string, SongDetail>()
  private currentMs = 0
  private playing = false
  private preparation: Promise<boolean> | null = null
  private currentSegmentId: string | null = null
  private frame = 0
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null
  private visualActive = true
  private lastTimeEmission = -Infinity
  private clockStartedAt = 0
  private clockPositionMs = 0
  private timeListener: ((position: RehearsalTimelinePosition, playing: boolean) => void) | null = null
  private endedListener: (() => void) | null = null
  private errorListener: ((error: unknown) => void) | null = null
  private overlayContext: AudioContext | null = null
  private overlayMaster: GainNode | null = null
  private overlayDelay: DelayNode | null = null
  private overlayMasterConnected = false
  private overlays = new Map<string, OverlayAudio>()
  private clickContext: AudioContext | null = null
  private lastCountInBeat = -1
  private generation = 0
  private preloadedSongId: string | null = null
  private preloads: HTMLAudioElement[] = []

  constructor() {
    this.songEngine.onTime(() => undefined)
    this.songEngine.onEnded(() => void this.finishCurrentSegment())
    this.songEngine.onError?.((error) => this.errorListener?.(error))
  }

  onTime(listener: (position: RehearsalTimelinePosition, playing: boolean) => void): void {
    this.timeListener = listener
  }

  onEnded(listener: () => void): void {
    this.endedListener = listener
  }

  onError(listener: (error: unknown) => void): void {
    this.errorListener = listener
  }

  setVisualActive(active: boolean): void {
    if (this.visualActive === active) return
    this.visualActive = active
    this.cancelMonitor()
    // Segment changes and count-in clicks share this clock. Keep advancing it
    // even when the page has no animation frames to render.
    if (this.playing) this.monitorTick()
    else if (active) this.emitTime()
  }

  async configure(configuration: RehearsalPlaybackConfiguration): Promise<void> {
    this.pause()
    this.configuration = configuration
    this.songs = new Map(configuration.songs.map((song) => [song.id, song]))
    this.currentMs = Math.min(this.currentMs, configuration.timeline.totalDurationMs)
    this.currentSegmentId = null
    this.clearPreloads()
    await this.configureOverlays(configuration)
    this.emitTime()
  }

  get positionMs(): number { return this.currentMs }
  get isPlaying(): boolean { return this.playing }

  async play(): Promise<boolean> {
    const configuration = this.configuration
    if (!configuration || !configuration.timeline.segments.length) return false
    const generation = ++this.generation
    if (this.currentMs >= configuration.timeline.totalDurationMs) this.currentMs = 0
    const prepared = await this.prepareCurrentSegment(generation)
    if (!prepared || generation !== this.generation) return false
    this.playing = true
    this.clockPositionMs = this.currentMs
    this.clockStartedAt = performance.now()
    this.playOverlays()
    this.monitor()
    this.emitTime()
    return true
  }

  pause(): void {
    this.generation += 1
    if (this.playing) this.currentMs = this.clockPositionMs + (performance.now() - this.clockStartedAt)
    const total = this.configuration?.timeline.totalDurationMs ?? this.currentMs
    this.currentMs = Math.max(0, Math.min(this.currentMs, total))
    this.playing = false
    this.cancelMonitor()
    this.songEngine.pause()
    for (const overlay of this.overlays.values()) overlay.element.pause()
    this.emitTime()
  }

  async seek(positionMs: number): Promise<void> {
    const wasPlaying = this.playing
    this.pause()
    const total = this.configuration?.timeline.totalDurationMs ?? positionMs
    this.currentMs = Math.max(0, Math.min(positionMs, total))
    this.currentSegmentId = null
    this.seekOverlays()
    this.emitTime()
    if (wasPlaying) await this.play()
  }

  async stop(): Promise<void> {
    this.pause()
    this.currentMs = 0
    this.currentSegmentId = null
    this.seekOverlays()
    this.emitTime()
  }

  previousItemStart(): number {
    const timeline = this.configuration?.timeline
    if (!timeline) return 0
    const current = rehearsalTimelinePosition(timeline, this.currentMs)
    const itemStarts = uniqueItemStarts(timeline)
    const currentStart = current.segment?.startMs ?? this.currentMs
    const earlier = itemStarts.filter((value) => value < currentStart - 10)
    return earlier.at(-1) ?? 0
  }

  nextItemStart(): number {
    const timeline = this.configuration?.timeline
    if (!timeline) return 0
    const itemStarts = uniqueItemStarts(timeline)
    return itemStarts.find((value) => value > this.currentMs + 10) ?? timeline.totalDurationMs
  }

  destroy(): void {
    this.pause()
    this.songEngine.destroy()
    for (const overlay of this.overlays.values()) {
      overlay.element.pause()
      overlay.element.removeAttribute('src')
      overlay.element.load()
      overlay.source.disconnect()
      overlay.gain.disconnect()
    }
    this.overlays.clear()
    this.clearPreloads()
    void this.overlayContext?.close()
    void this.clickContext?.close()
    this.overlayContext = null
    this.overlayMaster = null
    this.overlayDelay = null
    this.overlayMasterConnected = false
    this.clickContext = null
  }

  private async prepareCurrentSegment(generation: number): Promise<boolean> {
    while (this.preparation) {
      await this.preparation
      if (generation !== this.generation) return false
    }
    const preparation = this.loadCurrentSegment(generation)
    this.preparation = preparation
    try {
      return await preparation
    } finally {
      if (this.preparation === preparation) this.preparation = null
    }
  }

  private async loadCurrentSegment(generation: number): Promise<boolean> {
    const configuration = this.configuration
    if (!configuration || generation !== this.generation) return false
    const position = rehearsalTimelinePosition(configuration.timeline, this.currentMs)
    const segment = position.segment
    if (!segment) return false
    if (segment.id === this.currentSegmentId) {
      if (segment.kind !== 'song') return true
      this.songEngine.seek(position.songSourceMs)
      return this.songEngine.play(0)
    }
    this.songEngine.pause()
    this.lastCountInBeat = -1
    if (segment.kind !== 'song' || !segment.songId) {
      this.setOverlayDelay(0)
      this.currentSegmentId = segment.id
      this.preloadNextSong(segment.endMs)
      return true
    }
    this.currentSegmentId = null
    const source = this.songs.get(segment.songId)
    if (!source) throw new Error('REHEARSAL_SONG_UNAVAILABLE')
    const hasRehearsalSolo = configuration.recordingTracks.some((track) => {
      const take = configuration.recordingTakes.find((candidate) => candidate.id === track.activeTakeId)
      return Boolean(take && take.timelineFingerprint === configuration.timeline.fingerprint && track.solo && !track.muted)
    })
    const song: SongDetail = {
      ...source,
      practice: {
        ...source.practice,
        positionMs: position.songSourceMs,
        loopEnabled: false,
        loopStartMs: null,
        loopEndMs: null,
        masterGainDb: hasRehearsalSolo ? -60 : source.practice.masterGainDb
      }
    }
    await this.songEngine.load(song, configuration.outputDeviceId, configuration.latencyMode)
    if (generation !== this.generation) return false
    this.setOverlayDelay(this.songEngine.outputLatencySeconds)
    const latest = rehearsalTimelinePosition(configuration.timeline, this.currentMs)
    this.songEngine.seek(latest.segment?.id === segment.id ? latest.songSourceMs : position.songSourceMs)
    this.currentSegmentId = segment.id
    const started = await this.songEngine.play(0)
    if (!started) return false
    this.preloadNextSong(segment.endMs)
    return true
  }

  private monitor(): void {
    this.cancelMonitor()
    this.scheduleMonitorTick()
  }

  private cancelMonitor(): void {
    cancelAnimationFrame(this.frame)
    this.frame = 0
    if (this.backgroundTimer !== null) clearTimeout(this.backgroundTimer)
    this.backgroundTimer = null
  }

  private scheduleMonitorTick(): void {
    this.cancelMonitor()
    if (!this.playing) return
    if (this.visualActive) this.frame = requestAnimationFrame(this.monitorTick)
    else this.backgroundTimer = setTimeout(this.monitorTick, 16)
  }

  private monitorTick = (): void => {
    this.frame = 0
    this.backgroundTimer = null
    if (!this.playing || !this.configuration) return
    const timeline = this.configuration.timeline
    const nextMs = this.clockPositionMs + (performance.now() - this.clockStartedAt)
    if (nextMs >= timeline.totalDurationMs) {
      this.currentMs = timeline.totalDurationMs
      this.playing = false
      this.songEngine.pause()
      for (const overlay of this.overlays.values()) overlay.element.pause()
      this.emitTime()
      this.endedListener?.()
      return
    }
    const previous = rehearsalTimelinePosition(timeline, this.currentMs)
    this.currentMs = nextMs
    const current = rehearsalTimelinePosition(timeline, this.currentMs)
    if (current.segment?.id !== previous.segment?.id) {
      this.clockPositionMs = this.currentMs
      this.clockStartedAt = performance.now()
      void this.prepareCurrentSegment(this.generation).then((prepared) => {
        if (!prepared || !this.playing) return
        this.clockPositionMs = this.currentMs
        this.clockStartedAt = performance.now()
      })
    } else if (current.segment?.kind === 'countIn') {
      this.maybeClickCountIn(current)
    }
    this.emitTime(false)
    this.scheduleMonitorTick()
  }

  private async finishCurrentSegment(): Promise<void> {
    if (!this.playing || !this.configuration) return
    const position = rehearsalTimelinePosition(this.configuration.timeline, this.currentMs)
    if (position.segment?.kind !== 'song') return
    this.currentMs = position.segment.endMs
    this.clockPositionMs = this.currentMs
    this.clockStartedAt = performance.now()
    this.currentSegmentId = null
    await this.prepareCurrentSegment(this.generation)
  }

  private maybeClickCountIn(position: RehearsalTimelinePosition): void {
    const segment = position.segment
    if (!segment || segment.kind !== 'countIn') return
    const beatDurationMs = 60_000 / segment.metronomeBpm / segment.playbackRate
    const beat = Math.floor(position.segmentMs / beatDurationMs)
    if (beat === this.lastCountInBeat) return
    this.lastCountInBeat = beat
    this.click(beat % 4 === 0)
  }

  private click(accent: boolean): void {
    this.clickContext ??= new AudioContext({ latencyHint: 'interactive' })
    const context = this.clickContext
    if (context.state === 'suspended') void context.resume()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = accent ? 1560 : 1080
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.22, context.currentTime + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.045)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.05)
  }

  private async configureOverlays(configuration: RehearsalPlaybackConfiguration): Promise<void> {
    for (const overlay of this.overlays.values()) {
      overlay.element.pause()
      overlay.source.disconnect()
      overlay.gain.disconnect()
    }
    this.overlays.clear()
    this.overlayContext ??= new AudioContext({ latencyHint: configuration.latencyMode })
    this.overlayMaster ??= this.overlayContext.createGain()
    this.overlayDelay ??= typeof this.overlayContext.createDelay === 'function'
      ? this.overlayContext.createDelay(2)
      : null
    try {
      const selector = this.overlayContext as AudioContext & { setSinkId?: (deviceId: string) => Promise<void> }
      if (selector.setSinkId) await selector.setSinkId(configuration.outputDeviceId)
    } catch {
      // The song engine reports device selection failures; keep overlays on the default output.
    }
    if (!this.overlayMasterConnected) {
      if (this.overlayDelay) this.overlayMaster.connect(this.overlayDelay).connect(this.overlayContext.destination)
      else this.overlayMaster.connect(this.overlayContext.destination)
      this.overlayMasterConnected = true
    }
    const matching = configuration.recordingTracks.flatMap((track) => {
      const take = configuration.recordingTakes.find((candidate) => candidate.id === track.activeTakeId)
      return take && take.timelineFingerprint === configuration.timeline.fingerprint ? [{ track, take }] : []
    })
    const hasSolo = matching.some(({ track }) => track.solo && !track.muted)
    for (const { track, take } of matching) {
      const element = new Audio()
      element.preload = 'auto'
      element.crossOrigin = 'anonymous'
      element.preservesPitch = true
      element.src = take.previewMediaUrl
      const source = this.overlayContext.createMediaElementSource(element)
      const gain = this.overlayContext.createGain()
      gain.gain.value = !track.muted && (!hasSolo || track.solo) ? dbToGain(track.gainDb) : 0
      source.connect(gain).connect(this.overlayMaster)
      this.overlays.set(track.id, { element, source, gain })
    }
    this.seekOverlays()
  }

  private seekOverlays(): void {
    for (const overlay of this.overlays.values()) {
      try { overlay.element.currentTime = this.currentMs / 1000 } catch { /* media metadata is still loading */ }
    }
  }

  private setOverlayDelay(seconds: number): void {
    if (!this.overlayContext || !this.overlayDelay) return
    const value = Number.isFinite(seconds) ? Math.max(0, Math.min(1.99, seconds)) : 0
    const now = this.overlayContext.currentTime
    this.overlayDelay.delayTime.cancelScheduledValues(now)
    this.overlayDelay.delayTime.setValueAtTime(value, now)
  }

  private playOverlays(): void {
    this.seekOverlays()
    if (this.overlayContext?.state === 'suspended') void this.overlayContext.resume()
    for (const overlay of this.overlays.values()) void overlay.element.play().catch(() => undefined)
  }

  private emitTime(force = true): void {
    if (!this.configuration) return
    const now = performance.now()
    if (!force && !this.visualActive && this.playing && now - this.lastTimeEmission < 80) return
    this.lastTimeEmission = now
    this.timeListener?.(
      rehearsalTimelinePosition(this.configuration.timeline, this.currentMs),
      this.playing
    )
  }

  private preloadNextSong(afterMs: number): void {
    const configuration = this.configuration
    if (!configuration) return
    const segment = configuration.timeline.segments.find((candidate) => {
      return candidate.kind === 'song' && candidate.songId && candidate.startMs >= afterMs - 1
    })
    if (!segment?.songId || segment.songId === this.preloadedSongId) return
    const song = this.songs.get(segment.songId)
    if (!song) return
    this.clearPreloads()
    const urls = [
      ...song.stems.map((stem) => stem.mediaUrl),
      ...song.recordingTracks.flatMap((track) => {
        const take = song.recordingTakes.find((candidate) => candidate.id === track.activeTakeId)
        return take && Math.abs(take.playbackRate - song.practice.playbackRate) < 0.0001
          && (take.pitchSemitones ?? 0) === (song.practice.pitchSemitones ?? 0)
          ? [take.previewMediaUrl]
          : []
      })
    ]
    this.preloadedSongId = song.id
    this.preloads = urls.map((url) => {
      const element = new Audio()
      element.preload = 'auto'
      element.crossOrigin = 'anonymous'
      element.src = url
      element.load()
      return element
    })
  }

  private clearPreloads(): void {
    for (const element of this.preloads) {
      element.removeAttribute('src')
      element.load()
    }
    this.preloads = []
    this.preloadedSongId = null
  }
}

function uniqueItemStarts(timeline: RehearsalTimeline): number[] {
  const seen = new Set<string>()
  return timeline.segments.flatMap((segment) => {
    if (seen.has(segment.itemId)) return []
    seen.add(segment.itemId)
    return [segment.startMs]
  })
}

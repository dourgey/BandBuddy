import { STEM_ORDER, dbToGain, type PracticeState, type RecordingTake, type SongDetail, type StemType } from '@shared/domain.js'

export interface NextMetronomeBeat {
  beatIndex: number
  delaySeconds: number
  intervalSeconds: number
}

export const TAKE_PREVIEW_PLAYBACK_RATE = 1

export function takePreviewTimeSeconds(songPositionMs: number, recordedPlaybackRate: number): number {
  return songPositionMs / recordedPlaybackRate / 1000
}

export function nextMetronomeBeat(
  songPositionMs: number,
  bpm: number,
  beatOffsetMs: number,
  playbackRate: number,
  minimumLeadSeconds = 0.02
): NextMetronomeBeat | null {
  if (![songPositionMs, bpm, beatOffsetMs, playbackRate].every(Number.isFinite) || bpm <= 0 || playbackRate <= 0) return null
  const beatDurationMs = 60_000 / bpm
  let beatIndex = Math.ceil((songPositionMs - beatOffsetMs) / beatDurationMs - 1e-9)
  let delaySeconds = (beatOffsetMs + beatIndex * beatDurationMs - songPositionMs) / (playbackRate * 1000)
  while (delaySeconds < minimumLeadSeconds) {
    beatIndex += 1
    delaySeconds += beatDurationMs / (playbackRate * 1000)
  }
  return { beatIndex, delaySeconds, intervalSeconds: beatDurationMs / (playbackRate * 1000) }
}

interface TrackAudio {
  element: HTMLAudioElement
  source: MediaElementAudioSourceNode
  gain: GainNode
}

interface RecordingTrackAudio extends TrackAudio {
  take: RecordingTake
}

interface AudioContextSinkSelector {
  setSinkId?: (deviceId: string) => Promise<void>
}

/**
 * Select the output for the whole Web Audio graph.  Every stem and the
 * metronome are connected to the AudioContext, so changing an individual
 * HTMLAudioElement sink leaves the actual mix on the context's default sink.
 */
export async function setAudioContextOutputDevice(
  context: object | null,
  deviceId: string
): Promise<void> {
  if (!context) return
  const sinkSelector = context as AudioContextSinkSelector
  if (typeof sinkSelector.setSinkId !== 'function') {
    if (deviceId) throw new Error('AUDIO_OUTPUT_DEVICE_SELECTION_UNSUPPORTED')
    return
  }
  await sinkSelector.setSinkId(deviceId)
}

export class MultiTrackAudioEngine {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private compressor: DynamicsCompressorNode | null = null
  private tracks = new Map<StemType, TrackAudio>()
  private recordings = new Map<string, RecordingTrackAudio>()
  private song: SongDetail | null = null
  private practice: PracticeState | null = null
  private frame = 0
  private timeListener: ((milliseconds: number) => void) | null = null
  private endedListener: (() => void) | null = null
  private playbackGeneration = 0
  private countInTimer: number | null = null
  private countInResolve: (() => void) | null = null
  private countInListener: ((remaining: number) => void) | null = null
  private metronomeTimer: number | null = null
  private metronomeNodes = new Set<OscillatorNode>()
  private nextMetronomeTime = 0
  private metronomeBeat = 0

  onTime(callback: (milliseconds: number) => void): void { this.timeListener = callback }
  onEnded(callback: () => void): void { this.endedListener = callback }

  async load(song: SongDetail, outputDeviceId = '', latencyMode: AudioContextLatencyCategory = 'balanced'): Promise<void> {
    this.pause()
    this.destroyTracks()
    this.song = song
    this.practice = song.practice
    await this.ensureContext(latencyMode)
    await this.setOutputDevice(outputDeviceId)
    const stemByType = new Map(song.stems.map((stem) => [stem.type, stem]))
    for (const type of STEM_ORDER) {
      const element = new Audio()
      element.preload = 'auto'
      // MediaElementAudioSourceNode requires an explicitly CORS-enabled media
      // element. Without this Chromium deliberately outputs silence.
      element.crossOrigin = 'anonymous'
      element.preservesPitch = true
      ;(element as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true
      const stem = stemByType.get(type)
      if (stem) element.src = stem.mediaUrl
      element.playbackRate = song.practice.playbackRate
      element.currentTime = song.practice.positionMs / 1000
      const source = this.context!.createMediaElementSource(element)
      const gain = this.context!.createGain()
      source.connect(gain).connect(this.master!)
      this.tracks.set(type, { element, source, gain })
    }
    for (const recordingTrack of song.recordingTracks) {
      const take = song.recordingTakes.find((candidate) => candidate.id === recordingTrack.activeTakeId)
      if (!take) continue
      const element = new Audio()
      element.preload = 'auto'
      element.crossOrigin = 'anonymous'
      element.preservesPitch = true
      element.src = take.previewMediaUrl
      // The preview is already laid out in recording (wall-clock) time. A take
      // captured at 0.5x is therefore twice as long as the song timeline and
      // must advance at 1x while stems advance at 0.5x.
      element.playbackRate = TAKE_PREVIEW_PLAYBACK_RATE
      element.currentTime = takePreviewTimeSeconds(song.practice.positionMs, take.playbackRate)
      const source = this.context!.createMediaElementSource(element)
      const gain = this.context!.createGain()
      source.connect(gain).connect(this.master!)
      this.recordings.set(recordingTrack.id, { element, source, gain, take })
    }
    this.applyPractice(song.practice, true)
  }

  async play(countInBeats: 0 | 4 | 8 = 0, onCountIn?: (remaining: number) => void): Promise<boolean> {
    if (!this.song || !this.practice) return false
    const generation = ++this.playbackGeneration
    await this.ensureContext()
    if (this.context!.state === 'suspended') await this.context!.resume()
    if (generation !== this.playbackGeneration) return false
    this.stopMetronome()
    if (countInBeats > 0) {
      this.countInListener = onCountIn ?? null
      const beatDurationMs = 60_000 / this.practice.metronomeBpm / this.practice.playbackRate
      for (let beat = 0; beat < countInBeats; beat += 1) {
        if (generation !== this.playbackGeneration) return false
        this.countInListener?.(countInBeats - beat)
        this.scheduleMetronomeClick(this.context!.currentTime + 0.01, beat % 4 === 0)
        await this.waitForCountInBeat(beatDurationMs)
      }
      this.countInListener?.(0)
      this.countInListener = null
      if (generation !== this.playbackGeneration) return false
    }
    const active = [...this.tracks.values()].filter(({ element }) => Boolean(element.src))
    const anchor = this.anchor()
    if (!anchor) throw new Error('AUDIO_SOURCE_MISSING')
    const time = anchor.currentTime
    for (const { element } of active) if (Math.abs(element.currentTime - time) > 0.01) element.currentTime = time
    for (const recording of this.recordings.values()) {
      if (!this.takeMatchesRate(recording.take)) continue
      recording.element.currentTime = takePreviewTimeSeconds(time * 1000, recording.take.playbackRate)
      active.push(recording)
    }
    const results = await Promise.allSettled(active.map(({ element }) => element.play()))
    if (generation !== this.playbackGeneration) {
      for (const { element } of active) element.pause()
      return false
    }
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length === results.length) throw new Error('AUDIO_PLAYBACK_FAILED')
    if (failures.length > 0) {
      for (let index = 0; index < results.length; index += 1) {
        if (results[index]?.status === 'rejected') {
          active[index]?.element.pause()
          active[index]?.element.removeAttribute('src')
        }
      }
    }
    if (this.practice.metronomeEnabled) this.startMetronome()
    this.monitor()
    return true
  }

  pause(): void {
    this.playbackGeneration += 1
    cancelAnimationFrame(this.frame)
    this.finishCountInWait()
    this.countInListener?.(0)
    this.countInListener = null
    this.stopMetronome()
    for (const { element } of this.tracks.values()) element.pause()
    for (const { element } of this.recordings.values()) element.pause()
  }

  seek(milliseconds: number): void {
    const seconds = Math.max(0, Math.min(milliseconds, this.song?.durationMs ?? milliseconds) / 1000)
    const mediaPlaying = Boolean(this.anchor() && !this.anchor()!.paused)
    for (const { element } of this.tracks.values()) if (element.src) element.currentTime = seconds
    for (const recording of this.recordings.values()) {
      recording.element.currentTime = takePreviewTimeSeconds(seconds * 1000, recording.take.playbackRate)
    }
    if (mediaPlaying && this.practice?.metronomeEnabled) this.startMetronome()
    this.timeListener?.(seconds * 1000)
  }

  applyPractice(practice: PracticeState, immediate = false): void {
    const metronomeChanged = this.practice?.metronomeEnabled !== practice.metronomeEnabled
      || this.practice?.metronomeBpm !== practice.metronomeBpm
      || this.practice?.metronomeOffsetMs !== practice.metronomeOffsetMs
      || this.practice?.playbackRate !== practice.playbackRate
    const mediaPlaying = Boolean(this.anchor() && !this.anchor()!.paused)
    this.practice = practice
    const now = this.context?.currentTime ?? 0
    const ramp = immediate ? 0 : 0.035
    if (this.master) {
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setValueAtTime(this.master.gain.value, now)
      this.master.gain.linearRampToValueAtTime(dbToGain(practice.masterGainDb), now + ramp)
    }
    const recordingStates = this.song?.recordingTracks ?? []
    const hasSolo = practice.tracks.some((state) => state.solo && !state.muted)
      || recordingStates.some((state) => this.recordings.has(state.id) && state.solo && !state.muted)
    for (const state of practice.tracks) {
      const track = this.tracks.get(state.stemType)
      if (!track) continue
      const gain = !state.muted && (!hasSolo || state.solo) ? dbToGain(state.gainDb) : 0
      track.gain.gain.cancelScheduledValues(now)
      track.gain.gain.setValueAtTime(track.gain.gain.value, now)
      track.gain.gain.linearRampToValueAtTime(gain, now + ramp)
      track.element.playbackRate = practice.playbackRate
      track.element.preservesPitch = true
    }
    for (const recordingState of recordingStates) {
      const recording = this.recordings.get(recordingState.id)
      if (!recording) continue
      const matchesRate = this.takeMatchesRate(recording.take)
      const audible = !recordingState.muted && (!hasSolo || recordingState.solo) && matchesRate
      recording.gain.gain.cancelScheduledValues(now)
      recording.gain.gain.setValueAtTime(recording.gain.gain.value, now)
      recording.gain.gain.linearRampToValueAtTime(audible ? dbToGain(recordingState.gainDb) : 0, now + ramp)
      recording.element.playbackRate = TAKE_PREVIEW_PLAYBACK_RATE
      recording.element.preservesPitch = true
      if (!matchesRate) recording.element.pause()
      else if (mediaPlaying && recording.element.paused) {
        const anchor = this.anchor()
        if (anchor) {
          recording.element.currentTime = takePreviewTimeSeconds(anchor.currentTime * 1000, recording.take.playbackRate)
          void recording.element.play().catch(() => undefined)
        }
      }
    }
    if (metronomeChanged && mediaPlaying) {
      if (practice.metronomeEnabled) this.startMetronome()
      else this.stopMetronome()
    }
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    await setAudioContextOutputDevice(this.context, deviceId)
  }

  private async ensureContext(latencyHint: AudioContextLatencyCategory = 'balanced'): Promise<void> {
    if (this.context) return
    this.context = new AudioContext({ latencyHint })
    this.master = this.context.createGain()
    this.compressor = this.context.createDynamicsCompressor()
    this.compressor.threshold.value = -1
    this.compressor.knee.value = 0
    this.compressor.ratio.value = 20
    this.compressor.attack.value = 0.003
    this.compressor.release.value = 0.08
    this.master.connect(this.compressor).connect(this.context.destination)
  }

  private anchor(): HTMLAudioElement | null {
    for (const type of STEM_ORDER) {
      const element = this.tracks.get(type)?.element
      if (element?.src) return element
    }
    return null
  }

  private waitForCountInBeat(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.countInResolve = resolve
      this.countInTimer = window.setTimeout(() => {
        this.countInTimer = null
        this.countInResolve = null
        resolve()
      }, milliseconds)
    })
  }

  private finishCountInWait(): void {
    if (this.countInTimer !== null) window.clearTimeout(this.countInTimer)
    this.countInTimer = null
    const resolve = this.countInResolve
    this.countInResolve = null
    resolve?.()
  }

  private startMetronome(): void {
    if (!this.context || !this.master || !this.practice) return
    const anchor = this.anchor()
    if (!anchor) return
    this.stopMetronome()
    const nextBeat = nextMetronomeBeat(
      anchor.currentTime * 1000,
      this.practice.metronomeBpm,
      this.practice.metronomeOffsetMs,
      this.practice.playbackRate
    )
    if (!nextBeat) return
    this.nextMetronomeTime = this.context.currentTime + nextBeat.delaySeconds
    this.metronomeBeat = nextBeat.beatIndex
    const schedule = (): void => {
      if (!this.context) return
      while (this.nextMetronomeTime < this.context.currentTime + 0.12) {
        this.scheduleMetronomeClick(this.nextMetronomeTime, ((this.metronomeBeat % 4) + 4) % 4 === 0)
        this.nextMetronomeTime += nextBeat.intervalSeconds
        this.metronomeBeat += 1
      }
    }
    schedule()
    this.metronomeTimer = window.setInterval(schedule, 25)
  }

  private stopMetronome(): void {
    if (this.metronomeTimer !== null) window.clearInterval(this.metronomeTimer)
    this.metronomeTimer = null
    for (const oscillator of this.metronomeNodes) {
      try { oscillator.stop() } catch { /* The click may already have ended. */ }
      oscillator.disconnect()
    }
    this.metronomeNodes.clear()
  }

  private scheduleMetronomeClick(at: number, accented: boolean): void {
    if (!this.context || !this.master) return
    const oscillator = this.context.createOscillator()
    const gain = this.context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(accented ? 1560 : 1080, at)
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(accented ? 0.28 : 0.18, at + 0.003)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.055)
    oscillator.connect(gain).connect(this.master)
    oscillator.onended = () => {
      this.metronomeNodes.delete(oscillator)
      oscillator.disconnect()
      gain.disconnect()
    }
    this.metronomeNodes.add(oscillator)
    oscillator.start(at)
    oscillator.stop(at + 0.06)
  }

  private monitor = (): void => {
    const anchor = this.anchor()
    if (!anchor) return
    if (anchor.ended) {
      this.stopMetronome()
      this.endedListener?.()
      return
    }
    if (anchor.paused) return
    const practice = this.practice
    if (practice?.loopEnabled && practice.loopStartMs !== null && practice.loopEndMs !== null && anchor.currentTime * 1000 >= practice.loopEndMs) {
      this.seek(practice.loopStartMs)
    }
    const anchorTime = anchor.currentTime
    for (const { element } of this.tracks.values()) {
      if (!element.src || element === anchor || element.paused) continue
      const drift = element.currentTime - anchorTime
      if (Math.abs(drift) > 0.03) element.currentTime = anchorTime
      else if (Math.abs(drift) > 0.012) element.playbackRate = (practice?.playbackRate ?? 1) * (drift > 0 ? 0.985 : 1.015)
      else element.playbackRate = practice?.playbackRate ?? 1
    }
    for (const recording of this.recordings.values()) {
      if (!this.takeMatchesRate(recording.take) || recording.element.paused) continue
      const drift = recording.element.currentTime * recording.take.playbackRate - anchorTime
      if (Math.abs(drift) > 0.03) recording.element.currentTime = takePreviewTimeSeconds(anchorTime * 1000, recording.take.playbackRate)
      else if (Math.abs(drift) > 0.012) recording.element.playbackRate = TAKE_PREVIEW_PLAYBACK_RATE * (drift > 0 ? 0.985 : 1.015)
      else recording.element.playbackRate = TAKE_PREVIEW_PLAYBACK_RATE
    }
    this.timeListener?.(anchorTime * 1000)
    this.frame = requestAnimationFrame(this.monitor)
  }

  private destroyTracks(): void {
    cancelAnimationFrame(this.frame)
    for (const { element, source, gain } of this.tracks.values()) {
      element.pause()
      element.removeAttribute('src')
      element.load()
      source.disconnect()
      gain.disconnect()
    }
    this.tracks.clear()
    for (const recording of this.recordings.values()) {
      recording.element.pause()
      recording.element.removeAttribute('src')
      recording.element.load()
      recording.source.disconnect()
      recording.gain.disconnect()
    }
    this.recordings.clear()
  }

  private takeMatchesRate(take: RecordingTake): boolean {
    return Boolean(this.practice && Math.abs(take.playbackRate - this.practice.playbackRate) < 0.0001)
  }

  unload(): void {
    this.pause()
    this.destroyTracks()
    this.song = null
    this.practice = null
  }

  destroy(): void {
    this.pause()
    this.destroyTracks()
    void this.context?.close()
    this.context = null
  }
}

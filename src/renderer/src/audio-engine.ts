import {
  DEFAULT_OUTPUT_CHANNEL_PAIR,
  MAX_ROUTABLE_OUTPUT_CHANNELS,
  STEM_ORDER,
  dbToGain,
  isStemVisible,
  normalizePitchSemitones,
  type PracticeState,
  type RecordingTake,
  type SongDetail,
  type StemType
} from '@shared/domain.js'
import type { SignalsmithStretchNode } from 'signalsmith-stretch'
import type { BandBuddyApi } from '@shared/bridge.js'
import { activeLoopRange } from '@shared/playback.js'

const SIGNALSMITH_WORKLET_MODULE_URL = new URL(
  '../../../node_modules/signalsmith-stretch/SignalsmithStretch.mjs',
  import.meta.url
).href

const HARMONIC_STEMS = STEM_ORDER.filter((type) => type !== 'drums')
const HARMONIC_CHANNEL_COUNT = HARMONIC_STEMS.length * 2

export interface NextMetronomeBeat {
  beatIndex: number
  delaySeconds: number
  intervalSeconds: number
}

export const TAKE_PREVIEW_PLAYBACK_RATE = 1

export function recordingTakeMatchesPractice(take: RecordingTake, practice: PracticeState): boolean {
  return Math.abs(take.playbackRate - practice.playbackRate) < 0.0001
    && (take.pitchSemitones ?? 0) === (practice.pitchSemitones ?? 0)
}

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
  splitter: ChannelSplitterNode | null
}

interface RecordingTrackAudio extends TrackAudio {
  take: RecordingTake
}

interface AudioContextSinkSelector {
  setSinkId?: (deviceId: string | { type: 'none' }) => Promise<void>
}

interface AudioDestinationCapabilities {
  maxChannelCount?: number
  channelCount?: number
}

interface OutputConnection {
  source: AudioNode
  destination: AudioNode
  output: number
  input: number
}

export function routableOutputChannelCount(destination: object | null): number {
  const capabilities = destination as AudioDestinationCapabilities | null
  const reported = Number.isFinite(capabilities?.maxChannelCount)
    ? capabilities?.maxChannelCount
    : capabilities?.channelCount
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 2) return 2
  return Math.max(2, Math.min(MAX_ROUTABLE_OUTPUT_CHANNELS, Math.floor(reported / 2) * 2))
}

export function resolveOutputChannelPair(requested: number | undefined, outputChannelCount: number): number {
  const normalized = Number.isInteger(requested) ? requested as number : DEFAULT_OUTPUT_CHANNEL_PAIR
  return normalized >= 1 && normalized % 2 === 1 && normalized + 1 <= outputChannelCount
    ? normalized
    : DEFAULT_OUTPUT_CHANNEL_PAIR
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
  // Loopback can expose N hardware channels with every CoreAudio channel label
  // set to Unknown. Chromium interprets that layout as stereo. Prepare only
  // the selected device, before Chromium opens (or reopens) its output stream.
  const prepare = typeof window !== 'undefined'
    ? (window as unknown as { bandbuddy?: BandBuddyApi }).bandbuddy?.media?.prepareOutputDevice
    : undefined
  if (prepare && /Mac/i.test(navigator.platform)) {
    let deviceName: string | null = null
    if (deviceId && deviceId !== 'default') {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const selected = devices.find((device) => device.kind === 'audiooutput' && device.deviceId === deviceId)
      deviceName = selected?.label.replace(/ \(Virtual\)$/, '') ?? ''
    }
    if (deviceName !== '' && await prepare(deviceName)) {
      // setSinkId(sameId) is a no-op. A silent sink invalidates Chromium's old
      // layout without briefly sending the mix to the system speakers.
      await sinkSelector.setSinkId({ type: 'none' })
    }
  }
  await sinkSelector.setSinkId(deviceId)
}

export async function setAudioContextOutputDeviceOrDefault(
  context: object | null,
  deviceId: string
): Promise<string> {
  try {
    await setAudioContextOutputDevice(context, deviceId)
    return deviceId
  } catch (error) {
    if (!deviceId) throw error
    await setAudioContextOutputDevice(context, '')
    return ''
  }
}

export class MultiTrackAudioEngine {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private compressor: DynamicsCompressorNode | null = null
  private harmonicBus: ChannelMergerNode | null = null
  private dryDelay: DelayNode | null = null
  private dryGain: GainNode | null = null
  private wetGain: GainNode | null = null
  private harmonicOutput: GainNode | null = null
  private harmonicOutputSplitter: ChannelSplitterNode | null = null
  private bypassDelay: DelayNode | null = null
  private bypassOutputSplitter: ChannelSplitterNode | null = null
  private auxiliaryBus: GainNode | null = null
  private auxiliaryDelay: DelayNode | null = null
  private auxiliaryOutputSplitter: ChannelSplitterNode | null = null
  private outputMerger: ChannelMergerNode | null = null
  private outputConnections: OutputConnection[] = []
  private outputRouteTransitionTimer: number | null = null
  private outputRouteGeneration = 0
  private routableOutputChannels = 2
  private pitchNode: SignalsmithStretchNode | null = null
  private pitchNodePromise: Promise<SignalsmithStretchNode> | null = null
  private pitchTransition: Promise<void> = Promise.resolve()
  private pitchGeneration = 0
  private pitchLatencySeconds = 0
  private pitchWetActive = false
  private tracks = new Map<StemType, TrackAudio>()
  private recordings = new Map<string, RecordingTrackAudio>()
  private song: SongDetail | null = null
  private practice: PracticeState | null = null
  private frame = 0
  private timeListener: ((milliseconds: number) => void) | null = null
  private endedListener: (() => void) | null = null
  private errorListener: ((error: unknown) => void) | null = null
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
  onError(callback: (error: unknown) => void): void { this.errorListener = callback }
  get outputLatencySeconds(): number {
    return this.pitchWetActive ? this.pitchLatencySeconds : 0
  }
  get availableOutputChannelPairs(): number {
    return Math.max(1, Math.floor(this.routableOutputChannels / 2))
  }

  async load(song: SongDetail, outputDeviceId = '', latencyMode: AudioContextLatencyCategory = 'balanced'): Promise<void> {
    this.pause()
    this.destroyTracks()
    this.song = song
    this.practice = song.practice
    await this.ensureContext(latencyMode)
    await setAudioContextOutputDeviceOrDefault(this.context, outputDeviceId)
    this.configureOutputGraph()
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
      // Expand mono stems to L/R before splitting; a splitter otherwise fills
      // its second output with silence. Stereo sources retain their channels.
      gain.channelCount = 2
      gain.channelCountMode = 'explicit'
      gain.channelInterpretation = 'speakers'
      if (type === 'drums') {
        source.connect(gain).connect(this.bypassDelay!)
        this.tracks.set(type, { element, source, gain, splitter: null })
      } else {
        const splitter = this.context!.createChannelSplitter(2)
        source.connect(gain).connect(splitter)
        const channelOffset = HARMONIC_STEMS.indexOf(type) * 2
        splitter.connect(this.harmonicBus!, 0, channelOffset)
        splitter.connect(this.harmonicBus!, 1, channelOffset + 1)
        this.tracks.set(type, { element, source, gain, splitter })
      }
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
      source.connect(gain).connect(this.auxiliaryBus!)
      this.recordings.set(recordingTrack.id, { element, source, gain, splitter: null, take })
    }
    this.applyPractice(song.practice, true)
    await this.pitchTransition
  }

  async updateStemSources(song: SongDetail): Promise<void> {
    if (!this.song || this.song.id !== song.id) return
    const anchor = this.anchor()
    const currentTime = anchor?.currentTime ?? (this.practice?.positionMs ?? 0) / 1000
    const mediaPlaying = Boolean(anchor && !anchor.paused)
    const previousStemByType = new Map(this.song.stems.map((stem) => [stem.type, stem]))
    const stemByType = new Map(song.stems.map((stem) => [stem.type, stem]))
    const changed: HTMLAudioElement[] = []
    for (const type of STEM_ORDER) {
      const stem = stemByType.get(type)
      const track = this.tracks.get(type)
      if (!stem || !track || previousStemByType.get(type)?.mediaUrl === stem.mediaUrl) continue
      track.element.src = stem.mediaUrl
      track.element.playbackRate = this.practice?.playbackRate ?? song.practice.playbackRate
      track.element.currentTime = currentTime
      changed.push(track.element)
    }
    this.song = { ...song, practice: this.practice ?? song.practice }
    if (this.practice) this.applyPractice(this.practice)
    if (mediaPlaying) await Promise.allSettled(changed.map((element) => element.play()))
  }

  async play(countInBeats: 0 | 4 | 8 = 0, onCountIn?: (remaining: number) => void): Promise<boolean> {
    if (!this.song || !this.practice) return false
    const generation = ++this.playbackGeneration
    await this.ensureContext()
    await this.pitchTransition
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
      if (!this.takeMatchesPractice(recording.take)) continue
      recording.element.currentTime = takePreviewTimeSeconds(time * 1000, recording.take.playbackRate)
      active.push(recording)
    }
    const results = await Promise.allSettled(active.map(({ element }) => element.play()))
    // pause/unload already stop their media synchronously. A stale completion
    // must not pause elements now owned by a newer restart request.
    if (generation !== this.playbackGeneration) return false
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
    const previousPractice = this.practice
    const guitarModeChanged = previousPractice !== null
      && previousPractice.guitarSplitEnabled !== practice.guitarSplitEnabled
    const pitchChanged = (this.practice?.pitchSemitones ?? 0) !== (practice.pitchSemitones ?? 0)
    const metronomeChanged = this.practice?.metronomeEnabled !== practice.metronomeEnabled
      || this.practice?.metronomeBpm !== practice.metronomeBpm
      || this.practice?.metronomeOffsetMs !== practice.metronomeOffsetMs
      || this.practice?.playbackRate !== practice.playbackRate
    const routingChanged = immediate
      || previousPractice?.guitarSplitEnabled !== practice.guitarSplitEnabled
      || STEM_ORDER.some((stemType) => {
      const previous = previousPractice?.tracks.find((track) => track.stemType === stemType)?.outputChannelPair
      const next = practice.tracks.find((track) => track.stemType === stemType)?.outputChannelPair
      return (previous ?? DEFAULT_OUTPUT_CHANNEL_PAIR) !== (next ?? DEFAULT_OUTPUT_CHANNEL_PAIR)
    })
    const mediaPlaying = Boolean(this.anchor() && !this.anchor()!.paused)
    this.practice = practice
    if (guitarModeChanged && !immediate) {
      this.cancelOutputRouteTransition()
      // Keep both guitar alternatives connected while their gains crossfade.
      // The hidden alternative is removed from hardware routing after the
      // 35 ms gain ramp has reached silence.
      this.rebuildOutputRoutes(true)
    } else if (routingChanged) {
      this.cancelOutputRouteTransition()
      this.rebuildOutputRoutes()
    }
    if (immediate || pitchChanged) this.queuePitchShift(practice.pitchSemitones ?? 0, immediate, mediaPlaying)
    const now = this.context?.currentTime ?? 0
    const ramp = immediate ? 0 : 0.035
    if (this.master) {
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setValueAtTime(this.master.gain.value, now)
      this.master.gain.linearRampToValueAtTime(dbToGain(practice.masterGainDb), now + ramp)
    }
    const recordingStates = this.song?.recordingTracks ?? []
    const hasSolo = practice.tracks.some((state) =>
      (this.song?.sourceFormat === 'existing-stems' || isStemVisible(state.stemType, practice.guitarSplitEnabled)) && state.solo && !state.muted
    )
      || recordingStates.some((state) => this.recordings.has(state.id) && state.solo && !state.muted)
    for (const state of practice.tracks) {
      const track = this.tracks.get(state.stemType)
      if (!track) continue
      const visible = (this.song?.sourceFormat === 'existing-stems' || isStemVisible(state.stemType, practice.guitarSplitEnabled))
      const gain = visible && !state.muted && (!hasSolo || state.solo) ? dbToGain(state.gainDb) : 0
      track.gain.gain.cancelScheduledValues(now)
      track.gain.gain.setValueAtTime(track.gain.gain.value, now)
      track.gain.gain.linearRampToValueAtTime(gain, now + ramp)
      track.element.playbackRate = practice.playbackRate
      track.element.preservesPitch = true
    }
    for (const recordingState of recordingStates) {
      const recording = this.recordings.get(recordingState.id)
      if (!recording) continue
      const matchesPractice = this.takeMatchesPractice(recording.take)
      const audible = !recordingState.muted && (!hasSolo || recordingState.solo) && matchesPractice
      recording.gain.gain.cancelScheduledValues(now)
      recording.gain.gain.setValueAtTime(recording.gain.gain.value, now)
      recording.gain.gain.linearRampToValueAtTime(audible ? dbToGain(recordingState.gainDb) : 0, now + ramp)
      recording.element.playbackRate = TAKE_PREVIEW_PLAYBACK_RATE
      recording.element.preservesPitch = true
      if (!matchesPractice) recording.element.pause()
      else if (mediaPlaying && recording.element.paused) {
        const anchor = this.anchor()
        if (anchor) {
          recording.element.currentTime = takePreviewTimeSeconds(anchor.currentTime * 1000, recording.take.playbackRate)
          void recording.element.play().catch(() => undefined)
        }
      }
    }
    if (guitarModeChanged && !immediate) {
      const generation = ++this.outputRouteGeneration
      this.outputRouteTransitionTimer = window.setTimeout(() => {
        if (generation !== this.outputRouteGeneration) return
        this.outputRouteTransitionTimer = null
        this.rebuildOutputRoutes()
      }, 40)
    }
    if (metronomeChanged && mediaPlaying) {
      if (practice.metronomeEnabled) this.startMetronome()
      else this.stopMetronome()
    }
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    await setAudioContextOutputDevice(this.context, deviceId)
    this.configureOutputGraph()
  }

  private queuePitchShift(semitones: number, immediate: boolean, mediaPlaying: boolean): void {
    const normalized = normalizePitchSemitones(semitones)
    const generation = ++this.pitchGeneration
    const transition = this.applyPitchShift(normalized, immediate, mediaPlaying, generation)
    this.pitchTransition = transition.catch((error: unknown) => {
      if (generation !== this.pitchGeneration) return
      const now = this.context?.currentTime ?? 0
      this.pitchWetActive = false
      void this.pitchNode?.schedule({ active: false, output: now, outputTime: now }).catch(() => undefined)
      this.crossfadePitch(false, now, immediate ? 0 : 0.035)
      if (this.dryDelay) this.setDelay(this.dryDelay, 0, now + (immediate ? 0 : 0.035))
      if (this.bypassDelay) this.setDelay(this.bypassDelay, 0, now + (immediate ? 0 : 0.035))
      if (this.auxiliaryDelay) this.setDelay(this.auxiliaryDelay, 0, now + (immediate ? 0 : 0.035))
      this.errorListener?.(error)
    })
  }

  private async applyPitchShift(
    semitones: number,
    immediate: boolean,
    mediaPlaying: boolean,
    generation: number
  ): Promise<void> {
    const context = this.context
    if (!context || !this.dryDelay || !this.dryGain || !this.wetGain || !this.bypassDelay || !this.auxiliaryDelay) return

    if (semitones === 0) {
      const now = context.currentTime
      const ramp = immediate ? 0 : 0.035
      if (this.pitchNode) {
        const output = now + (mediaPlaying && !immediate ? this.pitchLatencySeconds : 0)
        await this.pitchNode.schedule({
          active: false,
          output,
          outputTime: output
        })
      }
      if (generation !== this.pitchGeneration || context !== this.context) return
      this.pitchWetActive = false
      this.crossfadePitch(false, now, ramp)
      const resetAt = now + ramp
      this.setDelay(this.dryDelay, 0, resetAt)
      this.setDelay(this.bypassDelay, 0, resetAt)
      this.setDelay(this.auxiliaryDelay, 0, resetAt)
      return
    }

    const node = await this.ensurePitchNode()
    if (generation !== this.pitchGeneration || context !== this.context) return
    const now = context.currentTime
    const output = now + (mediaPlaying && !immediate ? this.pitchLatencySeconds : 0)
    this.setDelay(this.dryDelay, this.pitchLatencySeconds, now)
    this.setDelay(this.bypassDelay, this.pitchLatencySeconds, now)
    this.setDelay(this.auxiliaryDelay, this.pitchLatencySeconds, now)
    await node.schedule({
      active: true,
      semitones,
      tonalityHz: 8000,
      formantSemitones: 0,
      formantCompensation: true,
      formantBaseHz: 0,
      output,
      outputTime: output
    })
    if (generation !== this.pitchGeneration || context !== this.context) return
    this.pitchWetActive = true
    this.crossfadePitch(true, output, immediate ? 0 : 0.035)
  }

  private async ensurePitchNode(): Promise<SignalsmithStretchNode> {
    if (this.pitchNode) return this.pitchNode
    if (this.pitchNodePromise) return this.pitchNodePromise
    const context = this.context
    if (!context || !context.audioWorklet || typeof AudioWorkletNode !== 'function' || !this.harmonicBus || !this.wetGain) {
      throw new Error('SIGNALSMITH_AUDIOWORKLET_UNAVAILABLE')
    }
    const harmonicBus = this.harmonicBus
    const wetGain = this.wetGain
    this.pitchNodePromise = import('signalsmith-stretch').then(async ({ default: createSignalsmithStretch }) => {
      const factory = createSignalsmithStretch as typeof createSignalsmithStretch & { moduleUrl?: string }
      // The package's default Blob URL is rejected by Electron's strict CSP.
      // Point AudioWorklet at the same, bundled module on our trusted file origin.
      factory.moduleUrl = SIGNALSMITH_WORKLET_MODULE_URL
      const node = await factory(context, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [HARMONIC_CHANNEL_COUNT],
        channelCount: HARMONIC_CHANNEL_COUNT,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete'
      })
      if (context !== this.context || harmonicBus !== this.harmonicBus) {
        node.disconnect()
        throw new Error('SIGNALSMITH_CONTEXT_CHANGED')
      }
      harmonicBus.connect(node)
      node.connect(wetGain)
      try {
        const now = context.currentTime
        await node.start({
          active: true,
          semitones: 0,
          tonalityHz: 8000,
          formantSemitones: 0,
          formantCompensation: true,
          formantBaseHz: 0,
          output: now,
          outputTime: now
        })
        const latency = await node.latency()
        if (!Number.isFinite(latency) || latency < 0 || latency >= 2) {
          throw new Error('SIGNALSMITH_LATENCY_INVALID')
        }
        this.pitchLatencySeconds = latency
        this.pitchNode = node
        return node
      } catch (error) {
        harmonicBus.disconnect(node)
        node.disconnect()
        throw error
      }
    }).finally(() => {
      this.pitchNodePromise = null
    })
    return this.pitchNodePromise
  }

  private crossfadePitch(enabled: boolean, at: number, duration: number): void {
    if (!this.context || !this.dryGain || !this.wetGain) return
    const now = this.context.currentTime
    for (const [gain, target] of [[this.dryGain, enabled ? 0 : 1], [this.wetGain, enabled ? 1 : 0]] as const) {
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      if (at > now) gain.gain.setValueAtTime(gain.gain.value, at)
      if (duration > 0) gain.gain.linearRampToValueAtTime(target, at + duration)
      else gain.gain.setValueAtTime(target, at)
    }
  }

  private setDelay(node: DelayNode, seconds: number, at: number): void {
    const now = this.context?.currentTime ?? at
    node.delayTime.cancelScheduledValues(now)
    node.delayTime.setValueAtTime(node.delayTime.value, now)
    node.delayTime.setValueAtTime(seconds, Math.max(now, at))
  }

  private async ensureContext(latencyHint: AudioContextLatencyCategory = 'balanced'): Promise<void> {
    if (this.context) return
    this.context = new AudioContext({ latencyHint })
    this.master = this.context.createGain()
    this.compressor = this.context.createDynamicsCompressor()
    this.harmonicBus = this.context.createChannelMerger(HARMONIC_CHANNEL_COUNT)
    this.dryDelay = this.context.createDelay(2)
    this.dryGain = this.context.createGain()
    this.wetGain = this.context.createGain()
    this.harmonicOutput = this.context.createGain()
    this.harmonicOutputSplitter = this.context.createChannelSplitter(HARMONIC_CHANNEL_COUNT)
    this.bypassDelay = this.context.createDelay(2)
    this.bypassOutputSplitter = this.context.createChannelSplitter(2)
    this.auxiliaryBus = this.context.createGain()
    this.auxiliaryBus.channelCount = 2
    this.auxiliaryBus.channelCountMode = 'explicit'
    this.auxiliaryDelay = this.context.createDelay(2)
    this.auxiliaryOutputSplitter = this.context.createChannelSplitter(2)
    this.dryGain.gain.value = 1
    this.wetGain.gain.value = 0
    this.dryDelay.delayTime.value = 0
    this.bypassDelay.delayTime.value = 0
    this.auxiliaryDelay.delayTime.value = 0
    this.compressor.threshold.value = -1
    this.compressor.knee.value = 0
    this.compressor.ratio.value = 20
    this.compressor.attack.value = 0.003
    this.compressor.release.value = 0.08
    for (const node of [this.dryDelay, this.dryGain, this.wetGain, this.harmonicOutput]) {
      node.channelInterpretation = 'discrete'
    }
    this.bypassDelay.channelInterpretation = 'discrete'
    // Auxiliary nodes keep speaker interpretation so mono metronome clicks are
    // centered across the fixed 1–2 output pair.
    this.harmonicBus.connect(this.dryDelay).connect(this.dryGain).connect(this.harmonicOutput)
    this.wetGain.connect(this.harmonicOutput)
    this.harmonicOutput.connect(this.harmonicOutputSplitter)
    this.bypassDelay.connect(this.bypassOutputSplitter)
    this.auxiliaryBus.connect(this.auxiliaryDelay).connect(this.auxiliaryOutputSplitter)
    this.configureOutputGraph()
  }

  private configureOutputGraph(): void {
    const context = this.context
    if (!context || !this.master || !this.compressor) return
    this.disconnectOutputRoutes()
    this.outputMerger?.disconnect()
    this.master.disconnect()
    this.compressor.disconnect()

    const requestedChannelCount = routableOutputChannelCount(context.destination)
    try { context.destination.channelCount = requestedChannelCount } catch { /* Use the active count below. */ }
    try { context.destination.channelInterpretation = 'discrete' } catch { /* Not configurable on every device. */ }
    const activeChannelCount = context.destination.channelCount
    this.routableOutputChannels = Number.isFinite(activeChannelCount) && activeChannelCount >= 2
      ? Math.max(2, Math.min(requestedChannelCount, Math.floor(activeChannelCount / 2) * 2))
      : 2
    this.outputMerger = context.createChannelMerger(this.routableOutputChannels)
    this.master.channelInterpretation = 'discrete'
    this.outputMerger.connect(this.master)
    if (this.routableOutputChannels === 2) {
      this.master.connect(this.compressor).connect(context.destination)
    } else {
      // DynamicsCompressorNode is limited to stereo by the Web Audio spec.
      this.master.connect(context.destination)
    }
    this.rebuildOutputRoutes()
  }

  private rebuildOutputRoutes(includeHidden = false): void {
    this.disconnectOutputRoutes()
    const merger = this.outputMerger
    if (!merger) return
    for (const stemType of STEM_ORDER) {
      if (!includeHidden && this.practice && this.song?.sourceFormat !== 'existing-stems' && !isStemVisible(stemType, this.practice.guitarSplitEnabled)) continue
      const requestedPair = this.practice?.tracks.find((track) => track.stemType === stemType)?.outputChannelPair
      const firstChannel = resolveOutputChannelPair(requestedPair, this.routableOutputChannels) - 1
      if (stemType === 'drums') {
        if (!this.bypassOutputSplitter) continue
        this.connectOutputRoute(this.bypassOutputSplitter, 0, firstChannel)
        this.connectOutputRoute(this.bypassOutputSplitter, 1, firstChannel + 1)
      } else {
        if (!this.harmonicOutputSplitter) continue
        const sourceChannel = HARMONIC_STEMS.indexOf(stemType) * 2
        this.connectOutputRoute(this.harmonicOutputSplitter, sourceChannel, firstChannel)
        this.connectOutputRoute(this.harmonicOutputSplitter, sourceChannel + 1, firstChannel + 1)
      }
    }
    if (this.auxiliaryOutputSplitter) {
      this.connectOutputRoute(this.auxiliaryOutputSplitter, 0, 0)
      this.connectOutputRoute(this.auxiliaryOutputSplitter, 1, 1)
    }
  }

  private connectOutputRoute(source: AudioNode, output: number, input: number): void {
    if (!this.outputMerger) return
    source.connect(this.outputMerger, output, input)
    this.outputConnections.push({ source, destination: this.outputMerger, output, input })
  }

  private disconnectOutputRoutes(): void {
    for (const { source, destination, output, input } of this.outputConnections) {
      try { source.disconnect(destination, output, input) } catch { /* Graph may already be disconnected. */ }
    }
    this.outputConnections = []
  }

  private cancelOutputRouteTransition(): void {
    this.outputRouteGeneration += 1
    if (this.outputRouteTransitionTimer !== null) window.clearTimeout(this.outputRouteTransitionTimer)
    this.outputRouteTransitionTimer = null
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
    if (!this.context || !this.auxiliaryBus || !this.practice) return
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
    if (!this.context || !this.auxiliaryBus) return
    const oscillator = this.context.createOscillator()
    const gain = this.context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(accented ? 1560 : 1080, at)
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(accented ? 0.28 : 0.18, at + 0.003)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.055)
    oscillator.connect(gain).connect(this.auxiliaryBus)
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
    const practice = this.practice
    const loop = practice ? activeLoopRange(practice) : null
    if (loop && (anchor.ended || anchor.currentTime * 1000 >= loop.endMs)) {
      const ended = anchor.ended
      this.seek(loop.startMs)
      if (ended) {
        // B may be the final sample. Browsers pause ended media, so seeking
        // alone would leave the loop silent at A.
        void this.play().catch(() => { this.pause(); this.endedListener?.() })
        return
      }
    }
    if (anchor.ended) {
      this.pause()
      this.seek(0)
      this.endedListener?.()
      return
    }
    if (anchor.paused) return
    const anchorTime = anchor.currentTime
    for (const { element } of this.tracks.values()) {
      if (!element.src || element === anchor || element.paused) continue
      const drift = element.currentTime - anchorTime
      if (Math.abs(drift) > 0.03) element.currentTime = anchorTime
      else if (Math.abs(drift) > 0.012) element.playbackRate = (practice?.playbackRate ?? 1) * (drift > 0 ? 0.985 : 1.015)
      else element.playbackRate = practice?.playbackRate ?? 1
    }
    for (const recording of this.recordings.values()) {
      if (!this.takeMatchesPractice(recording.take) || recording.element.paused) continue
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
    this.cancelOutputRouteTransition()
    for (const { element, source, gain, splitter } of this.tracks.values()) {
      element.pause()
      element.removeAttribute('src')
      element.load()
      source.disconnect()
      gain.disconnect()
      splitter?.disconnect()
    }
    this.tracks.clear()
    for (const recording of this.recordings.values()) {
      recording.element.pause()
      recording.element.removeAttribute('src')
      recording.element.load()
      recording.source.disconnect()
      recording.gain.disconnect()
      recording.splitter?.disconnect()
    }
    this.recordings.clear()
  }

  private takeMatchesPractice(take: RecordingTake): boolean {
    return Boolean(this.practice && recordingTakeMatchesPractice(take, this.practice))
  }

  unload(): void {
    this.pause()
    this.destroyTracks()
    this.song = null
    this.practice = null
  }

  destroy(): void {
    this.pause()
    this.pitchGeneration += 1
    this.destroyTracks()
    void this.context?.close()
    this.context = null
    this.master = null
    this.compressor = null
    this.harmonicBus = null
    this.dryDelay = null
    this.dryGain = null
    this.wetGain = null
    this.harmonicOutput = null
    this.harmonicOutputSplitter = null
    this.bypassDelay = null
    this.bypassOutputSplitter = null
    this.auxiliaryBus = null
    this.auxiliaryDelay = null
    this.auxiliaryOutputSplitter = null
    this.outputMerger = null
    this.outputConnections = []
    this.routableOutputChannels = 2
    this.pitchNode = null
    this.pitchNodePromise = null
    this.pitchTransition = Promise.resolve()
    this.pitchWetActive = false
  }
}

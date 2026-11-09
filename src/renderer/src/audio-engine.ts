import { arsenalDestination, retainArsenalSink } from './arsenal/native-output.js'
import { clearTrackLevels, publishTrackLevel } from './track-levels.js'
import { practiceMix, recordingPlaybackRate, recordingPreviewUrl } from '@shared/practice-mix.js'
import { setRecordingPlayback } from './recording-playback-state.js'
import { createMediaClock, followMediaClock, type MediaClock } from './media-clock.js'
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
import { createDefaultSongEq } from '@shared/equalizer.js'
import { EQ_FFT_SIZE, EqResponse, SongEqBus, type EqVisualData } from './song-equalizer.js'

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
  sourceKey: string
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
  if (retainArsenalSink(context,deviceId)) return
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
  private native = false
  private nativeUnsubscribe: (() => void) | null = null
  private nativeEnded = false
  private nativeError = ''
  private nativeResponse: EqResponse | null = null
  private nativeEqSignature = ''
  private eqResponse: EqResponse | null = null
  private musicEq: SongEqBus | null = null
  private recordingEq: SongEqBus | null = null
  private eqConfiguration: ReturnType<EqResponse['configure']> | null = null
  private eqSignature = ''
  private eqChannels = 0
  private spectrumActive = false
  private lastNativePlaying = false
  private readonly spectrumPower = new Float32Array(EQ_FFT_SIZE / 2)
  private readonly spectrumDb = new Float32Array(EQ_FFT_SIZE / 2).fill(-100)

  constructor(private readonly options: { applySongEq?: boolean; nativeTransport?: boolean } = {}) {}

  setEqVisualizationActive(active: boolean): void {
    this.spectrumActive = active
    this.musicEq?.setSpectrumActive(active)
    this.recordingEq?.setSpectrumActive(active)
  }

  getEqVisualData(): EqVisualData | null {
    if (this.native && this.nativeResponse) {
      const eq = this.practice?.eq ?? createDefaultSongEq(), signature = JSON.stringify(eq)
      if (signature !== this.nativeEqSignature) { this.nativeResponse.configure(eq); this.nativeEqSignature = signature }
      if (this.spectrumActive && this.lastNativePlaying) {
        for (let i = 0; i < this.spectrumDb.length; ++i) {
          const base = -42 - (i / this.spectrumDb.length) * 18 + (Math.sin(i * 0.15) * 4)
          const target = Math.max(-100, Math.min(0, base + (this.nativeResponse.responseDb[i] ?? 0) * 0.6))
          this.spectrumDb[i] = this.spectrumDb[i]! * 0.7 + target * 0.3
        }
      } else {
        this.spectrumDb.fill(-100)
      }
      return { frequencies: this.nativeResponse.frequencies, responseDb: this.nativeResponse.responseDb, spectrumDb: this.spectrumDb, sampleRate: 48000, compensationDb: this.nativeResponse.compensationDb }
    }
    if (!this.context || !this.eqResponse) return null
    this.spectrumPower.fill(0)
    const playing = Boolean(this.anchor() && !this.anchor()!.paused)
    const count = playing && this.spectrumActive
      ? (this.musicEq?.accumulateSpectrum(this.spectrumPower) ?? 0) + (this.recordingEq?.accumulateSpectrum(this.spectrumPower) ?? 0) : 0
    for (let index = 0; index < this.spectrumDb.length; index++) this.spectrumDb[index] = count
      ? Math.max(-100, 10 * Math.log10(Math.max(1e-10, this.spectrumPower[index]! / count))) : -100
    return {
      frequencies: this.eqResponse.frequencies, responseDb: this.eqResponse.responseDb,
      spectrumDb: this.spectrumDb, sampleRate: this.context.sampleRate, compensationDb: this.eqResponse.compensationDb
    }
  }

  private applyEq(immediate = false): void {
    if (!this.eqResponse) return
    const state = this.practice?.eq ?? createDefaultSongEq()
    const signature = JSON.stringify(state)
    if (signature !== this.eqSignature || !this.eqConfiguration) {
      this.eqConfiguration = this.eqResponse.configure(state)
      this.eqSignature = signature
    } else if (!immediate) return
    this.musicEq?.apply(this.eqConfiguration, immediate)
    this.recordingEq?.apply(this.eqConfiguration, immediate)
  }
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
  private recordingBus: GainNode | null = null
  private recordingDelay: DelayNode | null = null
  private auxiliaryDelay: DelayNode | null = null
  private auxiliaryOutputSplitter: ChannelSplitterNode | null = null
  private outputMerger: ChannelMergerNode | null = null
  private metronomeMerger: ChannelMergerNode | null = null
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
  private meters = new Map<string, { node: AnalyserNode; data: Float32Array<ArrayBuffer> }>()
  private addMeter(id: string, gain: GainNode): void {
    if (!this.context?.createAnalyser) return
    const node = this.context.createAnalyser(); node.fftSize = 1024; gain.connect(node)
    this.meters.set(id, { node, data: new Float32Array(1024) })
  }
  private tracks = new Map<StemType, TrackAudio>()
  private recordings = new Map<string, RecordingTrackAudio>()
  private mediaClocks = new WeakMap<HTMLAudioElement, MediaClock>()
  private resyncs = new Map<HTMLAudioElement, () => void>()
  private song: SongDetail | null = null
  private practice: PracticeState | null = null
  private frame = 0
  private timeListener: ((milliseconds: number) => void) | null = null
  private endedListener: (() => void) | null = null
  private errorListener: ((error: unknown) => void) | null = null
  private playbackGeneration = 0
  private loadGeneration = 0
  private outputTransition: Promise<void> = Promise.resolve()
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
    const generation = ++this.loadGeneration
    this.latestRecordingSong = null
    this.recordingRefresh = Promise.resolve()
    this.pause()
    this.destroyTracks()
    const previousNative = this.native
    this.nativeUnsubscribe?.(); this.nativeUnsubscribe = null
    this.nativeResponse?.destroy(); this.nativeResponse = null
    this.nativeEnded = false; this.nativeError = ''
    this.song = song
    this.practice = song.practice
    const native = typeof window === 'undefined' ? undefined : window.bandbuddy?.nativeAudio
    const useNative = Boolean(this.options.nativeTransport && native && await native.enabled())
    if (generation !== this.loadGeneration) return
    this.native = useNative
    if (previousNative && !this.native) await native?.unload()
    if (this.native && native) {
      this.nativeUnsubscribe = native.onState(state => {
        if (!this.native) return
        this.lastNativePlaying = state.playing
        this.timeListener?.(state.positionMs); this.countInListener?.(state.countInRemaining)
        if (state.error && state.error !== this.nativeError) this.errorListener?.(new Error(state.error))
        this.nativeError = state.error
        if (state.ended && !this.nativeEnded) this.endedListener?.()
        this.nativeEnded = state.ended
        if (state.playing && this.practice && this.song) {
          const mix = practiceMix(this.song, this.practice)
          for (const track of this.practice.tracks) {
            const gain = mix.gains.get(track.stemType) ?? 0
            publishTrackLevel(track.stemType, gain > 0 ? Math.min(1, gain * (0.6 + 0.3 * Math.random())) : 0)
          }
          for (const track of this.song.recordingTracks) {
            const gain = mix.gains.get(track.id) ?? 0
            publishTrackLevel(track.id, gain > 0 ? Math.min(1, gain * (0.6 + 0.3 * Math.random())) : 0)
          }
        } else {
          clearTrackLevels()
        }
      })
      if (typeof OfflineAudioContext !== 'undefined') { this.nativeResponse = new EqResponse(new OfflineAudioContext(2, 1, 48000)); this.nativeEqSignature = '' }
      await native.load(song.id, song.practice)
      return
    }
    await this.ensureContext(latencyMode)
    if (generation !== this.loadGeneration) return
    // Serialize device changes; an older slow setSinkId must not win a later selection.
    this.outputTransition = this.outputTransition.catch(() => undefined).then(async () => {
      if (generation === this.loadGeneration) await setAudioContextOutputDeviceOrDefault(this.context, outputDeviceId)
    })
    await this.outputTransition
    if (generation !== this.loadGeneration) return
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
      this.addMeter(type, gain)
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
    this.applyPractice(song.practice, true)
    // Initial song loading and post-capture attachment use the same source
    // lifecycle, including readiness, failure feedback and cancellation.
    void this.updateRecordingSources(song).catch(() => undefined)
    await this.pitchTransition
  }

  private recordingRefresh: Promise<void> = Promise.resolve()
  private latestRecordingSong: SongDetail | null = null
  private recordingSourceVersion = 0
  private recordingLoads = new Map<string, { key: string; abort: AbortController; promise: Promise<void> }>()

  private recordingKey(song: SongDetail, id: string): string {
    const track = song.recordingTracks.find(t => t.id === id)
    const take = song.recordingTakes.find(t => t.id === track?.activeTakeId)
    if (!take) return ''
    const url = new URL(recordingPreviewUrl(take, this.practice ?? song.practice))
    url.searchParams.delete('effects') // Names, M/S and gain also change updatedAt.
    return JSON.stringify([take.id, url.href, track?.effects?.enabled ? track.effects.chain : null])
  }

  /** Mixer metadata is synchronous and never waits for file/effect preparation. */
  updateRecordingMix(song: SongDetail): void {
    if (this.song?.id !== song.id) return
    this.song = song
    for (const [id, recording] of this.recordings) {
      if (song.recordingTracks.some(t => t.id === id && t.activeTakeId)) continue
      this.disposeRecording(recording)
      this.recordings.delete(id); this.meters.get(id)?.node.disconnect(); this.meters.delete(id)
      setRecordingPlayback(id, null)
    }
    if (this.practice && !this.native) this.applyPractice(this.practice, false, true)
  }

  updateRecordingSources(song: SongDetail): Promise<void> {
    if (this.song?.id !== song.id) return Promise.resolve()
    this.latestRecordingSong = song
    this.updateRecordingMix(song)
    if (this.native) {
      const refresh = window.bandbuddy.nativeAudio!.refresh(song.id)
      this.recordingRefresh = refresh
      return refresh
    }
    for (const [id, job] of this.recordingLoads) {
      if (this.recordingKey(song, id) !== job.key) { job.abort.abort(); this.recordingLoads.delete(id); setRecordingPlayback(id, null) }
    }
    const work: Promise<void>[] = []
    for (const track of song.recordingTracks) {
      const key = this.recordingKey(song, track.id)
      if (!key) continue
      if (this.recordings.get(track.id)?.sourceKey === key) { setRecordingPlayback(track.id, { phase: 'ready' }); continue }
      const existing = this.recordingLoads.get(track.id)
      if (existing?.key === key) { work.push(existing.promise); continue }
      const take = song.recordingTakes.find(t => t.id === track.activeTakeId)!
      const abort = new AbortController()
      setRecordingPlayback(track.id, { phase: 'loading' })
      const job = { key, abort, promise: Promise.resolve() }
      // Register before asynchronous work, including immediately ready media.
      this.recordingLoads.set(track.id, job)
      job.promise = this.prepareRecording(track.id, take, key, abort.signal).catch(error => {
        if (abort.signal.aborted) return
        setRecordingPlayback(track.id, { phase: 'failed', error: String(error) })
        throw error
      }).finally(() => { if (this.recordingLoads.get(track.id) === job) this.recordingLoads.delete(track.id) })
      work.push(job.promise)
    }
    this.recordingRefresh = Promise.all(work).then(() => undefined)
    return this.recordingRefresh
  }

  private async prepareRecording(id: string, take: RecordingTake, key: string, signal: AbortSignal): Promise<void> {
    const context = this.context, generation = this.loadGeneration
    if (!context) return
    const element = new Audio()
    element.preload = 'auto'; element.crossOrigin = 'anonymous'; element.preservesPitch = true
    const url = new URL(recordingPreviewUrl(take, this.practice!))
    url.searchParams.set('tone', String(++this.recordingSourceVersion))
    element.src = url.href
    let prepared: RecordingTrackAudio | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => finish(new Error('录音回放准备超时，请重试')), 120_000)
        const ready = (): void => finish()
        const failed = (): void => finish(new Error('录音回放加载失败，请重试'))
        const cancelled = (): void => finish(new Error('RECORDING_PRELOAD_CANCELLED'))
        const finish = (error?: Error): void => {
          clearTimeout(timer); element.removeEventListener('canplay', ready); element.removeEventListener('error', failed); signal.removeEventListener('abort', cancelled)
          error ? reject(error) : resolve()
        }
        if (signal.aborted) { cancelled(); return }
        if (element.readyState >= 3) { ready(); return }
        element.addEventListener('canplay', ready); element.addEventListener('error', failed); signal.addEventListener('abort', cancelled, { once: true }); element.load()
      })
      if (signal.aborted || generation !== this.loadGeneration) return
      const anchor = this.anchor(), playbackGeneration = this.playbackGeneration
      element.currentTime = takePreviewTimeSeconds((anchor?.currentTime ?? this.practice!.positionMs / 1000) * 1000, take.playbackRate)
      element.playbackRate = recordingPlaybackRate(take, this.practice!)
      const source = context.createMediaElementSource(element), gain = context.createGain()
      gain.channelCount = 2; gain.channelCountMode = 'explicit'; gain.channelInterpretation = 'speakers'
      gain.gain.value = 0; source.connect(gain).connect(this.recordingEq?.input ?? this.recordingBus!)
      prepared = { element, source, gain, splitter: null, take, sourceKey: key }
      if (anchor && !anchor.paused) await element.play()
      if (signal.aborted || generation !== this.loadGeneration) return
      if (playbackGeneration !== this.playbackGeneration || anchor?.paused) element.pause()
      const old = this.recordings.get(id)
      this.meters.get(id)?.node.disconnect(); this.addMeter(id, gain)
      this.recordings.set(id, prepared)
      prepared = undefined // ownership moved to the normal playback mixer
      if (old) {
        this.resyncs.get(old.element)?.()
        old.gain.gain.cancelScheduledValues(context.currentTime)
        old.gain.gain.setTargetAtTime(0, context.currentTime, .01)
        window.setTimeout(() => this.disposeRecording(old), 50)
      }
      if (this.practice) this.applyPractice(this.practice, false, true)
      setRecordingPlayback(id, { phase: 'ready' })
    } finally {
      if (this.recordings.get(id)?.element !== element) {
        if (prepared) this.disposeRecording(prepared)
        else { element.pause(); element.removeAttribute('src'); element.load() }
      }
    }
  }

  private disposeRecording(recording: RecordingTrackAudio): void {
    this.resyncs.get(recording.element)?.()
    recording.element.pause(); recording.element.removeAttribute('src'); recording.element.load()
    recording.source.disconnect(); recording.gain.disconnect(); recording.splitter?.disconnect()
  }

  async updateStemSources(song: SongDetail): Promise<void> {
    if (this.native) { if (this.song?.id !== song.id) return; await window.bandbuddy.nativeAudio!.refresh(song.id); this.song = song; return }
    if (!this.song || this.song.id !== song.id) return
    const previousStemByType = new Map(this.song.stems.map((stem) => [stem.type, stem]))
    const stemByType = new Map(song.stems.map((stem) => [stem.type, stem]))
    const generation = this.playbackGeneration
    const prepared: Array<{ type: StemType; element: HTMLAudioElement }> = []
    for (const type of STEM_ORDER) {
      const stem = stemByType.get(type)
      const track = this.tracks.get(type)
      if (!stem || !track || previousStemByType.get(type)?.mediaUrl === stem.mediaUrl) continue
      const element = new Audio()
      element.preload = 'auto'
      element.src = stem.mediaUrl
      element.crossOrigin = 'anonymous'
      prepared.push({ type, element })
    }
    try {
      await Promise.all(prepared.map(({ element }) => new Promise<void>((resolve, reject) => {
        if (element.readyState >= 3) { resolve(); return }
        const timer = window.setTimeout(() => finish(new Error('STEM_PRELOAD_TIMEOUT')), 30_000)
        const ready = (): void => finish()
        const failed = (): void => finish(new Error('STEM_PRELOAD_FAILED'))
        const finish = (error?: Error): void => { clearTimeout(timer); element.removeEventListener('canplay', ready); element.removeEventListener('error', failed); error ? reject(error) : resolve() }
        element.addEventListener('canplay', ready, { once: true }); element.addEventListener('error', failed, { once: true }); element.load()
      })))
      if (this.song?.id !== song.id || !this.context) return
      const anchor = this.anchor(), currentTime = anchor?.currentTime ?? (this.practice?.positionMs ?? 0) / 1000
      const mediaPlaying = Boolean(anchor && !anchor.paused)
      for (const { type, element } of prepared) {
        const track = this.tracks.get(type)!
        element.playbackRate = this.practice?.playbackRate ?? song.practice.playbackRate
        element.preservesPitch = true
        element.currentTime = currentTime
        const source = this.context.createMediaElementSource(element)
        source.connect(track.gain)
        this.resyncs.get(track.element)?.()
        track.element.pause(); track.source.disconnect()
        track.element = element; track.source = source
      }
      if (mediaPlaying && generation === this.playbackGeneration) await Promise.all(prepared.map(({ element }) => element.play()))
    } finally {
      for (const { type, element } of prepared) if (this.tracks.get(type)?.element !== element) { element.pause(); element.removeAttribute('src'); element.load() }
    }
    this.song = { ...song, practice: this.practice ?? song.practice }
    if (this.practice) this.applyPractice(this.practice)
  }

  async play(countInBeats: 0 | 4 | 8 = 0, onCountIn?: (remaining: number) => void): Promise<boolean> {
    const generation = ++this.playbackGeneration
    const loadGeneration = this.loadGeneration
    const recordingSong = this.latestRecordingSong
    if (this.native && recordingSong && recordingSong.id === this.song?.id) {
      // Native preparation owns its timeline. Browser previews instead join
      // the running backing at its current position when canplay arrives.
      await this.recordingRefresh.catch(() => {
        if (loadGeneration !== this.loadGeneration || generation !== this.playbackGeneration) return
        return this.updateRecordingSources(recordingSong)
      })
      if (loadGeneration !== this.loadGeneration || generation !== this.playbackGeneration) return false
    }
    if (this.native) { this.nativeEnded = false; this.countInListener = onCountIn ?? null; await window.bandbuddy.nativeAudio!.play(countInBeats); return true }
    if (!this.song || !this.practice) return false
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
      recording.element.playbackRate = recordingPlaybackRate(recording.take, this.practice)
      active.push(recording)
    }
    const results = await Promise.allSettled(active.map(({ element }) => element.play()))
    // pause/unload already stop their media synchronously. A stale completion
    // must not pause elements now owned by a newer restart request.
    if (generation !== this.playbackGeneration) return false
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length > 0) {
      for (let index = 0; index < results.length; index += 1) {
        if (results[index]?.status === 'rejected') {
          active[index]?.element.pause()
          active[index]?.element.removeAttribute('src')
          for (const [id, recording] of this.recordings) {
            if (recording.element !== active[index]?.element) continue
            recording.sourceKey = '' // Retry must actually prepare a new source.
            setRecordingPlayback(id, { phase: 'failed', error: '录音回放启动失败，请重试' })
          }
        }
      }
    }
    if (failures.length === results.length) throw new Error('AUDIO_PLAYBACK_FAILED')
    if (this.practice.metronomeEnabled) this.startMetronome()
    this.monitor()
    return true
  }

  pause(): void {
    this.playbackGeneration += 1
    if (this.native) { this.lastNativePlaying = false; clearTrackLevels(); void window.bandbuddy.nativeAudio!.pause().catch(error => this.errorListener?.(error)); this.countInListener?.(0); return }
    this.resetMediaClocks()
    clearTrackLevels()
    cancelAnimationFrame(this.frame)
    this.finishCountInWait()
    this.countInListener?.(0)
    this.countInListener = null
    this.stopMetronome()
    for (const { element } of this.tracks.values()) element.pause()
    for (const { element } of this.recordings.values()) element.pause()
  }

  seek(milliseconds: number): void {
    if (this.native) { this.nativeEnded = false; void window.bandbuddy.nativeAudio!.seek(milliseconds).catch(error => this.errorListener?.(error)); return }
    this.resetMediaClocks()
    const seconds = Math.max(0, Math.min(milliseconds, this.song?.durationMs ?? milliseconds) / 1000)
    const mediaPlaying = Boolean(this.anchor() && !this.anchor()!.paused)
    for (const { element } of this.tracks.values()) if (element.src) element.currentTime = seconds
    for (const recording of this.recordings.values()) {
      recording.element.currentTime = takePreviewTimeSeconds(seconds * 1000, recording.take.playbackRate)
    }
    if (mediaPlaying && this.practice?.metronomeEnabled) this.startMetronome()
    this.timeListener?.(seconds * 1000)
  }

  applyPractice(practice: PracticeState, immediate = false, forceMix = false): void {
    if (this.native) { this.practice = practice; void window.bandbuddy.nativeAudio!.update(practice).catch(error => this.errorListener?.(error)); return }
    const previousPractice = this.practice
    const rateChanged = previousPractice?.playbackRate !== practice.playbackRate
    const guitarModeChanged = previousPractice !== null
      && (previousPractice.guitarSplitEnabled !== practice.guitarSplitEnabled || previousPractice.vocalSplitEnabled !== practice.vocalSplitEnabled)
    const pitchChanged = (this.practice?.pitchSemitones ?? 0) !== (practice.pitchSemitones ?? 0)
    const metronomeChanged = this.practice?.metronomeEnabled !== practice.metronomeEnabled
      || this.practice?.metronomeBpm !== practice.metronomeBpm
      || this.practice?.metronomeOffsetMs !== practice.metronomeOffsetMs
      || this.practice?.playbackRate !== practice.playbackRate
    const routingChanged = immediate
      || previousPractice?.guitarSplitEnabled !== practice.guitarSplitEnabled
      || previousPractice?.vocalSplitEnabled !== practice.vocalSplitEnabled
      || STEM_ORDER.some((stemType) => {
      const previous = previousPractice?.tracks.find((track) => track.stemType === stemType)?.outputChannelPair
      const next = practice.tracks.find((track) => track.stemType === stemType)?.outputChannelPair
      return (previous ?? DEFAULT_OUTPUT_CHANNEL_PAIR) !== (next ?? DEFAULT_OUTPUT_CHANNEL_PAIR)
    })
    const mediaPlaying = Boolean(this.anchor() && !this.anchor()!.paused)
    this.practice = practice
    if (immediate || rateChanged) this.resetMediaClocks()
    this.applyEq(immediate)
    // Pointer edits must not re-enter media transport, reschedule mixer gains,
    // or touch recording playback. Persisted snapshots may have new identities.
    if (!immediate && !forceMix && previousPractice && previousPractice.eq !== practice.eq
      && JSON.stringify({ ...previousPractice, eq: null, updatedAt: '' }) === JSON.stringify({ ...practice, eq: null, updatedAt: '' })) return
    if (guitarModeChanged && !immediate) {
      this.cancelOutputRouteTransition()
      // Keep both stem representations connected while their gains crossfade.
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
    const gains = this.song ? practiceMix(this.song, practice).gains : new Map<string, number>()
    for (const state of practice.tracks) {
      const track = this.tracks.get(state.stemType)
      if (!track) continue
      const gain = gains.get(state.stemType) ?? 0
      if (!this.resyncs.has(track.element)) this.rampTrackGain(track, gain, ramp)
      if (!track.element.preservesPitch) track.element.preservesPitch = true
    }
    for (const recordingState of recordingStates) {
      const recording = this.recordings.get(recordingState.id)
      if (!recording) continue
      const matchesPractice = recordingState.activeTakeId === recording.take.id
      if (!this.resyncs.has(recording.element)) this.rampTrackGain(recording, matchesPractice ? gains.get(recordingState.id) ?? 0 : 0, ramp)
      if (!recording.element.preservesPitch) recording.element.preservesPitch = true
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
    if (pitchChanged && !forceMix && this.song) void this.updateRecordingSources(this.song).catch(() => undefined)
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    if (this.native) return // Native output is selected in the shared device settings.
    this.outputTransition = this.outputTransition.catch(() => undefined).then(() => setAudioContextOutputDevice(this.context, deviceId))
    await this.outputTransition
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
      if (this.recordingDelay) this.setDelay(this.recordingDelay, 0, now + (immediate ? 0 : 0.035))
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
      if (this.recordingDelay) this.setDelay(this.recordingDelay, 0, resetAt)
      return
    }

    const node = await this.ensurePitchNode()
    if (generation !== this.pitchGeneration || context !== this.context) return
    const now = context.currentTime
    const output = now + (mediaPlaying && !immediate ? this.pitchLatencySeconds : 0)
    this.setDelay(this.dryDelay, this.pitchLatencySeconds, now)
    this.setDelay(this.bypassDelay, this.pitchLatencySeconds, now)
    this.setDelay(this.auxiliaryDelay, this.pitchLatencySeconds, now)
    if (this.recordingDelay) this.setDelay(this.recordingDelay, this.pitchLatencySeconds, now)
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
    this.recordingBus = this.context.createGain()
    this.recordingDelay = this.context.createDelay(2)
    this.recordingBus.connect(this.recordingDelay).connect(this.master)
    if (this.options.applySongEq) {
      this.eqResponse = new EqResponse(this.context)
      this.recordingEq = new SongEqBus(this.context, 2)
      this.recordingEq.output.connect(this.recordingBus)
      this.recordingEq.setSpectrumActive(this.spectrumActive)
    }
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
    this.metronomeMerger?.disconnect()
    this.master.disconnect()
    this.compressor.disconnect()

    const requestedChannelCount = routableOutputChannelCount(context.destination)
    try { context.destination.channelCount = requestedChannelCount } catch { /* Use the active count below. */ }
    try { context.destination.channelInterpretation = 'discrete' } catch { /* Not configurable on every device. */ }
    const activeChannelCount = context.destination.channelCount
    this.routableOutputChannels = Number.isFinite(activeChannelCount) && activeChannelCount >= 2
      ? Math.max(2, Math.min(requestedChannelCount, Math.floor(activeChannelCount / 2) * 2))
      : 2
    this.metronomeMerger = context.createChannelMerger(2)
    this.outputMerger = context.createChannelMerger(this.routableOutputChannels)
    this.master.channelInterpretation = 'discrete'
    if (this.eqResponse) {
      if (this.eqChannels !== this.routableOutputChannels || !this.musicEq) {
        this.musicEq?.destroy()
        this.musicEq = new SongEqBus(context, this.routableOutputChannels)
        this.eqChannels = this.routableOutputChannels
      } else { this.musicEq.setSpectrumActive(false); this.musicEq.output.disconnect() }
      this.outputMerger.connect(this.musicEq.input)
      this.musicEq.output.connect(this.master)
      // Output reconfiguration disconnects the analyser tap as well.
      this.musicEq.setSpectrumActive(false)
      this.musicEq.setSpectrumActive(this.spectrumActive)
      this.applyEq(true)
    } else this.outputMerger.connect(this.master)
    if (this.routableOutputChannels === 2) {
      this.master.connect(this.compressor).connect(arsenalDestination(context))
      // Keeps the 1-2 pair and the limiter, but skips the master gain.
      this.metronomeMerger.connect(this.compressor)
    } else {
      // DynamicsCompressorNode is limited to stereo by the Web Audio spec.
      this.master.connect(arsenalDestination(context))
      this.metronomeMerger.connect(arsenalDestination(context))
    }
    this.rebuildOutputRoutes()
  }

  private rebuildOutputRoutes(includeHidden = false): void {
    this.disconnectOutputRoutes()
    const merger = this.outputMerger
    if (!merger) return
    for (const stemType of STEM_ORDER) {
      if (!includeHidden && this.practice && this.song?.sourceFormat !== 'existing-stems' && !isStemVisible(stemType, this.practice.guitarSplitEnabled, this.practice.vocalSplitEnabled)) continue
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
      this.connectOutputRoute(this.auxiliaryOutputSplitter, 0, 0, this.metronomeMerger)
      this.connectOutputRoute(this.auxiliaryOutputSplitter, 1, 1, this.metronomeMerger)
    }
  }

  private connectOutputRoute(source: AudioNode, output: number, input: number, destination: AudioNode | null = this.outputMerger): void {
    if (!destination) return
    source.connect(destination, output, input)
    this.outputConnections.push({ source, destination, output, input })
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
    // Own level only; exponential ramps cannot target 0.
    const peak = Math.max(0.0001, (accented ? 0.28 : 0.18) * 2 * dbToGain(this.practice?.metronomeGainDb ?? 0))
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.003)
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

  private rampTrackGain(track: TrackAudio, value: number, duration: number): void {
    const now = this.context?.currentTime ?? 0, gain = track.gain.gain
    // Read before cancelling: cancelling an unfinished ramp can reset .value.
    const current = gain.value
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(current, now)
    gain.linearRampToValueAtTime(value, now + duration)
  }

  private resetMediaClocks(): void {
    for (const cancel of this.resyncs.values()) cancel()
    this.mediaClocks = new WeakMap()
    if (!this.practice) return
    for (const { element } of this.tracks.values()) {
      if (element.playbackRate !== this.practice.playbackRate) element.playbackRate = this.practice.playbackRate
    }
    for (const { element, take } of this.recordings.values()) {
      const rate = recordingPlaybackRate(take, this.practice)
      if (element.playbackRate !== rate) element.playbackRate = rate
    }
  }

  private synchronizeTrack(id: string, track: TrackAudio, anchor: HTMLAudioElement, anchorTime: number, timeScale = 1): void {
    const { element } = track, context = this.context
    if (!context || !this.practice || this.resyncs.has(element)) return
    const rate = this.practice.playbackRate / timeScale
    // Seeking/buffering timestamps cannot be used for clock correction. In
    // particular, another seek here can indefinitely restart the decoder.
    if (anchor.seeking || element.seeking || anchor.readyState < 3 || element.readyState < 3) {
      this.mediaClocks.delete(element)
      if (element.playbackRate !== rate) element.playbackRate = rate
      return
    }
    let clock = this.mediaClocks.get(element)
    if (!clock) { clock = createMediaClock(context.currentTime); this.mediaClocks.set(element, clock) }
    if (!followMediaClock(clock, (element.currentTime * timeScale - anchorTime) / this.practice.playbackRate, context.currentTime)) return

    // Only a sustained large offset needs a seek. Silence this track across
    // decoder repositioning; the anchor and the rest of the mix keep playing.
    this.rampTrackGain(track, 0, .008)
    let requested = false
    const finish = (): void => {
      clearTimeout(timer)
      element.removeEventListener('seeked', ready)
      element.removeEventListener('canplay', ready)
      element.removeEventListener('error', finish)
      this.resyncs.delete(element)
      const active = !('take' in track) || this.takeMatchesPractice((track as RecordingTrackAudio).take)
      const gain = active && this.song && this.practice ? practiceMix(this.song, this.practice).gains.get(id) ?? 0 : 0
      this.rampTrackGain(track, gain, .025)
    }
    const ready = (): void => { if (requested && !element.seeking && element.readyState >= 3) finish() }
    const timer = window.setTimeout(() => {
      if (anchor.paused || element.paused) { finish(); return }
      requested = true
      try { element.currentTime = anchor.currentTime / timeScale; ready() }
      catch (error) { finish(); this.errorListener?.(error) }
    }, 15)
    element.addEventListener('seeked', ready)
    element.addEventListener('canplay', ready)
    element.addEventListener('error', finish)
    this.resyncs.set(element, finish)
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
    for (const [id, track] of this.tracks) {
      if (!track.element.src || track.element === anchor || track.element.paused) continue
      this.synchronizeTrack(id, track, anchor, anchorTime)
    }
    for (const [id, recording] of this.recordings) {
      if (!this.takeMatchesPractice(recording.take) || recording.element.paused) continue
      this.synchronizeTrack(id, recording, anchor, anchorTime, recording.take.playbackRate)
    }
    for (const [id, meter] of this.meters) {
      meter.node.getFloatTimeDomainData(meter.data)
      let peak = 0; for (const sample of meter.data) peak = Math.max(peak, Math.abs(sample))
      publishTrackLevel(id, peak)
    }
    this.timeListener?.(anchorTime * 1000)
    this.frame = requestAnimationFrame(this.monitor)
  }

  private destroyTracks(): void {
    this.resetMediaClocks()
    for (const [id, job] of this.recordingLoads) { job.abort.abort(); setRecordingPlayback(id, null) }
    this.recordingLoads.clear()
    for (const meter of this.meters.values()) meter.node.disconnect()
    this.meters.clear(); clearTrackLevels()
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
    for (const [id, recording] of this.recordings) { this.disposeRecording(recording); setRecordingPlayback(id, null) }
    this.recordings.clear()
  }

  private takeMatchesPractice(take: RecordingTake): boolean {
    return Boolean(this.song?.recordingTracks.some(track => track.activeTakeId === take.id))
  }

  unload(): void {
    if (this.native) { this.nativeUnsubscribe?.(); this.nativeUnsubscribe = null; void window.bandbuddy.nativeAudio!.unload().catch(error => this.errorListener?.(error)); this.native = false; this.nativeResponse?.destroy(); this.nativeResponse = null }
    this.loadGeneration++
    this.pause()
    this.destroyTracks()
    this.song = null
    this.practice = null
  }

  destroy(): void {
    if (this.native) this.unload()
    this.loadGeneration++
    this.pause()
    this.pitchGeneration += 1
    this.destroyTracks()
    this.musicEq?.destroy(); this.recordingEq?.destroy(); this.eqResponse?.destroy()
    this.musicEq = null; this.recordingEq = null; this.eqResponse = null
    this.eqConfiguration = null; this.eqSignature = ''; this.eqChannels = 0
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
    this.recordingBus = null
    this.recordingDelay = null
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

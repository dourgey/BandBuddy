import type { TrackEffects, EffectChainSnapshot } from './arsenal.js'
export const LEGACY_STEM_ORDER = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] as const
export const GUITAR_SPLIT_STEMS = ['acoustic_guitar', 'lead_guitar', 'rhythm_guitar'] as const
export const STEM_ORDER = [
  'vocals', 'drums', 'bass', 'guitar',
  ...GUITAR_SPLIT_STEMS,
  'piano', 'other'
] as const
export type StemType = (typeof STEM_ORDER)[number]
export type StemStorageFormat = 'flac24' | 'mp3_320'

export function stemStorageFormat(highQualityStems: boolean): StemStorageFormat {
  return highQualityStems ? 'flac24' : 'mp3_320'
}

export function isStemVisible(stemType: StemType, guitarSplitEnabled: boolean): boolean {
  return guitarSplitEnabled
    ? stemType !== 'guitar'
    : !GUITAR_SPLIT_STEMS.includes(stemType as (typeof GUITAR_SPLIT_STEMS)[number])
}

export function visibleStemTypes(guitarSplitEnabled: boolean): StemType[] {
  return STEM_ORDER.filter((stemType) => isStemVisible(stemType, guitarSplitEnabled))
}

export function normalizeSelectedStemForGuitarMode(
  selectedStem: StemType | null,
  guitarSplitEnabled: boolean
): StemType | null {
  if (guitarSplitEnabled && selectedStem === 'guitar') return 'acoustic_guitar'
  if (!guitarSplitEnabled && selectedStem && GUITAR_SPLIT_STEMS.includes(selectedStem as (typeof GUITAR_SPLIT_STEMS)[number])) return 'guitar'
  return selectedStem
}

export const PLAYBACK_RATE_MIN = 0.2
export const PLAYBACK_RATE_MAX = 4
export const PITCH_SEMITONES_MIN = -12
export const PITCH_SEMITONES_MAX = 12
export const PITCH_SEMITONES_STEP = 1

export function normalizePitchSemitones(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(PITCH_SEMITONES_MIN, Math.min(PITCH_SEMITONES_MAX, Math.round(value)))
    : 0
}

export const METRONOME_OFFSET_MIN_MS = -3000
export const METRONOME_OFFSET_MAX_MS = 3000
export const DEFAULT_OUTPUT_CHANNEL_PAIR = 1
export const MAX_ROUTABLE_OUTPUT_CHANNELS = 32

export type ComputeDevice = 'auto' | 'cuda' | 'mps' | 'cpu'
export type GuitarSeparationQuality = 'fast' | 'balanced' | 'high'
export type GuitarSplitStatus = 'missing' | 'pending' | 'ready' | 'failed'
export type RuntimeStatus =
  | 'missing'
  | 'detecting'
  | 'installing'
  | 'downloadingModel'
  | 'verifying'
  | 'ready'
  | 'failed'

export type JobStatus =
  | 'queued'
  | 'blockedRuntime'
  | 'preparing'
  | 'separating'
  | 'postprocessing'
  | 'cancelling'
  | 'cancelled'
  | 'interrupted'
  | 'completed'
  | 'failed'

export type SongStatus = 'blockedRuntime' | 'queued' | 'processing' | 'ready' | 'failed'
export type ExportFormat = 'wav' | 'flac' | 'mp3'
export type AudioBackend = 'auto' | 'asio' | 'wasapi-exclusive' | 'wasapi-shared' | 'coreaudio'
export type RecordingPhase = 'idle' | 'preparing' | 'armed' | 'countIn' | 'recording' | 'stopping' | 'finalizing' | 'testing' | 'failed'

export const MUSICAL_KEY_TONICS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const
export type MusicalKeyTonic = (typeof MUSICAL_KEY_TONICS)[number]
export type MusicalKeyMode = 'major' | 'minor'
export type MusicalKeySource = 'detected' | 'manual'

export interface MusicalKeyCandidate {
  tonic: MusicalKeyTonic
  mode: MusicalKeyMode
  label: string
  confidence: number
}

export interface MusicalKeySegment extends MusicalKeyCandidate {
  startMs: number
  endMs: number
  possibleModulation: boolean
}

export interface MusicalKeyAnalysis extends MusicalKeyCandidate {
  lowConfidence: boolean
  candidates: MusicalKeyCandidate[]
  segments: MusicalKeySegment[]
  analyzedStems: StemType[]
  analyzedDurationMs: number
  analyzedAt: string
}

const MUSICAL_KEY_ALIASES: Record<string, MusicalKeyTonic> = {
  C: 'C', 'C#': 'C♯', DB: 'C♯', D: 'D', 'D#': 'E♭', EB: 'E♭', E: 'E',
  F: 'F', 'F#': 'F♯', GB: 'F♯', G: 'G', 'G#': 'A♭', AB: 'A♭', A: 'A',
  'A#': 'B♭', BB: 'B♭', B: 'B'
}

export function formatMusicalKey(tonic: MusicalKeyTonic, mode: MusicalKeyMode): string {
  return `${tonic} ${mode}`
}

export function parseMusicalKey(value: string | null | undefined): { tonic: MusicalKeyTonic; mode: MusicalKeyMode; label: string } | null {
  const normalized = value?.trim().replaceAll('♯', '#').replaceAll('♭', 'b')
  if (!normalized) return null
  const match = /^([A-Ga-g])([#b]?)(?:\s*(major|minor|maj|min|m))?$/i.exec(normalized)
  if (!match) return null
  const tonic = MUSICAL_KEY_ALIASES[`${match[1]!.toUpperCase()}${match[2]!.toUpperCase()}`]
  if (!tonic) return null
  const suffix = match[3]?.toLowerCase()
  const mode: MusicalKeyMode = suffix === 'm' || suffix === 'min' || suffix === 'minor' ? 'minor' : 'major'
  return { tonic, mode, label: formatMusicalKey(tonic, mode) }
}

export function transposeMusicalKey(value: string | null | undefined, semitones: number): string | null {
  const parsed = parseMusicalKey(value)
  if (!parsed) return value ?? null
  const tonicIndex = MUSICAL_KEY_TONICS.indexOf(parsed.tonic)
  const transposed = MUSICAL_KEY_TONICS[((tonicIndex + Math.round(semitones)) % 12 + 12) % 12]!
  return formatMusicalKey(transposed, parsed.mode)
}

export interface StemMeta {
  label: string
  shortLabel: string
  color: string
  icon: 'mic' | 'drums' | 'bass' | 'guitar' | 'piano' | 'other'
}

export const STEM_META: Record<StemType, StemMeta> = {
  vocals: { label: '人声', shortLabel: 'Vocal', color: '#a58a67', icon: 'mic' },
  drums: { label: '鼓组', shortLabel: 'Drums', color: '#718da9', icon: 'drums' },
  bass: { label: '贝斯', shortLabel: 'Bass', color: '#809779', icon: 'bass' },
  guitar: { label: '吉他', shortLabel: 'Guitar', color: '#b98358', icon: 'guitar' },
  acoustic_guitar: { label: '木吉他', shortLabel: 'Acoustic', color: '#c69763', icon: 'guitar' },
  lead_guitar: { label: '主音吉他', shortLabel: 'Lead', color: '#c36f54', icon: 'guitar' },
  rhythm_guitar: { label: '节奏吉他', shortLabel: 'Rhythm', color: '#9b755d', icon: 'guitar' },
  piano: { label: '钢琴', shortLabel: 'Piano', color: '#8c819f', icon: 'piano' },
  other: { label: '其他', shortLabel: 'Other', color: '#8d8982', icon: 'other' }
}

export interface TrackState {
  stemType: StemType
  gainDb: number
  muted: boolean
  solo: boolean
  /** One-based first channel of a stereo pair: 1 => 1–2, 3 => 3–4. */
  outputChannelPair: number
}

export function isValidOutputChannelPair(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= DEFAULT_OUTPUT_CHANNEL_PAIR
    && (value as number) < MAX_ROUTABLE_OUTPUT_CHANNELS
    && (value as number) % 2 === 1
}

export function normalizeTrackStates(
  savedTracks: readonly Partial<TrackState>[] | null | undefined
): TrackState[] {
  const byStem = new Map<StemType, Partial<TrackState>>()
  for (const track of savedTracks ?? []) {
    if (!track.stemType || !STEM_ORDER.includes(track.stemType)) continue
    byStem.set(track.stemType, track)
  }
  return STEM_ORDER.map((stemType) => {
    const saved = byStem.get(stemType)
    return {
      stemType,
      gainDb: saved?.gainDb ?? 0,
      muted: saved?.muted ?? false,
      solo: saved?.solo ?? false,
      outputChannelPair: isValidOutputChannelPair(saved?.outputChannelPair)
        ? saved.outputChannelPair
        : DEFAULT_OUTPUT_CHANNEL_PAIR
    }
  })
}

export type TrackOrderKey = `stem:${StemType}` | `recording:${string}`

export function stemTrackOrderKey(stemType: StemType): TrackOrderKey {
  return `stem:${stemType}`
}

export function recordingTrackOrderKey(recordingTrackId: string): TrackOrderKey {
  return `recording:${recordingTrackId}`
}

export function getStemTypeFromTrackOrderKey(key: string): StemType | null {
  if (!key.startsWith('stem:')) return null
  const stemType = key.slice('stem:'.length) as StemType
  return STEM_ORDER.includes(stemType) ? stemType : null
}

export function isTrackOrderKey(value: unknown): value is TrackOrderKey {
  if (typeof value !== 'string') return false
  if (getStemTypeFromTrackOrderKey(value)) return true
  return /^recording:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function normalizeTrackOrder(
  savedOrder: readonly string[] | null | undefined,
  recordingTrackIds: readonly string[]
): TrackOrderKey[] {
  const available = [
    ...STEM_ORDER.map(stemTrackOrderKey),
    ...recordingTrackIds.map(recordingTrackOrderKey)
  ]
  const availableKeys = new Set<TrackOrderKey>(available)
  const seen = new Set<TrackOrderKey>()
  const normalized: TrackOrderKey[] = []
  for (const key of savedOrder ?? []) {
    if (!isTrackOrderKey(key) || !availableKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    normalized.push(key)
  }
  const splitKeys = GUITAR_SPLIT_STEMS.map(stemTrackOrderKey)
  for (const [splitIndex, key] of splitKeys.entries()) {
    if (seen.has(key)) continue
    const predecessor = splitIndex === 0 ? stemTrackOrderKey('guitar') : splitKeys[splitIndex - 1]!
    const predecessorIndex = normalized.indexOf(predecessor)
    if (predecessorIndex < 0) continue
    seen.add(key)
    normalized.splice(predecessorIndex + 1, 0, key)
  }
  for (const key of available) {
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(key)
  }
  return normalized
}

export function moveTrackOrder(
  order: readonly TrackOrderKey[],
  movingKey: TrackOrderKey,
  targetKey: TrackOrderKey,
  placement: 'before' | 'after'
): TrackOrderKey[] {
  if (movingKey === targetKey || !order.includes(movingKey) || !order.includes(targetKey)) return [...order]
  const next = order.filter((key) => key !== movingKey)
  const targetIndex = next.indexOf(targetKey)
  next.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, movingKey)
  return next
}

export interface PracticeState {
  songId: string
  positionMs: number
  playbackRate: number
  pitchSemitones: number
  masterGainDb: number
  metronomeEnabled: boolean
  metronomeBpm: number
  metronomeOffsetMs: number
  desktopLyricsEnabled: boolean
  guitarSplitEnabled: boolean
  countInBeats: 0 | 4 | 8
  loopStartMs: number | null
  loopEndMs: number | null
  loopEnabled: boolean
  zoom: number
  scroll: number
  selectedStem: StemType | null
  tracks: TrackState[]
  trackOrder: TrackOrderKey[]
  updatedAt: string
}

export interface StemRecord {
  name?: string | null
  id: string
  songId: string
  separationId: string
  type: StemType
  durationMs: number
  sampleRate: number
  channels: number
  mediaUrl: string
  peaksUrl: string | null
}

export interface SongSummary {
  id: string
  title: string
  artist: string
  durationMs: number
  artworkUrl: string | null
  favorite: boolean
  status: SongStatus
  progress: number
  phase: string | null
  stemTypes: StemType[]
  stemNames?: Partial<Record<StemType, string>>
  guitarSplitStatus: GuitarSplitStatus
  createdAt: string
  updatedAt: string
  lastPracticedAt: string | null
}

export interface LyricCue {
  timeMs: number
  lines: string[]
}

export interface LyricsDocument {
  fileName: string
  title: string | null
  artist: string | null
  album: string | null
  cues: LyricCue[]
}

export interface DesktopLyricsPayload {
  fontSize?: number
  title: string
  artist: string
  currentLines: string[]
  nextLines: string[]
  progress: number
  playing: boolean
}

export interface SongDetail extends SongSummary {
  bpm: number | null
  beatOffsetMs: number
  musicalKey: string | null
  musicalKeySource: MusicalKeySource | null
  keyAnalysis: MusicalKeyAnalysis | null
  timeSignature: string | null
  sourceFormat: string | null
  videoUrl: string | null
  sampleRate: number | null
  channels: number | null
  lyrics: LyricsDocument | null
  stems: StemRecord[]
  practice: PracticeState
  recordingTakes: RecordingTake[]
  recordingTracks: RecordingTrackState[]
}

export interface RecordingTake {
  effectsSnapshot?: EffectChainSnapshot | null
  id: string
  songId: string
  recordingTrackId: string
  name: string
  durationMs: number
  startPositionMs: number
  endPositionMs: number
  playbackRate: number
  pitchSemitones: number
  sampleRate: number
  channels: number
  alignmentOffsetMs: number
  backend: Exclude<AudioBackend, 'auto'>
  inputDeviceName: string
  inputChannels: number[]
  deviceSnapshot: RecordingDeviceSnapshot
  sourceMediaUrl: string
  previewMediaUrl: string
  peaksUrl: string | null
  interrupted: boolean
  createdAt: string
}

export interface RecordingDeviceSnapshot {
  backend: Exclude<AudioBackend, 'auto'>
  inputDeviceId: string
  inputDeviceName: string
  outputDeviceId: string
  outputDeviceName: string
  inputChannels: number[]
  sampleRate: number
  bufferFrames: number
  latencyMs: number
  splitDevices: boolean
  softwareMonitoring: boolean
}

export interface RecordingTrackState {
  effects?: TrackEffects | null
  id: string
  songId: string
  name: string
  activeTakeId: string | null
  gainDb: number
  muted: boolean
  solo: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface RecordingDeviceInfo {
  id: string
  backend: Exclude<AudioBackend, 'auto'>
  name: string
  inputChannels: number
  outputChannels: number
  duplexChannels: number
  sampleRates: number[]
  preferredSampleRate: number
  defaultInput: boolean
  defaultOutput: boolean
}

export interface RecordingAudioSettings {
  backend: AudioBackend
  inputDeviceId: string
  outputDeviceId: string
  inputChannelMode: 'mono' | 'stereo'
  inputChannels: number[]
  sampleRate: number
  bufferFrames: number
  alignmentOffsetMs: number
  deviceAlignmentOffsets: Record<string, number>
}

export interface RecordingState {
  target: 'song'
  phase: RecordingPhase
  sessionId: string | null
  songId: string | null
  recordingTrackId: string | null
  sourcePositionMs: number
  countInRemaining: number
  sampleRate: number
  bufferFrames: number
  latencyMs: number
  xruns: number
  splitDevices: boolean
  message: string
  error: string | null
}

export interface RecordingMeter {
  peak: number[]
  rms: number[]
  clipped: boolean
  sourcePositionMs: number
  recording: boolean
}

export interface RecordingStartRequest {
  songId: string
  recordingTrackId: string
  positionMs: number
  practice: PracticeState
}

export interface JobRecord {
  id: string
  songId: string | null
  type: 'separate' | 'guitarSplit' | 'normalizeStems' | 'export' | 'runtimeInstall'
  status: JobStatus
  phase: string
  progress: number
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface GpuInfo {
  name: string
  driverVersion: string
  memoryMb: number
}

export interface RuntimeInfo {
  status: RuntimeStatus
  stage: string
  progress: number | null
  device: ComputeDevice
  selectedDevice: Exclude<ComputeDevice, 'auto'>
  gpu: GpuInfo | null
  windowsVcRuntimeVersion: string | null
  pythonVersion: string | null
  torchVersion: string | null
  cudaVersion: string | null
  modelReady: boolean
  runtimePath: string
  modelPath: string
  error: string | null
}

export interface MediaCapabilities {
  ffmpegReady: boolean
  ffmpegVersion: string
  protocolVersion: number
  supportedInputFormats: string[]
  supportedExportFormats: ExportFormat[]
  internalSampleRate: number
  internalChannels: number
  internalBitDepth: number
}

export interface BpmDetectionResult {
  bpm: number
  confidence: number
  beatOffsetMs: number
  analyzedStem: StemType
}

export interface NetworkSettings {
  proxyMode: 'system' | 'manual' | 'none'
  proxyUrl: string
  pythonInstallMirror: string
  pythonIndexUrl: string
  pytorchIndexUrl: string
}

export interface AppSettings {
  desktopLyricsFontSize: number
  libraryRoot: string
  runtimeRoot: string
  modelRoot: string
  debugMode: boolean
  preferredDevice: ComputeDevice
  audioOutputDeviceId: string
  latencyMode: 'interactive' | 'balanced' | 'playback'
  recordingAudio: RecordingAudioSettings
  keepSource: boolean
  closeToTrayWhileWorking: boolean
  highQualityStems: boolean
  guitarSeparationQuality: GuitarSeparationQuality
  network: NetworkSettings
}

export interface StoragePaths {
  dataRoot: string
  libraryRoot: string
  runtimeRoot: string
  modelRoot: string
}

export interface ImportStemsOptions {
  files: Array<{ path: string; type: StemType; name: string }>
  title?: string
  artist?: string
  padMismatched?: boolean
}

export interface LanStatus {
  enabled: boolean
  port: number | null
  urls: string[]
  error: string | null
}

export interface ImportSourceOptions {
  filePath?: string
  title?: string
  artist?: string
  forceDuplicate?: boolean
}

export interface SourceChoice {
  path: string
  name: string
  inferredTitle: string
}

export interface ImportResult {
  songId: string | null
  jobId: string | null
  duplicate: SongSummary | null
  needsPadding?: boolean
  durationDifferenceMs?: number
}

export interface ExportRequest {
  songId: string
  kind: 'stems' | 'mix'
  format: ExportFormat
  stemTypes: StemType[]
  outputPath?: string
  applyPlaybackRate: boolean
  playbackRate: number
  applyPitchShift: boolean
  pitchSemitones: number
  applyLoopRange: boolean
  loopStartMs: number | null
  loopEndMs: number | null
  overwriteMode: 'ask' | 'overwrite' | 'rename'
  includeActiveTake: boolean
}

export interface ExportResult {
  jobId: string
  outputPaths: string[]
}

export function createDefaultPracticeState(songId: string): PracticeState {
  return {
    songId,
    positionMs: 0,
    playbackRate: 1,
    pitchSemitones: 0,
    masterGainDb: 0,
    metronomeEnabled: false,
    metronomeBpm: 120,
    metronomeOffsetMs: 0,
    desktopLyricsEnabled: false,
    guitarSplitEnabled: false,
    countInBeats: 0,
    loopStartMs: null,
    loopEndMs: null,
    loopEnabled: false,
    zoom: 1,
    scroll: 0,
    selectedStem: 'vocals',
    tracks: normalizeTrackStates(null),
    trackOrder: STEM_ORDER.map(stemTrackOrderKey),
    updatedAt: new Date(0).toISOString()
  }
}

export function createDefaultRecordingTrackState(
  songId: string,
  id: string,
  name = '录音轨 1',
  sortOrder = 0
): RecordingTrackState {
  const timestamp = new Date(0).toISOString()
  return {
    id,
    songId,
    name,
    activeTakeId: null,
    gainDb: 0,
    muted: false,
    solo: false,
    sortOrder,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

export function createDefaultRecordingAudioSettings(): RecordingAudioSettings {
  return {
    backend: 'auto',
    inputDeviceId: '',
    outputDeviceId: '',
    inputChannelMode: 'mono',
    inputChannels: [0],
    sampleRate: 0,
    bufferFrames: 0,
    alignmentOffsetMs: 0,
    deviceAlignmentOffsets: {}
  }
}

export function normalizeBeatOffsetMs(offsetMs: number, bpm: number): number {
  if (!Number.isFinite(offsetMs) || !Number.isFinite(bpm) || bpm <= 0) return 0
  const beatDurationMs = 60_000 / bpm
  const normalized = ((offsetMs + beatDurationMs / 2) % beatDurationMs + beatDurationMs) % beatDurationMs - beatDurationMs / 2
  return Object.is(normalized, -0) ? 0 : normalized
}

export function visibleTrackStates(
  tracks: readonly TrackState[],
  guitarSplitEnabled: boolean
): TrackState[] {
  return tracks.filter((track) => isStemVisible(track.stemType, guitarSplitEnabled))
}

export function isTrackAudible(
  track: TrackState,
  allTracks: readonly TrackState[],
  guitarSplitEnabled = false
): boolean {
  if (!isStemVisible(track.stemType, guitarSplitEnabled)) return false
  if (track.muted) return false
  const hasSolo = allTracks.some((candidate) =>
    isStemVisible(candidate.stemType, guitarSplitEnabled) && candidate.solo && !candidate.muted
  )
  return !hasSolo || track.solo
}

/** Levels at or below this are exactly zero: the domain's silence floor. */
export const SILENT_GAIN_DB = -60

export function dbToGain(db: number): number {
  if (!Number.isFinite(db) || db <= SILENT_GAIN_DB) return 0
  return 10 ** (db / 20)
}

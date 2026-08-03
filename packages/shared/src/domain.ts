export const STEM_ORDER = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] as const
export type StemType = (typeof STEM_ORDER)[number]

export const PLAYBACK_RATE_MIN = 0.2
export const PLAYBACK_RATE_MAX = 4
export const METRONOME_OFFSET_MIN_MS = -3000
export const METRONOME_OFFSET_MAX_MS = 3000

export type ComputeDevice = 'auto' | 'cuda' | 'mps' | 'cpu'
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
  piano: { label: '钢琴', shortLabel: 'Piano', color: '#8c819f', icon: 'piano' },
  other: { label: '其他', shortLabel: 'Other', color: '#8d8982', icon: 'other' }
}

export interface TrackState {
  stemType: StemType
  gainDb: number
  muted: boolean
  solo: boolean
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
  masterGainDb: number
  metronomeEnabled: boolean
  metronomeBpm: number
  metronomeOffsetMs: number
  desktopLyricsEnabled: boolean
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
  timeSignature: string | null
  sourceFormat: string | null
  sampleRate: number | null
  channels: number | null
  lyrics: LyricsDocument | null
  stems: StemRecord[]
  practice: PracticeState
  recordingTakes: RecordingTake[]
  recordingTracks: RecordingTrackState[]
}

export interface RecordingTake {
  id: string
  songId: string
  recordingTrackId: string
  name: string
  durationMs: number
  startPositionMs: number
  endPositionMs: number
  playbackRate: number
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
  type: 'separate' | 'normalizeStems' | 'export' | 'runtimeInstall'
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
  pythonVersion: string | null
  torchVersion: string | null
  cudaVersion: string | null
  demucsVersion: string | null
  modelReady: boolean
  modelRevision: string
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
  modelBaseUrl: string
}

export interface AppSettings {
  libraryRoot: string
  runtimeRoot: string
  modelRoot: string
  preferredDevice: ComputeDevice
  audioOutputDeviceId: string
  latencyMode: 'interactive' | 'balanced' | 'playback'
  recordingAudio: RecordingAudioSettings
  keepSource: boolean
  closeToTrayWhileWorking: boolean
  network: NetworkSettings
}

export interface StoragePaths {
  dataRoot: string
  libraryRoot: string
  runtimeRoot: string
  modelRoot: string
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

export interface StemChoice {
  path: string
  name: string
  inferredType: StemType | null
}

export interface ImportResult {
  songId: string | null
  jobId: string | null
  duplicate: SongSummary | null
  needsPadding: boolean
  durationDifferenceMs: number
  warnings: string[]
}

export interface ExistingStemInput {
  path: string
  type: StemType
}

export interface ImportStemsOptions {
  files?: ExistingStemInput[]
  folderPath?: string
  title?: string
  artist?: string
  padMismatched?: boolean
}

export interface ExportRequest {
  songId: string
  kind: 'stems' | 'mix'
  format: ExportFormat
  stemTypes: StemType[]
  outputPath?: string
  applyPlaybackRate: boolean
  playbackRate: number
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
    masterGainDb: 0,
    metronomeEnabled: false,
    metronomeBpm: 120,
    metronomeOffsetMs: 0,
    desktopLyricsEnabled: false,
    countInBeats: 0,
    loopStartMs: null,
    loopEndMs: null,
    loopEnabled: false,
    zoom: 1,
    scroll: 0,
    selectedStem: 'vocals',
    tracks: STEM_ORDER.map((stemType) => ({ stemType, gainDb: 0, muted: false, solo: false })),
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

export function isTrackAudible(track: TrackState, allTracks: readonly TrackState[]): boolean {
  if (track.muted) return false
  const hasSolo = allTracks.some((candidate) => candidate.solo && !candidate.muted)
  return !hasSolo || track.solo
}

export function dbToGain(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0
  return 10 ** (db / 20)
}

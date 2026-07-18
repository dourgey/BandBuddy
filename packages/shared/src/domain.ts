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

export interface PracticeState {
  songId: string
  positionMs: number
  playbackRate: number
  masterGainDb: number
  metronomeEnabled: boolean
  metronomeBpm: number
  metronomeOffsetMs: number
  countInBeats: 0 | 4 | 8
  loopStartMs: number | null
  loopEndMs: number | null
  loopEnabled: boolean
  zoom: number
  scroll: number
  selectedStem: StemType | null
  tracks: TrackState[]
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

export interface SongDetail extends SongSummary {
  bpm: number | null
  beatOffsetMs: number
  musicalKey: string | null
  timeSignature: string | null
  sourceFormat: string | null
  sampleRate: number | null
  channels: number | null
  stems: StemRecord[]
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
  pythonIndexUrl: string
  pytorchIndexUrl: string
}

export interface AppSettings {
  libraryRoot: string
  runtimeRoot: string
  modelRoot: string
  preferredDevice: ComputeDevice
  audioOutputDeviceId: string
  latencyMode: 'interactive' | 'balanced' | 'playback'
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
    countInBeats: 0,
    loopStartMs: null,
    loopEndMs: null,
    loopEnabled: false,
    zoom: 1,
    scroll: 0,
    selectedStem: 'vocals',
    tracks: STEM_ORDER.map((stemType) => ({ stemType, gainDb: 0, muted: false, solo: false })),
    updatedAt: new Date(0).toISOString()
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

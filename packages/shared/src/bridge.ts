import type {
  AppSettings,
  BpmDetectionResult,
  DesktopLyricsPayload,
  ExportFormat,
  ExportRequest,
  ExportResult,
  ImportResult,
  ImportSourceOptions,
  ImportStemsOptions,
  JobRecord,
  MediaCapabilities,
  PracticeState,
  RecordingDeviceInfo,
  RecordingMeter,
  RecordingStartRequest,
  RecordingState,
  RecordingTake,
  RecordingTrackState,
  RuntimeInfo,
  SongDetail,
  SongSummary,
  SourceChoice,
  StemChoice,
  StoragePaths
} from './domain.js'
import type {
  RehearsalRecordingStartRequest,
  RehearsalRecordingState,
  RehearsalRecordingTake,
  RehearsalRecordingTrackState,
  RehearsalSetDetail,
  RehearsalSetSummary,
  SaveRehearsalRequest
} from './rehearsal.js'

export type Unsubscribe = () => void

export interface BandBuddyApi {
  library: {
    list(input?: { query?: string; filter?: 'all' | 'favorite' | 'processing' | 'recent' }): Promise<SongSummary[]>
    get(songId: string): Promise<SongDetail | null>
    chooseSource(): Promise<SourceChoice | null>
    chooseStems(mode?: 'files' | 'folder'): Promise<StemChoice[]>
    importSource(options: ImportSourceOptions): Promise<ImportResult>
    importStems(options: ImportStemsOptions): Promise<ImportResult>
    importLyrics(songId: string): Promise<SongDetail | null>
    update(input: { id: string; patch: { title?: string; artist?: string; favorite?: boolean; bpm?: number | null; beatOffsetMs?: number; musicalKey?: string | null; timeSignature?: string | null } }): Promise<SongDetail>
    delete(songId: string): Promise<void>
    openLocation(songId: string): Promise<void>
    reSeparate(songId: string): Promise<string>
    savePractice(state: PracticeState): Promise<void>
    onChanged(callback: () => void): Unsubscribe
  }
  tasks: {
    list(): Promise<JobRecord[]>
    cancel(jobId: string): Promise<void>
    retry(jobId: string, useCpu?: boolean): Promise<void>
    clearFinished(): Promise<void>
    onChanged(callback: () => void): Unsubscribe
  }
  runtime: {
    get(): Promise<RuntimeInfo>
    detect(): Promise<RuntimeInfo>
    install(): Promise<RuntimeInfo>
    cancel(): Promise<void>
    repair(): Promise<RuntimeInfo>
    remove(includeModels?: boolean): Promise<void>
    clearModel(): Promise<void>
    onChanged(callback: (runtime: RuntimeInfo) => void): Unsubscribe
  }
  settings: {
    get(): Promise<AppSettings>
    chooseDataRoot(currentLibraryRoot?: string): Promise<StoragePaths | null>
    update(settings: AppSettings): Promise<AppSettings>
    onChanged(callback: (settings: AppSettings) => void): Unsubscribe
  }
  media: {
    capabilities(): Promise<MediaCapabilities>
    detectBpm(songId: string): Promise<BpmDetectionResult>
    onChanged(callback: (capabilities: MediaCapabilities) => void): Unsubscribe
  }
  export: {
    choosePath(kind: 'stems' | 'mix', format: ExportFormat, songTitle: string): Promise<string | null>
    start(request: ExportRequest): Promise<ExportResult>
  }
  recording: {
    state(): Promise<RecordingState>
    devices(): Promise<RecordingDeviceInfo[]>
    startTest(): Promise<void>
    stopTest(): Promise<void>
    start(request: RecordingStartRequest): Promise<{ sessionId: string }>
    stop(): Promise<RecordingTake | null>
    cancel(): Promise<void>
    updateTake(input: { takeId: string; name?: string; alignmentOffsetMs?: number }): Promise<RecordingTake>
    deleteTake(takeId: string): Promise<void>
    selectTake(input: { recordingTrackId: string; takeId: string | null }): Promise<void>
    createTrack(songId: string): Promise<RecordingTrackState>
    updateTrack(input: {
      recordingTrackId: string
      patch: Partial<Pick<RecordingTrackState, 'name' | 'gainDb' | 'muted' | 'solo'>>
    }): Promise<RecordingTrackState>
    onState(callback: (state: RecordingState) => void): Unsubscribe
    onMeter(callback: (meter: RecordingMeter) => void): Unsubscribe
  }
  rehearsals: {
    list(): Promise<RehearsalSetSummary[]>
    get(rehearsalId: string): Promise<RehearsalSetDetail | null>
    create(name?: string): Promise<RehearsalSetDetail>
    save(request: SaveRehearsalRequest): Promise<RehearsalSetDetail>
    duplicate(input: { rehearsalId: string; revisionId?: string }): Promise<RehearsalSetDetail>
    delete(rehearsalId: string): Promise<void>
    createTrack(rehearsalId: string): Promise<RehearsalRecordingTrackState>
    updateTrack(input: {
      recordingTrackId: string
      patch: Partial<Pick<RehearsalRecordingTrackState, 'name' | 'gainDb' | 'muted' | 'solo'>>
    }): Promise<RehearsalRecordingTrackState>
    selectTake(input: { recordingTrackId: string; takeId: string | null }): Promise<void>
    updateTake(input: { takeId: string; name?: string; alignmentOffsetMs?: number }): Promise<RehearsalRecordingTake>
    deleteTake(takeId: string): Promise<void>
    recordingState(): Promise<RehearsalRecordingState>
    startRecording(request: RehearsalRecordingStartRequest): Promise<{ sessionId: string }>
    pauseRecording(): Promise<void>
    resumeRecording(): Promise<void>
    stopRecording(): Promise<RehearsalRecordingTake | null>
    cancelRecording(): Promise<void>
    onChanged(callback: () => void): Unsubscribe
    onRecordingState(callback: (state: RehearsalRecordingState) => void): Unsubscribe
    onMeter(callback: (meter: RecordingMeter) => void): Unsubscribe
  }
  desktopLyrics: {
    setVisible(visible: boolean): Promise<void>
    update(payload: DesktopLyricsPayload): void
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<boolean>
    close(): Promise<void>
    onHidden(callback: () => void): Unsubscribe
  }
}

export interface DesktopLyricsRendererApi {
  onUpdate(callback: (payload: DesktopLyricsPayload) => void): Unsubscribe
}

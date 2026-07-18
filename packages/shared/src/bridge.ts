import type {
  AppSettings,
  BpmDetectionResult,
  ExportFormat,
  ExportRequest,
  ExportResult,
  ImportResult,
  ImportSourceOptions,
  ImportStemsOptions,
  JobRecord,
  MediaCapabilities,
  PracticeState,
  RuntimeInfo,
  SongDetail,
  SongSummary,
  SourceChoice,
  StemChoice,
  StoragePaths
} from './domain.js'

export type Unsubscribe = () => void

export interface BandBuddyApi {
  library: {
    list(input?: { query?: string; filter?: 'all' | 'favorite' | 'processing' | 'recent' }): Promise<SongSummary[]>
    get(songId: string): Promise<SongDetail | null>
    chooseSource(): Promise<SourceChoice | null>
    chooseStems(mode?: 'files' | 'folder'): Promise<StemChoice[]>
    importSource(options: ImportSourceOptions): Promise<ImportResult>
    importStems(options: ImportStemsOptions): Promise<ImportResult>
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
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<boolean>
    close(): Promise<void>
    onHidden(callback: () => void): Unsubscribe
  }
}

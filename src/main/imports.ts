import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { copyFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { dialog, shell } from 'electron'
import type {
  ImportResult,
  ImportSourceOptions,
  ImportStemsOptions,
  SourceChoice,
  StemChoice,
  StemType
} from '@shared/domain.js'
import type { BandBuddyDatabase } from './database.js'
import type { Logger } from './logger.js'
import type { MediaService } from './media.js'
import type { AppPaths } from './paths.js'
import type { RuntimeManager } from './runtime.js'
import { inferStemType } from './stem-detection.js'

export { inferStemType } from './stem-detection.js'

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac'])
export const SOURCE_AUDIO_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, '.ncm'])

async function sha256(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

export class ImportService {
  constructor(
    private readonly paths: AppPaths,
    private readonly database: BandBuddyDatabase,
    private readonly media: MediaService,
    private readonly runtime: RuntimeManager,
    private readonly logger: Logger,
    private readonly changed: () => void,
    private readonly kickJobs: () => void
  ) {}

  async chooseSource(): Promise<SourceChoice | null> {
    const result = await dialog.showOpenDialog({
      title: '导入歌曲',
      properties: ['openFile'],
      filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ncm'] }]
    })
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return null
    return { path: filePath, name: path.basename(filePath), inferredTitle: path.basename(filePath, path.extname(filePath)) }
  }

  async chooseStems(mode: 'files' | 'folder' = 'files'): Promise<StemChoice[]> {
    const result = await dialog.showOpenDialog({
      title: mode === 'folder' ? '选择分轨文件夹' : '选择分轨文件',
      properties: mode === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
      ...(mode === 'files' ? { filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac'] }] } : {})
    })
    if (result.canceled) return []
    let files = result.filePaths
    if (mode === 'folder' && files[0]) {
      const entries = await readdir(files[0], { withFileTypes: true })
      files = entries.filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => path.join(files[0]!, entry.name))
    }
    return files.map((filePath) => ({ path: filePath, name: path.basename(filePath), inferredType: inferStemType(filePath) }))
  }

  async importSource(options: ImportSourceOptions): Promise<ImportResult> {
    const selected = options.filePath ? { path: options.filePath } : await this.chooseSource()
    if (!selected) return this.emptyResult()
    const sourcePath = path.resolve(selected.path)
    await this.validateAudioFile(sourcePath, SOURCE_AUDIO_EXTENSIONS)
    const sourceHash = await sha256(sourcePath)
    const duplicate = this.database.findBySourceHash(sourceHash)
    if (duplicate && !options.forceDuplicate) {
      return { ...this.emptyResult(), duplicate }
    }

    const songId = randomUUID()
    const settings = this.database.getSettings()
    const songRoot = this.paths.songDirectory(settings.libraryRoot, songId)
    const sourceRoot = path.join(songRoot, 'source')
    mkdirSync(sourceRoot, { recursive: true })
    const selectedExtension = path.extname(sourcePath).toLowerCase()
    const extension = selectedExtension === '.ncm' ? '.mp3' : selectedExtension
    const copiedSource = path.join(sourceRoot, `original${extension}`)
    if (selectedExtension === '.ncm') {
      await this.media.convertNcmToMp3(
        sourcePath,
        path.join(sourceRoot, 'decoded.part'),
        path.join(sourceRoot, 'original.part.mp3'),
        copiedSource
      )
    } else {
      await copyFile(sourcePath, copiedSource)
      if (await sha256(copiedSource) !== sourceHash) throw new Error('SOURCE_COPY_HASH_MISMATCH')
    }
    const probe = await this.media.probe(copiedSource)

    let artworkRelPath: string | null = null
    const artwork = path.join(songRoot, 'artwork', 'cover.jpg')
    if (await this.media.extractArtwork(copiedSource, artwork)) artworkRelPath = this.paths.toLibraryRelative(settings.libraryRoot, artwork)
    const runtimeReady = this.runtime.getInfo().status === 'ready'
    this.database.createSong({
      title: options.title?.trim() || probe.title || path.basename(sourcePath, selectedExtension),
      artist: options.artist?.trim() || probe.artist || '',
      sourceRelPath: this.paths.toLibraryRelative(settings.libraryRoot, copiedSource),
      sourceHash,
      sourceFormat: probe.format ?? extension.slice(1),
      durationMs: probe.durationMs,
      sampleRate: probe.sampleRate,
      channels: probe.channels,
      artworkRelPath,
      status: runtimeReady ? 'queued' : 'blockedRuntime',
      phase: runtimeReady ? '等待分离' : '需要安装分离环境'
    }, songId)
    const jobId = this.database.createJob(
      'separate', songId, runtimeReady ? 'queued' : 'blockedRuntime',
      runtimeReady ? '等待分离' : '等待安装本地环境',
      { sourceRelPath: this.paths.toLibraryRelative(settings.libraryRoot, copiedSource), segment: 7, retry: 0 }
    )
    this.logger.info('source imported', { songId, extension, sourceHash })
    this.changed()
    this.kickJobs()
    return { songId, jobId, duplicate: null, needsPadding: false, durationDifferenceMs: 0, warnings: [] }
  }

  async importStems(options: ImportStemsOptions): Promise<ImportResult> {
    let files = options.files ?? []
    if (!files.length && options.folderPath) {
      const choices = await this.filesFromFolder(options.folderPath)
      files = choices.filter((choice): choice is StemChoice & { inferredType: StemType } => Boolean(choice.inferredType))
        .map((choice) => ({ path: choice.path, type: choice.inferredType }))
    }
    if (files.length < 2) throw new Error('AT_LEAST_TWO_STEMS_REQUIRED')
    const unique = new Set(files.map((file) => file.type))
    if (unique.size !== files.length) throw new Error('DUPLICATE_STEM_TYPE')
    for (const file of files) await this.validateAudioFile(file.path)

    const probes = await Promise.all(files.map(async (file) => ({ file, probe: await this.media.probe(file.path) })))
    const durations = probes.map(({ probe }) => probe.durationMs).filter((duration) => duration > 0)
    const difference = durations.length ? Math.max(...durations) - Math.min(...durations) : 0
    const leadingSilences = await Promise.all(files.map((file) => this.media.leadingSilenceMs(file.path)))
    const measuredSilences = leadingSilences.filter((value): value is number => value !== null)
    const warnings: string[] = []
    if (measuredSilences.length > 1 && Math.max(...measuredSilences) - Math.min(...measuredSilences) > 250) {
      warnings.push('检测到音轨前导静音偏移；BandBuddy 不会自动移动或猜测性对齐音轨')
    }
    if (difference > 500 && !options.padMismatched) {
      return { ...this.emptyResult(), needsPadding: true, durationDifferenceMs: difference, warnings: [...warnings, '各轨时长相差超过 500 ms，需要确认补静音'] }
    }

    const songId = randomUUID()
    const settings = this.database.getSettings()
    const songRoot = this.paths.songDirectory(settings.libraryRoot, songId)
    const rawRoot = path.join(songRoot, 'source-stems')
    mkdirSync(rawRoot, { recursive: true })
    const payloadFiles: Array<{ type: StemType; relPath: string }> = []
    for (const { file } of probes) {
      const extension = path.extname(file.path).toLowerCase()
      const destination = path.join(rawRoot, `${file.type}${extension}`)
      await copyFile(file.path, destination)
      payloadFiles.push({ type: file.type, relPath: this.paths.toLibraryRelative(settings.libraryRoot, destination) })
    }
    const commonRoot = options.folderPath ?? path.dirname(files[0]!.path)
    this.database.createSong({
      title: options.title?.trim() || path.basename(commonRoot),
      artist: options.artist?.trim() || '',
      sourceRelPath: null,
      sourceHash: null,
      sourceFormat: 'existing-stems',
      durationMs: durations.length ? Math.max(...durations) : 0,
      sampleRate: null,
      channels: null,
      artworkRelPath: null,
      status: 'queued',
      phase: '等待标准化分轨'
    }, songId)
    const jobId = this.database.createJob('normalizeStems', songId, 'queued', '等待标准化分轨', {
      files: payloadFiles,
      targetDurationMs: durations.length ? Math.max(...durations) : 0,
      padMismatched: Boolean(options.padMismatched)
    })
    this.changed()
    this.kickJobs()
    return { songId, jobId, duplicate: null, needsPadding: false, durationDifferenceMs: difference, warnings }
  }

  async deleteSong(songId: string, cancelSongJobs: (songId: string) => Promise<void>): Promise<void> {
    const row = this.database.getSongRow(songId)
    if (!row) return
    await cancelSongJobs(songId)
    const settings = this.database.getSettings()
    const directory = this.paths.songDirectory(settings.libraryRoot, songId)
    if (existsSync(directory)) await shell.trashItem(directory)
    this.database.deleteSongRecord(songId)
    this.changed()
  }

  reSeparate(songId: string): string {
    const row = this.database.getSongRow(songId)
    if (!row) throw new Error('SONG_NOT_FOUND')
    if (!row.source_rel_path) throw new Error('ORIGINAL_SOURCE_NOT_AVAILABLE')
    const existing = this.database.listJobs().find((job) => job.songId === songId && job.type === 'separate' && !['completed', 'cancelled', 'failed', 'interrupted'].includes(job.status))
    if (existing) return existing.id
    const runtimeReady = this.runtime.getInfo().status === 'ready'
    const status = runtimeReady ? 'queued' : 'blockedRuntime'
    const phase = runtimeReady ? '等待重新分离' : '等待安装本地环境'
    const jobId = this.database.createJob('separate', songId, status, phase, {
      sourceRelPath: row.source_rel_path,
      segment: 7,
      retry: 0
    })
    this.database.setJobState(jobId, status, phase, 0)
    this.changed()
    this.kickJobs()
    return jobId
  }

  openLocation(songId: string): void {
    const settings = this.database.getSettings()
    const directory = this.paths.songDirectory(settings.libraryRoot, songId)
    if (existsSync(directory)) shell.showItemInFolder(directory)
  }

  private async filesFromFolder(folder: string): Promise<StemChoice[]> {
    const entries = await readdir(folder, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => {
        const filePath = path.join(folder, entry.name)
        return { path: filePath, name: entry.name, inferredType: inferStemType(entry.name) }
      })
  }

  private async validateAudioFile(filePath: string, extensions = AUDIO_EXTENSIONS): Promise<void> {
    if (!extensions.has(path.extname(filePath).toLowerCase())) throw new Error('UNSUPPORTED_AUDIO_FORMAT')
    const info = await stat(filePath)
    if (!info.isFile() || info.size === 0) throw new Error('EMPTY_AUDIO_FILE')
  }

  private emptyResult(): ImportResult {
    return { songId: null, jobId: null, duplicate: null, needsPadding: false, durationDifferenceMs: 0, warnings: [] }
  }
}

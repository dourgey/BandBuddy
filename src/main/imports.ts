import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { copyFile, readFile, stat, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import { dialog, shell } from 'electron'
import {
  GUITAR_SPLIT_STEMS,
  normalizeSelectedStemForGuitarMode,
  stemStorageFormat,
  type ImportResult,
  type ImportStemsOptions,
  type ImportSourceOptions,
  type SongDetail,
  type SourceChoice
} from '@shared/domain.js'
import { parseLrc } from '@shared/lyrics.js'
import { AUDIO_EXTENSIONS, SOURCE_AUDIO_EXTENSIONS, SOURCE_MEDIA_EXTENSIONS, VIDEO_EXTENSIONS, isVideoSource } from '@shared/media-formats.js'
import type { BandBuddyDatabase } from './database.js'
import type { Logger } from './logger.js'
import type { MediaService } from './media.js'
import type { AppPaths } from './paths.js'
import type { RuntimeManager } from './runtime.js'
export { AUDIO_EXTENSIONS, SOURCE_AUDIO_EXTENSIONS, SOURCE_MEDIA_EXTENSIONS, VIDEO_EXTENSIONS }
const MAX_LRC_BYTES = 2 * 1024 * 1024

function decodeLyricsFile(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[2] === 0) return new TextDecoder('utf-16be').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030').decode(bytes)
  }
}

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
      filters: [
        { name: '音频与视频', extensions: [...SOURCE_MEDIA_EXTENSIONS].map((extension) => extension.slice(1)) },
        { name: '视频文件', extensions: [...VIDEO_EXTENSIONS].map((extension) => extension.slice(1)) },
        { name: '音频文件', extensions: [...SOURCE_AUDIO_EXTENSIONS].map((extension) => extension.slice(1)) }
      ]
    })
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return null
    return { path: filePath, name: path.basename(filePath), inferredTitle: path.basename(filePath, path.extname(filePath)) }
  }

  async chooseStems(mode: 'files' | 'folder' = 'files'): Promise<SourceChoice[]> {
    const result = await dialog.showOpenDialog({
      title: mode === 'folder' ? '选择已分轨文件夹' : '选择已分轨音频',
      properties: mode === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
      filters: [{ name: '音频文件', extensions: [...AUDIO_EXTENSIONS].map((ext) => ext.slice(1)) }]
    })
    if (result.canceled) return []
    let files = result.filePaths
    if (mode === 'folder') {
      const folder = files[0]
      if (!folder) return []
      files = (await readdir(folder, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => path.join(folder, entry.name))
      if (!files.length) throw new Error('文件夹中没有支持的音轨文件')
    }
    return files.map((file) => ({
      path: file, name: path.basename(file), inferredTitle: path.basename(file, path.extname(file))
    }))
  }

  async importStems(options: ImportStemsOptions): Promise<ImportResult> {
    if (!this.media.toolsReady()) throw new Error('FFMPEG_MISSING')
    for (const file of options.files) await this.validateAudioFile(file.path, AUDIO_EXTENSIONS)
    const probes = await Promise.all(options.files.map((file) => this.media.probe(file.path)))
    if (probes.some((probe) => !Number.isFinite(probe.durationMs) || probe.durationMs <= 0)) throw new Error('无效的音轨时长')
    const durationMs = Math.max(...probes.map((probe) => probe.durationMs))
    const difference = durationMs - Math.min(...probes.map((probe) => probe.durationMs))
    if (difference > 500 && !options.padMismatched) {
      return { ...this.emptyResult(), needsPadding: true, durationDifferenceMs: difference }
    }
    const songId = randomUUID()
    const settings = this.database.getSettings()
    const songRoot = this.paths.songDirectory(settings.libraryRoot, songId)
    const rawRoot = path.join(songRoot, 'source-stems')
    mkdirSync(rawRoot, { recursive: true })
    try {
      const files = []
      for (const file of options.files) {
        const destination = path.join(rawRoot, `${file.type}${path.extname(file.path).toLowerCase()}`)
        await copyFile(file.path, destination)
        files.push({ type: file.type, name: file.name.trim(), relPath: this.paths.toLibraryRelative(settings.libraryRoot, destination) })
      }
      this.database.createSong({
        title: options.title?.trim() || path.basename(path.dirname(options.files[0]!.path)),
        artist: options.artist?.trim() || '', sourceRelPath: null, sourceHash: null,
        sourceFormat: 'existing-stems', durationMs, sampleRate: null, channels: null,
        artworkRelPath: null, status: 'queued', phase: '等待标准化分轨'
      }, songId)
      const jobId = this.database.createJob('normalizeStems', songId, 'queued', '等待标准化分轨', {
        files, targetDurationMs: durationMs, padMismatched: Boolean(options.padMismatched)
      })
      this.changed()
      this.kickJobs()
      return { songId, jobId, duplicate: null }
    } catch (error) {
      this.database.deleteSongRecord(songId)
      await rm(songRoot, { recursive: true, force: true })
      throw error
    }
  }

  async importLyrics(songId: string): Promise<SongDetail | null> {
    if (!this.database.getSongRow(songId)) throw new Error('SONG_NOT_FOUND')
    const result = await dialog.showOpenDialog({
      title: '导入 LRC 歌词',
      buttonLabel: '导入歌词',
      properties: ['openFile'],
      filters: [{ name: 'LRC 歌词', extensions: ['lrc'] }]
    })
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return null
    if (path.extname(filePath).toLowerCase() !== '.lrc') throw new Error('UNSUPPORTED_LYRICS_FORMAT')
    const info = await stat(filePath)
    if (!info.isFile() || info.size === 0) throw new Error('LYRICS_FILE_EMPTY')
    if (info.size > MAX_LRC_BYTES) throw new Error('LYRICS_FILE_TOO_LARGE')

    const content = decodeLyricsFile(await readFile(filePath))
    if (!content.trim()) throw new Error('LYRICS_FILE_EMPTY')
    const fileName = path.basename(filePath)
    const lyrics = parseLrc(content, fileName)
    if (lyrics.cues.length === 0) throw new Error('LRC_NO_TIMESTAMPS')

    const song = this.database.setLyrics(songId, fileName, content)
    this.logger.info('lyrics imported', { songId, fileName, cueCount: lyrics.cues.length })
    this.changed()
    return song
  }

  async importSource(options: ImportSourceOptions): Promise<ImportResult> {
    const selected = options.filePath ? { path: options.filePath } : await this.chooseSource()
    if (!selected) return this.emptyResult()
    const sourcePath = path.resolve(selected.path)
    await this.validateAudioFile(sourcePath, SOURCE_MEDIA_EXTENSIONS)
    const videoSource = isVideoSource(sourcePath)
    if (videoSource && !this.media.toolsReady()) throw new Error('FFMPEG_MISSING')
    // Validate streams before copying a potentially large video into the library.
    const sourceProbe = videoSource ? await this.media.probe(sourcePath) : null
    if (videoSource && !sourceProbe?.video) throw new Error('NO_VIDEO_STREAM')
    if (sourceProbe && sourceProbe.durationMs <= 0) throw new Error('INVALID_VIDEO_DURATION')
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
    const probe = sourceProbe ?? await this.media.probe(copiedSource)

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
      {
        sourceRelPath: this.paths.toLibraryRelative(settings.libraryRoot, copiedSource),
        storageFormat: stemStorageFormat(settings.highQualityStems),
        guitarQuality: settings.guitarSeparationQuality,
        retry: 0
      }
    )
    this.logger.info('source imported', { songId, extension, sourceHash })
    this.changed()
    this.kickJobs()
    return { songId, jobId, duplicate: null }
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
    const settings = this.database.getSettings()
    const runtimeReady = this.runtime.getInfo().status === 'ready'
    const status = runtimeReady ? 'queued' : 'blockedRuntime'
    const phase = runtimeReady ? '等待重新分离' : '等待安装本地环境'
    const jobId = this.database.createJob('separate', songId, status, phase, {
      sourceRelPath: row.source_rel_path,
      storageFormat: stemStorageFormat(settings.highQualityStems),
      guitarQuality: settings.guitarSeparationQuality,
      retry: 0
    })
    this.database.setJobState(jobId, status, phase, 0)
    this.changed()
    this.kickJobs()
    return jobId
  }

  requestGuitarSplit(songId: string): string | null {
    const song = this.database.getSong(songId)
    if (!song) throw new Error('SONG_NOT_FOUND')
    const splitTypes = new Set(song.stems.map((stem) => stem.type))
    if (GUITAR_SPLIT_STEMS.every((type) => splitTypes.has(type))) {
      this.database.savePractice({
        ...song.practice,
        guitarSplitEnabled: true,
        selectedStem: normalizeSelectedStemForGuitarMode(song.practice.selectedStem, true)
      })
      this.changed()
      return null
    }
    const row = this.database.getSongRow(songId)
    if (!row?.source_rel_path) throw new Error('ORIGINAL_SOURCE_NOT_AVAILABLE')
    const settings = this.database.getSettings()
    const existingGuitar = this.database.listJobs().find((job) =>
      job.songId === songId
      && job.type === 'guitarSplit'
      && !['completed', 'cancelled', 'failed', 'interrupted'].includes(job.status)
    )
    if (existingGuitar) {
      const full = this.database.getJob(existingGuitar.id)
      this.database.updateJobPayload(existingGuitar.id, {
        ...(typeof full?.payload === 'object' && full.payload ? full.payload : {}),
        enableGuitarSplitOnSuccess: true
      })
      return existingGuitar.id
    }
    const existingBase = this.database.listJobs().find((job) =>
      job.songId === songId
      && job.type === 'separate'
      && !['completed', 'cancelled', 'failed', 'interrupted'].includes(job.status)
    )
    if (existingBase) {
      const full = this.database.getJob(existingBase.id)
      this.database.updateJobPayload(existingBase.id, {
        ...(typeof full?.payload === 'object' && full.payload ? full.payload : {}),
        enableGuitarSplitOnSuccess: true
      })
      return existingBase.id
    }
    if (!row.active_separation_id) {
      const runtimeReady = this.runtime.getInfo().status === 'ready'
      const status = runtimeReady ? 'queued' : 'blockedRuntime'
      const phase = runtimeReady ? '等待基础分轨' : '等待安装本地环境'
      const jobId = this.database.createJob('separate', songId, status, phase, {
        sourceRelPath: row.source_rel_path,
        storageFormat: stemStorageFormat(settings.highQualityStems),
        guitarQuality: settings.guitarSeparationQuality,
        enableGuitarSplitOnSuccess: true,
        retry: 0
      })
      this.database.setJobState(jobId, status, phase, 0)
      this.changed()
      this.kickJobs()
      return jobId
    }
    const runtimeReady = this.runtime.getInfo().status === 'ready'
    const status = runtimeReady ? 'queued' : 'blockedRuntime'
    const phase = runtimeReady ? '等待吉他细分' : '等待安装本地环境'
    const jobId = this.database.createJob('guitarSplit', songId, status, phase, {
      sourceRelPath: row.source_rel_path,
      storageFormat: stemStorageFormat(settings.highQualityStems),
      guitarQuality: settings.guitarSeparationQuality,
      baseSeparationId: row.active_separation_id,
      expectedActiveSeparationId: row.active_separation_id,
      baseEncodingGain: 1,
      targetDurationMs: song.durationMs,
      enableGuitarSplitOnSuccess: true,
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

  private async validateAudioFile(filePath: string, extensions: ReadonlySet<string>): Promise<void> {
    if (!extensions.has(path.extname(filePath).toLowerCase())) {
      throw new Error('UNSUPPORTED_MEDIA_FORMAT')
    }
    const info = await stat(filePath)
    if (!info.isFile() || info.size === 0) throw new Error('EMPTY_AUDIO_FILE')
  }

  private emptyResult(): ImportResult {
    return { songId: null, jobId: null, duplicate: null }
  }
}

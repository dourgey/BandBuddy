import { existsSync, mkdirSync } from 'node:fs'
import { access, rename } from 'node:fs/promises'
import path from 'node:path'
import { dialog } from 'electron'
import {
  STEM_META,
  type ExportFormat,
  type ExportRequest,
  type ExportResult
} from '@shared/domain.js'
import type { BandBuddyDatabase } from './database.js'
import type { Logger } from './logger.js'
import type { MediaService } from './media.js'
import type { AppPaths } from './paths.js'
import { runProcess } from './process.js'
import { buildMixFilter } from './export-filter.js'

export { buildMixFilter } from './export-filter.js'

function outputArgs(format: ExportFormat): string[] {
  if (format === 'wav') return ['-c:a', 'pcm_s24le', '-ar', '44100', '-ac', '2']
  if (format === 'flac') return ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-ar', '44100', '-ac', '2']
  return ['-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '44100', '-ac', '2']
}

function safeName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'BandBuddy'
}

export class ExportService {
  constructor(
    private readonly paths: AppPaths,
    private readonly database: BandBuddyDatabase,
    private readonly media: MediaService,
    private readonly logger: Logger,
    private readonly changed: () => void,
    private readonly kickJobs: () => void
  ) {}

  async choosePath(kind: 'stems' | 'mix', format: ExportFormat, songTitle: string): Promise<string | null> {
    if (kind === 'stems') {
      const selected = await dialog.showOpenDialog({ title: '选择音轨导出文件夹', properties: ['openDirectory', 'createDirectory'] })
      return selected.canceled ? null : selected.filePaths[0] ?? null
    }
    const selected = await dialog.showSaveDialog({
      title: '导出当前混音',
      defaultPath: `${safeName(songTitle)} - BandBuddy Mix.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    })
    return selected.canceled ? null : selected.filePath ?? null
  }

  async start(request: ExportRequest): Promise<ExportResult> {
    const song = this.database.getSong(request.songId)
    if (!song || !song.stems.length) throw new Error('NO_STEMS_TO_EXPORT')
    if (!request.outputPath) throw new Error('EXPORT_PATH_REQUIRED')
    if (request.kind === 'mix') {
      const activeRecordings = song.recordingTracks.flatMap((track) => {
        const take = song.recordingTakes.find((candidate) => candidate.id === track.activeTakeId)
        return take ? [{ track, take }] : []
      })
      if (request.includeActiveTake && activeRecordings.length === 0) throw new Error('ACTIVE_RECORDING_TAKE_MISSING')
      const hasSolo = song.practice.tracks.some((track) => track.solo && !track.muted)
        || (request.includeActiveTake && activeRecordings.some(({ track }) => track.solo && !track.muted))
      const states = song.practice.tracks.filter((track) => request.stemTypes.includes(track.stemType))
      const audibleStems = states.some((track) => !track.muted && (!hasSolo || track.solo))
      const audibleRecordings = request.includeActiveTake
        ? activeRecordings.filter(({ track }) => !track.muted && (!hasSolo || track.solo))
        : []
      if (audibleRecordings.some(({ take }) => !request.applyPlaybackRate || Math.abs(request.playbackRate - take.playbackRate) > 0.0001)) {
        throw new Error('RECORDING_TAKE_SPEED_MISMATCH')
      }
      if (!audibleStems && audibleRecordings.length === 0) throw new Error('NO_AUDIBLE_TRACKS')
    }
    const outputPaths = await this.planOutputPaths(request, song.title)
    const jobId = this.database.createJob('export', request.songId, 'queued', '等待导出', { request, outputPaths })
    this.changed()
    this.kickJobs()
    return { jobId, outputPaths }
  }

  private async planOutputPaths(request: ExportRequest, title: string): Promise<string[]> {
    if (!request.outputPath) return []
    const proposed = request.kind === 'mix'
      ? [path.resolve(request.outputPath)]
      : request.stemTypes.map((stem) => path.join(path.resolve(request.outputPath!), `${safeName(title)} - ${STEM_META[stem].shortLabel}.${request.format}`))
    const outputs: string[] = []
    for (const file of proposed) {
      let output = file
      if (existsSync(output)) {
        if (request.overwriteMode === 'ask') {
          const answer = await dialog.showMessageBox({
            type: 'question', title: '文件已存在', message: path.basename(output),
            detail: '是否覆盖这个文件？', buttons: ['覆盖', '自动编号', '取消'], defaultId: 1, cancelId: 2
          })
          if (answer.response === 2) throw new Error('EXPORT_CANCELLED')
          if (answer.response === 1) output = await this.numberedPath(output)
        } else if (request.overwriteMode === 'rename') output = await this.numberedPath(output)
      }
      outputs.push(output)
    }
    return outputs
  }

  private async numberedPath(file: string): Promise<string> {
    const extension = path.extname(file)
    const base = file.slice(0, -extension.length)
    for (let index = 2; index < 10_000; index += 1) {
      const candidate = `${base} (${index})${extension}`
      try { await access(candidate) } catch { return candidate }
    }
    throw new Error('NO_AVAILABLE_EXPORT_NAME')
  }

  async run(
    request: ExportRequest,
    outputPaths: string[],
    signal: AbortSignal,
    onProgress: (progress: number, phase: string) => void
  ): Promise<void> {
    const ffmpeg = this.media.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    const settings = this.database.getSettings()
    const song = this.database.getSong(request.songId)
    if (!song) throw new Error('SONG_NOT_FOUND')
    const allFiles = this.database.getActiveStemFiles(request.songId)
    const files = request.stemTypes.map((type) => allFiles.find((file) => file.type === type)).filter((file) => file !== undefined)
    if (!files.length && request.kind === 'stems') throw new Error('NO_STEMS_TO_EXPORT')

    if (request.kind === 'stems') {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]!
        const output = outputPaths[index]!
        mkdirSync(path.dirname(output), { recursive: true })
        const temporary = path.join(path.dirname(output), `${path.basename(output, path.extname(output))}.part${path.extname(output)}`)
        const result = await runProcess(ffmpeg, [
          '-y', '-v', 'error', '-i', this.paths.resolveLibraryPath(settings.libraryRoot, file.relPath),
          '-map_metadata', '-1', '-vn', ...outputArgs(request.format), temporary
        ], { signal })
        if (signal.aborted) throw new Error('EXPORT_CANCELLED')
        if (result.code !== 0) throw new Error(`EXPORT_FAILED:${result.stderr.slice(-800)}`)
        await rename(temporary, output)
        onProgress((index + 1) / files.length, `已导出 ${STEM_META[file.type].shortLabel}`)
      }
      return
    }

    const activeRecordings = request.includeActiveTake
      ? song.recordingTracks.flatMap((track) => {
        const take = song.recordingTakes.find((candidate) => candidate.id === track.activeTakeId)
        return take ? [{ track, take }] : []
      })
      : []
    if (request.includeActiveTake && activeRecordings.length === 0) throw new Error('ACTIVE_RECORDING_TAKE_MISSING')
    const hasSolo = song.practice.tracks.some((track) => track.solo && !track.muted)
      || (request.includeActiveTake && activeRecordings.some(({ track }) => track.solo && !track.muted))
    const audibleStates = song.practice.tracks.filter((state) =>
      request.stemTypes.includes(state.stemType) && !state.muted && (!hasSolo || state.solo)
    )
    const audibleRecordings = activeRecordings.filter(({ track }) => !track.muted && (!hasSolo || track.solo))
    if (audibleRecordings.some(({ take }) => !request.applyPlaybackRate || Math.abs(request.playbackRate - take.playbackRate) > 0.0001)) {
      throw new Error('RECORDING_TAKE_SPEED_MISMATCH')
    }
    if (!audibleStates.length && !audibleRecordings.length) throw new Error('NO_AUDIBLE_TRACKS')
    const inputFiles = audibleStates.map((state) => ({ state, file: files.find((candidate) => candidate.type === state.stemType) })).filter((entry) => entry.file !== undefined)
    if (!inputFiles.length && !audibleRecordings.length) throw new Error('NO_AUDIBLE_TRACKS')
    const output = outputPaths[0]!
    mkdirSync(path.dirname(output), { recursive: true })
    const temporary = path.join(path.dirname(output), `${path.basename(output, path.extname(output))}.part${path.extname(output)}`)
    const inputs = inputFiles.flatMap(({ file }) => ['-i', this.paths.resolveLibraryPath(settings.libraryRoot, file!.relPath)])
    const recordingInputs = audibleRecordings.map(({ track, take }, index) => {
      const takeFile = this.database.getRecordingTakeFile(take.id)
      if (!takeFile) throw new Error('ACTIVE_RECORDING_TAKE_MISSING')
      inputs.push('-i', this.paths.resolveLibraryPath(settings.libraryRoot, takeFile.sourceRelPath))
      return { track, take, inputIndex: inputFiles.length + index }
    })
    const filter = buildMixFilter({
      tracks: inputFiles.map(({ state }, inputIndex) => ({ inputIndex, state })),
      takes: recordingInputs.map(({ track, take, inputIndex }) => ({
        inputIndex,
        gainDb: track.gainDb,
        startPositionMs: take.startPositionMs,
        playbackRate: take.playbackRate,
        alignmentOffsetMs: take.alignmentOffsetMs
      })),
      masterGainDb: song.practice.masterGainDb,
      playbackRate: request.applyPlaybackRate ? request.playbackRate : null,
      loopStartMs: request.applyLoopRange ? request.loopStartMs : null,
      loopEndMs: request.applyLoopRange ? request.loopEndMs : null,
      sourceDurationMs: song.durationMs
    })
    const expectedMs = request.applyLoopRange && request.loopStartMs !== null && request.loopEndMs !== null
      ? (request.loopEndMs - request.loopStartMs) / (request.applyPlaybackRate ? request.playbackRate : 1)
      : song.durationMs / (request.applyPlaybackRate ? request.playbackRate : 1)
    const result = await runProcess(ffmpeg, [
      '-y', '-v', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', '-map_metadata', '-1',
      ...outputArgs(request.format), '-progress', 'pipe:1', '-nostats', temporary
    ], {
      signal,
      onStdoutLine: (line) => {
        const match = /^out_time_us=(\d+)$/.exec(line)
        if (match && expectedMs > 0) onProgress(Math.min(0.99, Number(match[1]) / 1000 / expectedMs), '正在混合与限制峰值')
      }
    })
    if (signal.aborted) throw new Error('EXPORT_CANCELLED')
    if (result.code !== 0) throw new Error(`EXPORT_FAILED:${result.stderr.slice(-800)}`)
    await rename(temporary, output)
    onProgress(1, '导出完成')
    this.logger.info('mix exported', { songId: request.songId, output, format: request.format })
  }
}

import type { ArsenalService } from './arsenal.js'
import { existsSync, mkdirSync } from 'node:fs'
import { access, mkdtemp, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { dialog } from 'electron'
import {
  STEM_META,
  isStemVisible,
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
import { renderPitchedStemBus } from './pitch-shift.js'

export { buildMixFilter } from './export-filter.js'

function outputArgs(format: ExportFormat): string[] {
  if (format === 'wav') return ['-c:a', 'pcm_s24le', '-ar', '44100', '-ac', '2']
  if (format === 'flac') return ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-ar', '44100', '-ac', '2']
  return ['-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '44100', '-ac', '2']
}

function safeName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'BandBuddy'
}

export function exportedStemPitchSemitones(request: Pick<ExportRequest, 'applyPitchShift' | 'pitchSemitones'>, stemType: string): number {
  return request.applyPitchShift && stemType !== 'drums' ? request.pitchSemitones : 0
}

export class ExportService {
  arsenal?: ArsenalService
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
    const effectiveRequest: ExportRequest = request.kind === 'mix'
      ? {
          ...request,
          stemTypes: request.stemTypes.filter((type) =>
            (song.sourceFormat === 'existing-stems' || isStemVisible(type, song.practice.guitarSplitEnabled))
          )
        }
      : request
    if (effectiveRequest.kind === 'mix') {
      const activeRecordings = song.recordingTracks.flatMap((track) => {
        const take = song.recordingTakes.find((candidate) => candidate.id === track.activeTakeId)
        return take ? [{ track, take }] : []
      })
      if (effectiveRequest.includeActiveTake && activeRecordings.length === 0) throw new Error('ACTIVE_RECORDING_TAKE_MISSING')
      const hasSolo = song.practice.tracks.some((track) =>
        (song.sourceFormat === 'existing-stems' || isStemVisible(track.stemType, song.practice.guitarSplitEnabled)) && track.solo && !track.muted
      ) || (effectiveRequest.includeActiveTake && activeRecordings.some(({ track }) => track.solo && !track.muted))
      const states = song.practice.tracks.filter((track) => effectiveRequest.stemTypes.includes(track.stemType))
      const audibleStems = states.some((track) => !track.muted && (!hasSolo || track.solo))
      const audibleRecordings = effectiveRequest.includeActiveTake
        ? activeRecordings.filter(({ track }) => !track.muted && (!hasSolo || track.solo))
        : []
      if (audibleRecordings.some(({ take }) => !effectiveRequest.applyPlaybackRate || Math.abs(effectiveRequest.playbackRate - take.playbackRate) > 0.0001)) {
        throw new Error('RECORDING_TAKE_SPEED_MISMATCH')
      }
      const effectivePitch = effectiveRequest.applyPitchShift ? effectiveRequest.pitchSemitones : 0
      if (audibleRecordings.some(({ take }) => (take.pitchSemitones ?? 0) !== effectivePitch)) {
        throw new Error('RECORDING_TAKE_PITCH_MISMATCH')
      }
      if (!audibleStems && audibleRecordings.length === 0) throw new Error('NO_AUDIBLE_TRACKS')
    }
    const outputPaths = await this.planOutputPaths(effectiveRequest, song.title)
    const jobId = this.database.createJob('export', effectiveRequest.songId, 'queued', '等待导出', { request: effectiveRequest, outputPaths })
    this.changed()
    this.kickJobs()
    return { jobId, outputPaths }
  }

  private async planOutputPaths(request: ExportRequest, title: string): Promise<string[]> {
    if (!request.outputPath) return []
    const names = this.database.getSong(request.songId)?.stems ?? []
    const proposed = request.kind === 'mix'
      ? [path.resolve(request.outputPath)]
      : request.stemTypes.map((stem, index) => {
          const name = names.find((item) => item.type === stem)?.name
          const label = name ? `${String(index + 1).padStart(2, '0')} ${safeName(name)}` : STEM_META[stem].shortLabel
          return path.join(path.resolve(request.outputPath!), `${safeName(title)} - ${label}.${request.format}`)
        })
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
    const requestedStemTypes = request.kind === 'mix'
      ? request.stemTypes.filter((type) => (song.sourceFormat === 'existing-stems' || isStemVisible(type, song.practice.guitarSplitEnabled)))
      : request.stemTypes
    const files = requestedStemTypes.map((type) => allFiles.find((file) => file.type === type)).filter((file) => file !== undefined)
    if (!files.length && request.kind === 'stems') throw new Error('NO_STEMS_TO_EXPORT')

    if (request.kind === 'stems') {
      const effectivePitch = request.applyPitchShift ? request.pitchSemitones : 0
      let stemPitchRoot: string | null = null
      try {
        if (effectivePitch !== 0 && files.some((file) => file.type !== 'drums')) {
          stemPitchRoot = await mkdtemp(path.join(this.paths.cacheRoot, 'export-stems-pitch-'))
        }
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index]!
          const output = outputPaths[index]!
          mkdirSync(path.dirname(output), { recursive: true })
          const temporary = path.join(path.dirname(output), `${path.basename(output, path.extname(output))}.part${path.extname(output)}`)
          const source = this.paths.resolveLibraryPath(settings.libraryRoot, file.relPath)
          let input = source
          if (stemPitchRoot && exportedStemPitchSemitones(request, file.type) !== 0) {
            onProgress(index / files.length, `正在为 ${STEM_META[file.type].shortLabel} 应用 Signalsmith 升降调`)
            input = await renderPitchedStemBus({
              paths: this.paths,
              ffmpeg,
              stems: [{ path: source, gainDb: 0 }],
              startPositionMs: 0,
              endPositionMs: file.durationMs,
              playbackRate: 1,
              sampleRate: 44_100,
              semitones: effectivePitch,
              unpitchedPath: path.join(stemPitchRoot, `${file.type}-input.wav`),
              pitchedPath: path.join(stemPitchRoot, `${file.type}-pitched.wav`),
              signal
            }) ?? source
          }
          const result = await runProcess(ffmpeg, [
            '-y', '-v', 'error', '-i', input,
            '-map_metadata', '-1', '-vn', ...outputArgs(request.format), temporary
          ], { signal })
          if (signal.aborted) throw new Error('EXPORT_CANCELLED')
          if (result.code !== 0) throw new Error(`EXPORT_FAILED:${result.stderr.slice(-800)}`)
          await rename(temporary, output)
          onProgress((index + 1) / files.length, `已导出 ${STEM_META[file.type].shortLabel}`)
        }
        this.logger.info('stems exported', { songId: request.songId, count: files.length, format: request.format, pitchSemitones: effectivePitch })
      } finally {
        if (stemPitchRoot) await rm(stemPitchRoot, { recursive: true, force: true })
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
    const hasSolo = song.practice.tracks.some((track) =>
      (song.sourceFormat === 'existing-stems' || isStemVisible(track.stemType, song.practice.guitarSplitEnabled)) && track.solo && !track.muted
    )
      || (request.includeActiveTake && activeRecordings.some(({ track }) => track.solo && !track.muted))
    const audibleStates = song.practice.tracks.filter((state) =>
      requestedStemTypes.includes(state.stemType)
      && (song.sourceFormat === 'existing-stems' || isStemVisible(state.stemType, song.practice.guitarSplitEnabled))
      && !state.muted
      && (!hasSolo || state.solo)
    )
    const audibleRecordings = activeRecordings.filter(({ track }) => !track.muted && (!hasSolo || track.solo))
    if (audibleRecordings.some(({ take }) => !request.applyPlaybackRate || Math.abs(request.playbackRate - take.playbackRate) > 0.0001)) {
      throw new Error('RECORDING_TAKE_SPEED_MISMATCH')
    }
    const effectivePitch = request.applyPitchShift ? request.pitchSemitones : 0
    if (audibleRecordings.some(({ take }) => (take.pitchSemitones ?? 0) !== effectivePitch)) {
      throw new Error('RECORDING_TAKE_PITCH_MISMATCH')
    }
    if (!audibleStates.length && !audibleRecordings.length) throw new Error('NO_AUDIBLE_TRACKS')
    const inputFiles = audibleStates.map((state) => ({ state, file: files.find((candidate) => candidate.type === state.stemType) })).filter((entry) => entry.file !== undefined)
    if (!inputFiles.length && !audibleRecordings.length) throw new Error('NO_AUDIBLE_TRACKS')
    const output = outputPaths[0]!
    mkdirSync(path.dirname(output), { recursive: true })
    const temporary = path.join(path.dirname(output), `${path.basename(output, path.extname(output))}.part${path.extname(output)}`)
    const expectedMs = request.applyLoopRange && request.loopStartMs !== null && request.loopEndMs !== null
      ? (request.loopEndMs - request.loopStartMs) / (request.applyPlaybackRate ? request.playbackRate : 1)
      : song.durationMs / (request.applyPlaybackRate ? request.playbackRate : 1)
    let pitchRoot: string | null = null
    try {
      const harmonicInputs = effectivePitch === 0
        ? []
        : inputFiles.filter(({ state }) => state.stemType !== 'drums')
      let pitchedBus: string | null = null
      if (harmonicInputs.length) {
        pitchRoot = await mkdtemp(path.join(this.paths.cacheRoot, 'export-pitch-'))
        onProgress(0.03, '正在应用 Signalsmith 升降调')
        pitchedBus = await renderPitchedStemBus({
          paths: this.paths,
          ffmpeg,
          stems: harmonicInputs.map(({ state, file }) => ({
            path: this.paths.resolveLibraryPath(settings.libraryRoot, file!.relPath),
            gainDb: state.gainDb
          })),
          startPositionMs: request.applyLoopRange ? request.loopStartMs ?? 0 : 0,
          endPositionMs: request.applyLoopRange ? request.loopEndMs ?? song.durationMs : song.durationMs,
          playbackRate: request.applyPlaybackRate ? request.playbackRate : 1,
          sampleRate: 44_100,
          semitones: effectivePitch,
          unpitchedPath: path.join(pitchRoot, 'harmonic-input.wav'),
          pitchedPath: path.join(pitchRoot, 'harmonic-pitched.wav'),
          signal
        })
      }
      const rawInputs = pitchedBus
        ? inputFiles.filter(({ state }) => state.stemType === 'drums')
        : inputFiles
      const inputs: string[] = []
      const mixTracks: Parameters<typeof buildMixFilter>[0]['tracks'] = []
      if (pitchedBus) {
        inputs.push('-i', pitchedBus)
        mixTracks.push({
          inputIndex: 0,
          state: { ...harmonicInputs[0]!.state, gainDb: 0, muted: false, solo: false },
          preprocessed: true
        })
      }
      rawInputs.forEach(({ state, file }) => {
        const inputIndex = mixTracks.length
        inputs.push('-i', this.paths.resolveLibraryPath(settings.libraryRoot, file!.relPath))
        mixTracks.push({ inputIndex, state })
      })
      const wetRecordings = await Promise.all(audibleRecordings.map(async ({track,take}) => {
        const file=this.database.getRecordingTakeFile(take.id)
        if(!file) throw new Error('ACTIVE_RECORDING_TAKE_MISSING')
        const source=this.paths.resolveLibraryPath(settings.libraryRoot,file.sourceRelPath)
        return this.arsenal?.render(source,track.effects,signal,request.applyLoopRange?0:10) ?? source
      }))
      const recordingInputs = audibleRecordings.map(({ track, take }) => {
        const takeFile = this.database.getRecordingTakeFile(take.id)
        if (!takeFile) throw new Error('ACTIVE_RECORDING_TAKE_MISSING')
        const inputIndex = inputs.length / 2
        inputs.push('-i', wetRecordings[audibleRecordings.findIndex(entry => entry.take.id === take.id)]!)
        return { track, take, inputIndex }
      })
      const filter = buildMixFilter({
        tracks: mixTracks,
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
      this.logger.info('mix exported', { songId: request.songId, output, format: request.format, pitchSemitones: effectivePitch })
    } finally {
      if (pitchRoot) await rm(pitchRoot, { recursive: true, force: true })
    }
  }
}

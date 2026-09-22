import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Notification } from 'electron'
import {
  GUITAR_SPLIT_STEMS,
  LEGACY_STEM_ORDER,
  type ExportRequest,
  type GuitarSeparationQuality,
  type JobRecord,
  type StemStorageFormat,
  type StemType
} from '@shared/domain.js'
import { isVideoSource } from '@shared/media-formats.js'
import type { BandBuddyDatabase, GuitarSplitJobPayload, StoredStemInput } from './database.js'
import type { ExportService } from './exporter.js'
import type { Logger } from './logger.js'
import type { MediaService } from './media.js'
import type { AppPaths } from './paths.js'
import { RUNTIME_VERSIONS, type RuntimeManager } from './runtime.js'
import { fallbackComputeDevice } from './runtime-device.js'
import { classifyJobError } from './job-state.js'
import { ProgressCoalescer } from './progress-coalescer.js'

interface SeparationPayload {
  sourceRelPath: string
  storageFormat?: StemStorageFormat
  retry?: number
  deviceOverride?: 'cuda' | 'mps' | 'cpu'
  enableGuitarSplitOnSuccess?: boolean
  guitarQuality?: GuitarSeparationQuality
}

interface NormalizePayload {
  files: Array<{ type: StemType; relPath: string; name?: string }>
  targetDurationMs: number
  padMismatched: boolean
}

interface ExportPayload {
  request: ExportRequest
  outputPaths: string[]
}

export class JobScheduler {
  private running = false
  private stopping = false
  private drainTask: Promise<void> | null = null
  private active: { id: string; songId: string | null; controller: AbortController } | null = null
  private exporter: ExportService | null = null
  private readonly progress = new ProgressCoalescer<Parameters<BandBuddyDatabase['setJobState']>>(args => {
    this.database.setJobState(...args)
    this.changed(args[0])
  })

  private setJobState(...args: Parameters<BandBuddyDatabase['setJobState']>): void {
    this.progress.cancel()
    this.database.setJobState(...args)
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(args[1])) this.changed(args[0])
  }

  private reportProgress(...args: Parameters<BandBuddyDatabase['setJobState']>): void {
    if (this.active?.controller.signal.aborted) return
    this.progress.push(args, `${args[0]}:${args[1]}:${args[2]}`)
  }

  constructor(
    private readonly paths: AppPaths,
    private readonly database: BandBuddyDatabase,
    private readonly runtime: RuntimeManager,
    private readonly media: MediaService,
    private readonly logger: Logger,
    private readonly changed: (jobId?: string) => void,
    private readonly libraryChanged: () => void,
    private readonly guitarSplitCompleted: (songId: string) => void = () => undefined
  ) {
    runtime.onChange((info) => {
      if (info.status === 'ready') {
        database.unblockRuntimeJobs()
        this.kick()
        changed()
      }
    })
  }

  setExporter(exporter: ExportService): void {
    this.exporter = exporter
  }

  kick(): void {
    if (this.running || this.stopping) return
    this.running = true
    queueMicrotask(() => {
      if (this.stopping) { this.running = false; return }
      const task = this.drain()
      this.drainTask = task
      void task.finally(() => { if (this.drainTask === task) this.drainTask = null }).catch(error => this.logger.error('task scheduler failed', error))
    })
  }

  private async drain(): Promise<void> {
    try {
      while (!this.active && !this.stopping) {
        const job = this.database.nextQueuedJob()
        if (!job) break
        if ((job.type === 'separate' || job.type === 'guitarSplit') && this.runtime.getInfo().status !== 'ready') {
          this.setJobState(job.id, 'blockedRuntime', '等待安装本地分离环境', 0)
          this.changed()
          continue
        }
        const controller = new AbortController()
        this.active = { id: job.id, songId: job.songId, controller }
        try {
          await this.runJob(job, controller.signal)
        } catch (error) {
          if (!this.stopping) await this.handleFailure(job, error, controller.signal.aborted)
        } finally {
          this.progress.cancel()
          this.active = null
          this.changed()
          this.libraryChanged()
        }
      }
    } finally {
      this.running = false
      if (!this.stopping && !this.active && this.database.nextQueuedJob()) this.kick()
    }
  }

  private async runJob(job: JobRecord & { payload: unknown }, signal: AbortSignal): Promise<void> {
    if (!job.songId && job.type !== 'runtimeInstall') throw new Error('JOB_SONG_MISSING')
    if (job.type === 'separate') await this.runSeparation(job.id, job.songId!, job.payload as SeparationPayload, signal)
    else if (job.type === 'guitarSplit') await this.runGuitarSplit(job.id, job.songId!, job.payload as GuitarSplitJobPayload, signal)
    else if (job.type === 'normalizeStems') await this.runNormalize(job.id, job.songId!, job.payload as NormalizePayload, signal)
    else if (job.type === 'export') {
      if (!this.exporter) throw new Error('EXPORT_SERVICE_NOT_READY')
      const payload = job.payload as ExportPayload
      this.setJobState(job.id, 'preparing', '准备导出', 0.01)
      await this.exporter.run(payload.request, payload.outputPaths, signal, (progress, phase) => {
        this.reportProgress(job.id, 'postprocessing', phase, progress)
      })
      this.setJobState(job.id, 'completed', '导出完成', 1)
      this.notify('导出完成', this.database.getSong(job.songId!)?.title ?? 'BandBuddy')
    }
  }

  private async runSeparation(jobId: string, songId: string, payload: SeparationPayload, signal: AbortSignal): Promise<void> {
    const settings = this.database.getSettings()
    const source = this.paths.resolveLibraryPath(settings.libraryRoot, payload.sourceRelPath)
    const songRoot = this.paths.songDirectory(settings.libraryRoot, songId)
    const taskRoot = path.join(songRoot, '.tasks', jobId)
    const workerRoot = path.join(taskRoot, 'worker')
    const preparedRoot = path.join(taskRoot, 'prepared')
    mkdirSync(workerRoot, { recursive: true })
    mkdirSync(preparedRoot, { recursive: true })
    let separationSource = source
    const videoSource = isVideoSource(source)
    if (videoSource) {
      this.setJobState(jobId, 'preparing', '正在提取视频音频', 0.01)
      this.changed()
      separationSource = path.join(taskRoot, 'video-audio.wav')
      await this.media.extractVideoAudio(source, path.join(taskRoot, 'video-audio.part.wav'), separationSource, signal)
      const previousVideo = this.database.getVideoRelative(songId)
      if (!previousVideo || !existsSync(this.paths.resolveLibraryPath(settings.libraryRoot, previousVideo))) {
        this.setJobState(jobId, 'preparing', '正在准备同步播放视频', 0.06)
        this.changed()
        const video = await this.media.prepareVideo(source, taskRoot, path.join(songRoot, 'source'), signal)
        this.database.setVideoRelative(songId, this.paths.toLibraryRelative(settings.libraryRoot, video))
      }
    } else {
      this.setJobState(jobId, 'preparing', '正在解码音频', 0.01)
      this.changed()
      separationSource = path.join(taskRoot, 'source-audio.wav')
      await this.media.decodeAudio(source, path.join(taskRoot, 'source-audio.part.wav'), separationSource, signal)
    }
    if (signal.aborted) throw new Error('JOB_CANCELLED')
    const preparationProgress = videoSource ? 0.12 : 0.01
    // Jobs queued by 1.x did not include a format snapshot and always produced FLAC.
    const storageFormat: StemStorageFormat = payload.storageFormat ?? 'flac24'
    const worker = await this.runStemWorker(
      jobId,
      { ...payload, storageFormat },
      'separate-demucs',
      separationSource,
      workerRoot,
      settings.modelRoot,
      preparationProgress,
      '正在生成基础分轨',
      signal
    )
    const encoded = await this.encodeWorkerStems(
      jobId,
      LEGACY_STEM_ORDER,
      worker.result,
      preparedRoot,
      storageFormat,
      '正在完成基础分轨',
      signal
    )
    const versionId = randomUUID()
    const finalRoot = path.join(songRoot, 'versions', versionId)
    mkdirSync(path.dirname(finalRoot), { recursive: true })
    await rename(preparedRoot, finalRoot)
    for (const stem of encoded.stored) {
      stem.relPath = this.paths.toLibraryRelative(settings.libraryRoot, path.join(finalRoot, `${stem.type}.${encoded.extension}`))
      stem.peaksRelPath = this.paths.toLibraryRelative(settings.libraryRoot, path.join(finalRoot, `${stem.type}.peaks.json`))
    }
    this.progress.cancel()
    this.database.publishBaseSeparationAndQueueGuitar(
      songId,
      jobId,
      RUNTIME_VERSIONS.modelRevision,
      worker.selected,
      encoded.stored,
      {
        sourceRelPath: payload.sourceRelPath,
        storageFormat,
        baseEncodingGain: encoded.encodingGain,
        targetDurationMs: encoded.targetDurationMs,
        guitarQuality: payload.guitarQuality ?? 'high',
        retry: 0,
        enableGuitarSplitOnSuccess: payload.enableGuitarSplitOnSuccess ?? false
      }
    )
    this.changed()
    await rm(taskRoot, { recursive: true, force: true })
    const song = this.database.getSong(songId)
    this.notify('基础分轨完成', `${song?.title ?? 'BandBuddy'} 已可进入练习室`)
  }

  private async runGuitarSplit(jobId: string, songId: string, payload: GuitarSplitJobPayload, signal: AbortSignal): Promise<void> {
    const settings = this.database.getSettings()
    const guitarQuality = payload.guitarQuality ?? 'high'
    const source = this.paths.resolveLibraryPath(settings.libraryRoot, payload.sourceRelPath)
    const songRoot = this.paths.songDirectory(settings.libraryRoot, songId)
    const taskRoot = path.join(songRoot, '.tasks', jobId)
    const workerRoot = path.join(taskRoot, 'worker')
    const preparedRoot = path.join(taskRoot, 'prepared')
    mkdirSync(workerRoot, { recursive: true })
    mkdirSync(preparedRoot, { recursive: true })
    let separationSource = source
    const videoSource = isVideoSource(source)
    if (videoSource) {
      this.setJobState(jobId, 'preparing', '正在提取视频音频', 0.01)
      this.changed()
      separationSource = path.join(taskRoot, 'video-audio.wav')
      await this.media.extractVideoAudio(source, path.join(taskRoot, 'video-audio.part.wav'), separationSource, signal)
    } else {
      this.setJobState(jobId, 'preparing', '正在解码音频', 0.01)
      this.changed()
      separationSource = path.join(taskRoot, 'source-audio.wav')
      await this.media.decodeAudio(source, path.join(taskRoot, 'source-audio.part.wav'), separationSource, signal)
    }
    if (signal.aborted) throw new Error('JOB_CANCELLED')
    const preparationProgress = videoSource ? 0.08 : 0.01
    const worker = await this.runStemWorker(
      jobId,
      payload,
      'separate-guitar',
      separationSource,
      workerRoot,
      settings.modelRoot,
      preparationProgress,
      guitarQuality === 'fast' ? '正在极速细分吉他轨（预览质量）' : '正在细分吉他轨',
      signal
    )
    const encoded = await this.encodeWorkerStems(
      jobId,
      GUITAR_SPLIT_STEMS,
      worker.result,
      preparedRoot,
      payload.storageFormat,
      '正在完成吉他细分',
      signal,
      payload.targetDurationMs,
      payload.baseEncodingGain
    )
    const versionId = randomUUID()
    const finalRoot = path.join(songRoot, 'versions', versionId)
    mkdirSync(path.dirname(finalRoot), { recursive: true })
    await rename(preparedRoot, finalRoot)
    for (const stem of encoded.stored) {
      stem.relPath = this.paths.toLibraryRelative(settings.libraryRoot, path.join(finalRoot, `${stem.type}.${encoded.extension}`))
      stem.peaksRelPath = this.paths.toLibraryRelative(settings.libraryRoot, path.join(finalRoot, `${stem.type}.peaks.json`))
    }
    this.progress.cancel()
    this.database.completeGuitarSplit(
      songId,
      jobId,
      payload,
      `${RUNTIME_VERSIONS.modelRevision}:guitar-${guitarQuality}`,
      worker.selected,
      encoded.stored
    )
    this.changed()
    await rm(taskRoot, { recursive: true, force: true })
    this.guitarSplitCompleted(songId)
    this.notify('吉他分轨完成', this.database.getSong(songId)?.title ?? 'BandBuddy')
  }

  private async runStemWorker(
    jobId: string,
    payload: SeparationPayload | GuitarSplitJobPayload,
    command: 'separate-demucs' | 'separate-guitar',
    source: string,
    workerRoot: string,
    modelRoot: string,
    preparationProgress: number,
    phase: string,
    signal: AbortSignal
  ): Promise<{
    result: Awaited<ReturnType<RuntimeManager['runWorker']>>
    selected: 'cuda' | 'mps' | 'cpu'
  }> {
    let selected = payload.deviceOverride ?? this.runtime.getInfo().selectedDevice
    let workerErrorCode: string | null = null
    const execute = async (): Promise<Awaited<ReturnType<RuntimeManager['runWorker']>>> => {
      workerErrorCode = null
      this.setJobState(jobId, 'preparing', phase, preparationProgress)
      this.changed()
      const workerArgs = [
        command, '--input', source, '--output', workerRoot, '--model-root', modelRoot, '--device', selected
      ]
      if (command === 'separate-guitar') {
        workerArgs.push('--quality', payload.guitarQuality ?? 'high')
      }
      return await this.runtime.runWorker(workerArgs, signal, 0, (message) => {
        if (message.type === 'error') workerErrorCode = String(message.code ?? 'WORKER_FAILED')
        if (message.type === 'progress') {
          const workerProgress = typeof message.progress === 'number' ? message.progress : 0
          const stage = String(message.stage ?? 'separating')
          const status = stage === 'preparing' ? 'preparing' : stage === 'postprocessing' ? 'postprocessing' : 'separating'
          this.reportProgress(
            jobId,
            status,
            stage === 'postprocessing' ? `正在完成${phase.replace('正在', '')}` : phase,
            Math.min(0.82, preparationProgress + workerProgress * (0.82 - preparationProgress))
          )
        }
      })
    }

    let result = await execute()
    let fallback = fallbackComputeDevice(selected, process.platform, workerErrorCode)
    while (result.code !== 0 && fallback && !signal.aborted) {
      selected = fallback
      this.database.updateJobPayload(jobId, {
        ...payload,
        deviceOverride: selected,
        retry: (payload.retry ?? 0) + 1
      })
      this.setJobState(jobId, 'preparing', '正在切换到 CPU 继续分轨', 0.02)
      await rm(workerRoot, { recursive: true, force: true })
      mkdirSync(workerRoot, { recursive: true })
      result = await execute()
      fallback = fallbackComputeDevice(selected, process.platform, workerErrorCode)
    }
    if (signal.aborted) throw new Error('JOB_CANCELLED')
    if (result.code !== 0) throw new Error(`${workerErrorCode ?? 'SEPARATION_FAILED'}:${result.error ?? ''}`)
    return { result, selected }
  }

  private async encodeWorkerStems(
    jobId: string,
    stems: readonly StemType[],
    result: Awaited<ReturnType<RuntimeManager['runWorker']>>,
    preparedRoot: string,
    storageFormat: StemStorageFormat,
    phase: string,
    signal: AbortSignal,
    requestedDurationMs?: number,
    gainLimit = 1
  ): Promise<{
    stored: StoredStemInput[]
    targetDurationMs: number
    encodingGain: number
    extension: 'flac' | 'mp3'
  }> {
    const files = result.result.files as Partial<Record<StemType, string>> | undefined
    if (!files || !stems.every((stem) => typeof files[stem] === 'string' && existsSync(files[stem]))) {
      throw new Error('INCOMPLETE_STEM_OUTPUT')
    }
    const workerStats = result.result.stats as Partial<Record<StemType, { peak?: unknown }>> | undefined
    if (!workerStats || !stems.every((stem) => {
      const peak = workerStats[stem]?.peak
      return typeof peak === 'number' && Number.isFinite(peak) && peak >= 0
    })) throw new Error('INVALID_STEM_PEAKS')
    const maximumPeak = Math.max(...stems.map((stem) => workerStats[stem]!.peak as number))
    const safeGain = maximumPeak > 0.999 ? 0.999 / maximumPeak : 1
    const encodingGain = Math.min(safeGain, gainLimit)
    const extension = storageFormat === 'flac24' ? 'flac' : 'mp3'
    this.setJobState(jobId, 'postprocessing', phase, 0.83)
    const probes = await Promise.all(stems.map((stem) => this.media.probe(files[stem]!)))
    const targetDurationMs = requestedDurationMs ?? Math.max(...probes.map((probe) => probe.durationMs))
    const stored: StoredStemInput[] = []
    for (let index = 0; index < stems.length; index += 1) {
      if (signal.aborted) throw new Error('JOB_CANCELLED')
      const stem = stems[index]!
      const finalStem = path.join(preparedRoot, `${stem}.${extension}`)
      const temporaryStem = path.join(preparedRoot, `${stem}.part.${extension}`)
      const peakFile = path.join(preparedRoot, `${stem}.peaks.json`)
      const probe = await this.media.normalize(files[stem]!, temporaryStem, finalStem, targetDurationMs, storageFormat, encodingGain)
      if (probe.sampleRate !== 44_100 || probe.channels !== 2) throw new Error(`STEM_FORMAT_VERIFY_FAILED:${stem}`)
      await this.media.generatePeaks(finalStem, peakFile, probe.durationMs, 1800, signal)
      stored.push({
        id: randomUUID(), type: stem, relPath: '', peaksRelPath: null,
        durationMs: probe.durationMs, sampleRate: probe.sampleRate ?? 44100, channels: probe.channels ?? 2
      })
      this.setJobState(jobId, 'postprocessing', phase, 0.83 + ((index + 1) / stems.length) * 0.16)
      this.changed()
    }
    return { stored, targetDurationMs, encodingGain, extension }
  }

  private async runNormalize(jobId: string, songId: string, payload: NormalizePayload, signal: AbortSignal): Promise<void> {
    const settings = this.database.getSettings()
    const songRoot = this.paths.songDirectory(settings.libraryRoot, songId)
    const taskRoot = path.join(songRoot, '.tasks', jobId)
    const preparedRoot = path.join(taskRoot, 'prepared')
    mkdirSync(preparedRoot, { recursive: true })
    const stored: StoredStemInput[] = []
    for (let index = 0; index < payload.files.length; index += 1) {
      if (signal.aborted) throw new Error('JOB_CANCELLED')
      const file = payload.files[index]!
      this.setJobState(jobId, 'postprocessing', `标准化 ${file.type}`, index / payload.files.length)
      this.changed()
      const input = this.paths.resolveLibraryPath(settings.libraryRoot, file.relPath)
      const output = path.join(preparedRoot, `${file.type}.flac`)
      const probe = await this.media.normalize(input, path.join(preparedRoot, `${file.type}.part.flac`), output, payload.targetDurationMs)
      const peakFile = path.join(preparedRoot, `${file.type}.peaks.json`)
      await this.media.generatePeaks(output, peakFile, probe.durationMs, 1800, signal)
      stored.push({
        id: randomUUID(), type: file.type, name: file.name, relPath: '', peaksRelPath: null,
        durationMs: probe.durationMs, sampleRate: probe.sampleRate ?? 44100, channels: probe.channels ?? 2
      })
    }
    const versionId = randomUUID()
    const finalRoot = path.join(songRoot, 'versions', versionId)
    mkdirSync(path.dirname(finalRoot), { recursive: true })
    await rename(preparedRoot, finalRoot)
    for (const stem of stored) {
      stem.relPath = this.paths.toLibraryRelative(settings.libraryRoot, path.join(finalRoot, `${stem.type}.flac`))
      stem.peaksRelPath = this.paths.toLibraryRelative(settings.libraryRoot, path.join(finalRoot, `${stem.type}.peaks.json`))
    }
    this.progress.cancel()
    this.database.activateSeparation(songId, jobId, 'imported-stems', 'cpu', stored)
    this.changed()
    await rm(taskRoot, { recursive: true, force: true })
    this.notify('分轨导入完成', this.database.getSong(songId)?.title ?? 'BandBuddy')
  }

  private async handleFailure(job: JobRecord, error: unknown, cancelled: boolean): Promise<void> {
    const text = String(error)
    const classified = classifyJobError(error, cancelled)
    const isCancelled = classified.cancelled
    const code = classified.code
    this.setJobState(job.id, isCancelled ? 'cancelled' : 'failed', isCancelled ? '已取消' : this.humanError(code), 0, code, text.slice(0, 1200))
    if (job.songId) {
      const settings = this.database.getSettings()
      const taskRoot = path.join(this.paths.songDirectory(settings.libraryRoot, job.songId), '.tasks', job.id)
      await rm(taskRoot, { recursive: true, force: true }).catch(() => undefined)
    }
    this.logger.error('job failed', { jobId: job.id, code, error: text })
    if (!isCancelled) this.notify('任务失败', this.humanError(code))
  }

  private humanError(code: string): string {
    if (code === 'ACCELERATOR_OOM' || code === 'CUDA_OOM') return '加速设备内存不足，CPU 分轨也未能完成'
    if (code === 'FFMPEG_MISSING') return '音频工具缺失，请修复应用资源'
    if (code === 'VIDEO_AUDIO_EXTRACTION_FAILED') return '视频音频提取失败，请检查源文件后重试'
    if (code === 'VIDEO_PREPARATION_FAILED') return '视频转码失败，请检查源文件或磁盘空间后重试'
    if (code === 'NO_AUDIO_STREAM') return '视频中没有可分轨的音频'
    if (code === 'NO_VIDEO_STREAM' || code === 'INVALID_VIDEO_DURATION') return '视频画面或时长无效'
    if (code === 'MODEL_HASH_MISMATCH') return '分轨资源校验失败，请清理缓存后重试'
    if (code === 'DISK_FULL') return '磁盘空间不足'
    return '任务执行失败，可查看日志后重试'
  }

  private notify(title: string, body: string): void {
    if (Notification.isSupported()) new Notification({ title, body, silent: false }).show()
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.database.getJob(jobId)
    if (!job) return
    if (this.active?.id === jobId) {
      this.setJobState(jobId, 'cancelling', '正在取消', job.progress)
      this.changed()
      this.active.controller.abort()
      return
    }
    if (['queued', 'blockedRuntime'].includes(job.status)) this.setJobState(jobId, 'cancelled', '已取消', job.progress, 'CANCELLED', null)
    this.changed()
  }

  async cancelSongJobs(songId: string): Promise<void> {
    const jobs = this.database.listJobs().filter((job) => job.songId === songId && !['completed', 'cancelled', 'failed'].includes(job.status))
    for (const job of jobs) await this.cancel(job.id)
    if (this.active?.songId === songId) {
      await new Promise<void>((resolve) => {
        const started = Date.now()
        const timer = setInterval(() => {
          if (this.active?.songId !== songId || Date.now() - started > 5_000) {
            clearInterval(timer)
            resolve()
          }
        }, 50)
      })
    }
  }

  retry(jobId: string, useCpu = false): void {
    const job = this.database.getJob(jobId)
    if (!job) return
    if (useCpu && (job.type === 'separate' || job.type === 'guitarSplit')) {
      const payload = job.payload as SeparationPayload | GuitarSplitJobPayload
      this.database.updateJobPayload(jobId, { ...payload, deviceOverride: 'cpu', retry: 0 })
    }
    this.database.retryJob(jobId)
    this.changed()
    this.kick()
  }

  interruptForExit(): void {
    if (this.stopping) return
    this.stopping = true
    this.progress.cancel()
    if (!this.active) return
    const job = this.database.getJob(this.active.id)
    this.active.controller.abort()
    if (job) this.setJobState(job.id, 'interrupted', '应用退出，任务可重试', job.progress, 'APP_INTERRUPTED', '应用在任务完成前退出')
  }

  async shutdown(): Promise<void> {
    this.interruptForExit()
    await this.drainTask
  }
}

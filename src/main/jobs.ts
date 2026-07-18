import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Notification } from 'electron'
import { STEM_ORDER, type ExportRequest, type JobRecord, type StemType } from '@shared/domain.js'
import type { BandBuddyDatabase, StoredStemInput } from './database.js'
import type { ExportService } from './exporter.js'
import type { Logger } from './logger.js'
import type { MediaService } from './media.js'
import type { AppPaths } from './paths.js'
import { RUNTIME_VERSIONS, type RuntimeManager } from './runtime.js'
import { fallbackComputeDevice } from './runtime-device.js'
import { classifyJobError } from './job-state.js'

interface SeparationPayload {
  sourceRelPath: string
  segment?: number
  retry?: number
  deviceOverride?: 'cuda' | 'mps' | 'cpu'
}

interface NormalizePayload {
  files: Array<{ type: StemType; relPath: string }>
  targetDurationMs: number
  padMismatched: boolean
}

interface ExportPayload {
  request: ExportRequest
  outputPaths: string[]
}

export class JobScheduler {
  private running = false
  private active: { id: string; songId: string | null; controller: AbortController } | null = null
  private exporter: ExportService | null = null

  constructor(
    private readonly paths: AppPaths,
    private readonly database: BandBuddyDatabase,
    private readonly runtime: RuntimeManager,
    private readonly media: MediaService,
    private readonly logger: Logger,
    private readonly changed: () => void,
    private readonly libraryChanged: () => void
  ) {
    runtime.onChange((info) => {
      if (info.status === 'ready') {
        database.unblockRuntimeJobs()
        this.kick()
      }
      changed()
    })
  }

  setExporter(exporter: ExportService): void {
    this.exporter = exporter
  }

  kick(): void {
    if (this.running) return
    this.running = true
    queueMicrotask(() => void this.drain())
  }

  private async drain(): Promise<void> {
    try {
      while (!this.active) {
        const job = this.database.nextQueuedJob()
        if (!job) break
        if (job.type === 'separate' && this.runtime.getInfo().status !== 'ready') {
          this.database.setJobState(job.id, 'blockedRuntime', '等待安装本地分离环境', 0)
          this.changed()
          continue
        }
        const controller = new AbortController()
        this.active = { id: job.id, songId: job.songId, controller }
        try {
          await this.runJob(job, controller.signal)
        } catch (error) {
          await this.handleFailure(job, error, controller.signal.aborted)
        } finally {
          this.active = null
          this.changed()
          this.libraryChanged()
        }
      }
    } finally {
      this.running = false
      if (!this.active && this.database.nextQueuedJob()) this.kick()
    }
  }

  private async runJob(job: JobRecord & { payload: unknown }, signal: AbortSignal): Promise<void> {
    if (!job.songId && job.type !== 'runtimeInstall') throw new Error('JOB_SONG_MISSING')
    if (job.type === 'separate') await this.runSeparation(job.id, job.songId!, job.payload as SeparationPayload, signal)
    else if (job.type === 'normalizeStems') await this.runNormalize(job.id, job.songId!, job.payload as NormalizePayload, signal)
    else if (job.type === 'export') {
      if (!this.exporter) throw new Error('EXPORT_SERVICE_NOT_READY')
      const payload = job.payload as ExportPayload
      this.database.setJobState(job.id, 'preparing', '准备导出', 0.01)
      await this.exporter.run(payload.request, payload.outputPaths, signal, (progress, phase) => {
        this.database.setJobState(job.id, 'postprocessing', phase, progress)
        this.changed()
      })
      this.database.setJobState(job.id, 'completed', '导出完成', 1)
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
    let selected = payload.deviceOverride ?? this.runtime.getInfo().selectedDevice
    let segment = payload.segment ?? 7
    let workerErrorCode: string | null = null
    let result: Awaited<ReturnType<RuntimeManager['runWorker']>>
    const execute = async (): Promise<Awaited<ReturnType<RuntimeManager['runWorker']>>> => {
      workerErrorCode = null
      this.database.setJobState(jobId, 'preparing', `加载 HTDemucs · ${selected.toUpperCase()}`, 0.01)
      this.changed()
      return await this.runtime.runWorker([
        'separate', '--input', source, '--output', workerRoot, '--model-root', settings.modelRoot,
        '--device', selected, '--segment', String(segment)
      ], signal, 0, (message) => {
        if (message.type === 'error') workerErrorCode = String(message.code ?? 'WORKER_FAILED')
        if (message.type === 'progress') {
          const workerProgress = typeof message.progress === 'number' ? message.progress : 0
          const stage = String(message.stage ?? 'separating')
          const status = stage === 'preparing' ? 'preparing' : stage === 'postprocessing' ? 'postprocessing' : 'separating'
          const phase = message.message ? String(message.message) : stage === 'separating' ? '正在分离六条音轨' : '准备分离'
          this.database.setJobState(jobId, status, phase, Math.min(0.82, workerProgress * 0.82))
          this.changed()
        }
      })
    }

    result = await execute()
    let fallback = fallbackComputeDevice(selected, process.platform, workerErrorCode)
    while (result.code !== 0 && fallback && !signal.aborted) {
      selected = fallback
      this.database.updateJobPayload(jobId, { ...payload, deviceOverride: selected, segment, retry: (payload.retry ?? 0) + 1 })
      this.database.setJobState(jobId, 'preparing', `当前加速设备不可用，自动切换到 ${selected.toUpperCase()}`, 0.02)
      await rm(workerRoot, { recursive: true, force: true })
      mkdirSync(workerRoot, { recursive: true })
      result = await execute()
      fallback = fallbackComputeDevice(selected, process.platform, workerErrorCode)
    }
    if (result.code !== 0 && workerErrorCode === 'CUDA_OOM' && selected === 'cuda' && segment > 4 && !signal.aborted) {
      segment = 4
      this.database.updateJobPayload(jobId, { ...payload, segment: 4, retry: (payload.retry ?? 0) + 1 })
      this.database.setJobState(jobId, 'preparing', '显存不足，自动以 4 秒分段重试', 0.02)
      await rm(workerRoot, { recursive: true, force: true })
      mkdirSync(workerRoot, { recursive: true })
      result = await execute()
    }
    if (signal.aborted) throw new Error('JOB_CANCELLED')
    if (result.code !== 0) {
      if (workerErrorCode === 'CUDA_OOM') throw new Error('CUDA_OOM_CPU_RETRY_AVAILABLE')
      throw new Error(`${workerErrorCode ?? 'SEPARATION_FAILED'}:${result.error ?? ''}`)
    }
    const files = result.result.files as Record<StemType, string> | undefined
    if (!files || !STEM_ORDER.every((stem) => typeof files[stem] === 'string' && existsSync(files[stem]))) throw new Error('INCOMPLETE_STEM_OUTPUT')

    this.database.setJobState(jobId, 'postprocessing', '标准化为 44.1 kHz / 24-bit FLAC', 0.83)
    const probes = await Promise.all(STEM_ORDER.map((stem) => this.media.probe(files[stem])))
    const targetDurationMs = Math.max(...probes.map((probe) => probe.durationMs))
    const stored: StoredStemInput[] = []
    for (let index = 0; index < STEM_ORDER.length; index += 1) {
      if (signal.aborted) throw new Error('JOB_CANCELLED')
      const stem = STEM_ORDER[index]!
      const stemId = randomUUID()
      const finalStem = path.join(preparedRoot, `${stem}.flac`)
      const temporaryStem = path.join(preparedRoot, `${stem}.part.flac`)
      const peakFile = path.join(preparedRoot, `${stem}.peaks.json`)
      const probe = await this.media.normalize(files[stem], temporaryStem, finalStem, targetDurationMs)
      await this.media.generatePeaks(finalStem, peakFile, probe.durationMs)
      stored.push({
        id: stemId, type: stem, relPath: '', peaksRelPath: null,
        durationMs: probe.durationMs, sampleRate: probe.sampleRate ?? 44100, channels: probe.channels ?? 2
      })
      this.database.setJobState(jobId, 'postprocessing', `处理 ${stem}`, 0.83 + ((index + 1) / STEM_ORDER.length) * 0.16)
      this.changed()
    }
    const versionId = randomUUID()
    const finalRoot = path.join(songRoot, 'versions', versionId)
    mkdirSync(path.dirname(finalRoot), { recursive: true })
    await rename(preparedRoot, finalRoot)
    for (const stem of stored) {
      stem.relPath = this.paths.toLibraryRelative(settings.libraryRoot, path.join(finalRoot, `${stem.type}.flac`))
      stem.peaksRelPath = this.paths.toLibraryRelative(settings.libraryRoot, path.join(finalRoot, `${stem.type}.peaks.json`))
    }
    this.database.activateSeparation(songId, jobId, RUNTIME_VERSIONS.modelRevision, selected, stored)
    await rm(taskRoot, { recursive: true, force: true })
    const song = this.database.getSong(songId)
    this.notify('分轨完成', song?.title ?? 'BandBuddy')
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
      this.database.setJobState(jobId, 'postprocessing', `标准化 ${file.type}`, index / payload.files.length)
      this.changed()
      const input = this.paths.resolveLibraryPath(settings.libraryRoot, file.relPath)
      const output = path.join(preparedRoot, `${file.type}.flac`)
      const probe = await this.media.normalize(input, path.join(preparedRoot, `${file.type}.part.flac`), output, payload.targetDurationMs)
      const peakFile = path.join(preparedRoot, `${file.type}.peaks.json`)
      await this.media.generatePeaks(output, peakFile, probe.durationMs)
      stored.push({
        id: randomUUID(), type: file.type, relPath: '', peaksRelPath: null,
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
    this.database.activateSeparation(songId, jobId, 'imported-stems', 'cpu', stored)
    await rm(taskRoot, { recursive: true, force: true })
    this.notify('分轨导入完成', this.database.getSong(songId)?.title ?? 'BandBuddy')
  }

  private async handleFailure(job: JobRecord, error: unknown, cancelled: boolean): Promise<void> {
    const text = String(error)
    const classified = classifyJobError(error, cancelled)
    const isCancelled = classified.cancelled
    const code = classified.code
    this.database.setJobState(job.id, isCancelled ? 'cancelled' : 'failed', isCancelled ? '已取消' : this.humanError(code), 0, code, text.slice(0, 1200))
    if (job.songId) {
      const settings = this.database.getSettings()
      const taskRoot = path.join(this.paths.songDirectory(settings.libraryRoot, job.songId), '.tasks', job.id)
      await rm(taskRoot, { recursive: true, force: true }).catch(() => undefined)
    }
    this.logger.error('job failed', { jobId: job.id, code, error: text })
    if (!isCancelled) this.notify('任务失败', this.humanError(code))
  }

  private humanError(code: string): string {
    if (code === 'CUDA_OOM') return '显存仍不足，可使用 CPU 重试'
    if (code === 'FFMPEG_MISSING') return '音频工具缺失，请修复应用资源'
    if (code === 'MODEL_HASH_MISMATCH') return '模型校验失败，请清理模型缓存后重试'
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
      this.database.setJobState(jobId, 'cancelling', '正在取消', job.progress)
      this.changed()
      this.active.controller.abort()
      return
    }
    if (['queued', 'blockedRuntime'].includes(job.status)) this.database.setJobState(jobId, 'cancelled', '已取消', job.progress, 'CANCELLED', null)
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
    if (useCpu && job.type === 'separate') {
      const payload = job.payload as SeparationPayload
      this.database.updateJobPayload(jobId, { ...payload, deviceOverride: 'cpu', segment: 7, retry: 0 })
    }
    this.database.retryJob(jobId)
    this.changed()
    this.kick()
  }

  interruptForExit(): void {
    if (!this.active) return
    const job = this.database.getJob(this.active.id)
    this.active.controller.abort()
    if (job) this.database.setJobState(job.id, 'interrupted', '应用退出，任务可重试', job.progress, 'APP_INTERRUPTED', '应用在任务完成前退出')
  }
}

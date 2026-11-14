import { app, dialog } from 'electron'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { DEFAULT_SCORE_SETTINGS, scoreCreateSchema, scorePracticeSchema, scoreSettingsSchema, type ScoreData, type ScoreModel, type ScorePractice, type ScoreProject, type ScoreSettings, type ScoreSource } from '@shared/scores.js'
import type { JobRecord, JobStatus } from '@shared/domain.js'
import type { BandBuddyDatabase } from './database.js'
import type { AppPaths } from './paths.js'
import type { MediaService } from './media.js'
import type { RuntimeManager } from './runtime.js'
import { ScoreRuntimeManager } from './score-runtime.js'
import { fileDigest, writeJsonAtomic } from './artifact-download.js'
import { runProcess, processFailure } from './process.js'
import { DiagnosticError } from './diagnostic-errors.js'

interface ScoreJob { projectId: string; mode: 'infer' | 'render'; model: ScoreModel; device: ScoreProject['device']; settings: ScoreSettings }
const finished = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
export class ScoreService {
  readonly runtime: ScoreRuntimeManager
  private cancelJob: (id: string) => Promise<void> = async () => {}
  constructor(private paths: AppPaths, private db: BandBuddyDatabase, private media: MediaService, runtime: RuntimeManager, private changed: () => void, private kick: () => void) {
    this.runtime = new ScoreRuntimeManager(paths, db, runtime, () => { this.unblock(); this.changed() })
  }
  setCancel(callback: (id: string) => Promise<void>): void { this.cancelJob = callback }
  directory(id: string): string { z.string().uuid().parse(id); return path.join(this.db.getSettings().libraryRoot, '_scores', id) }
  private row(id: string): ScoreProject | null {
    const row = this.db.sqlite.prepare('SELECT json FROM score_projects WHERE id=?').get(id) as { json: string } | undefined
    return row ? JSON.parse(row.json) as ScoreProject : null
  }
  private save(project: ScoreProject): void {
    const { data: _data, ...record } = project
    this.db.sqlite.prepare('INSERT INTO score_projects(id,json,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at')
      .run(project.id, JSON.stringify({ ...record, data: null }), project.updatedAt)
  }
  list(): ScoreProject[] {
    const rows = this.db.sqlite.prepare('SELECT json FROM score_projects ORDER BY updated_at DESC').all() as { json: string }[]
    return rows.map(row => this.withJob(JSON.parse(row.json)))
  }
  private withJob(project: ScoreProject): ScoreProject {
    const job = project.jobId ? this.db.getJob(project.jobId) : null
    return { ...project, status: job?.status ?? (project.activeRun ? 'completed' : 'new'), progress: job?.progress ?? 0, phase: job?.phase ?? (project.activeRun ? '乐谱已就绪' : '等待转谱'), error: job?.errorMessage ?? null }
  }
  async get(id: string, opened = false): Promise<ScoreProject | null> {
    const project = this.row(id)
    if (!project) return null
    if (opened) { project.openedAt = new Date().toISOString(); this.save(project) }
    if (project.activeRun) project.data = JSON.parse(await readFile(this.dataPath(project), 'utf8')) as ScoreData
    return this.withJob(project)
  }
  private dataPath(project: ScoreProject): string { return path.join(this.directory(project.id), 'runs', z.string().uuid().parse(project.activeRun), 'score.json') }
  async create(input: z.infer<typeof scoreCreateSchema>): Promise<ScoreProject | null> {
    input = scoreCreateSchema.parse(input)
    const candidates: { file: string; name: string; stemType?: string }[] = []
    let title = input.title ?? ''
    if (input.songId) {
      const row = this.db.getSongRow(input.songId), song = this.db.getSong(input.songId)
      if (!row || !song) throw new Error('歌曲不存在')
      title ||= song.title
      if (input.stemIds?.length) {
        for (const id of [...new Set(input.stemIds)]) {
          const file = this.db.getStemAsset(input.songId, id), stem = song.stems.find(s => s.id === id)
          if (!file || !stem) throw new Error('所选音轨已改变，请重新选择')
          candidates.push({ file: this.paths.resolveLibraryPath(this.db.getSettings().libraryRoot, file.relPath), name: stem.name || stem.type, stemType: stem.type })
        }
      } else {
        if (!row.source_rel_path) throw new Error('这首歌没有保留原始音频，请选择已有音轨转谱')
        candidates.push({ file: this.paths.resolveLibraryPath(this.db.getSettings().libraryRoot, row.source_rel_path), name: title })
      }
    } else {
      const selected = await dialog.showOpenDialog({ title: '导入藏经阁 · 音频转谱', properties: ['openFile'], filters: [{ name: '音频', extensions: ['wav', 'flac', 'mp3', 'm4a', 'ogg', 'opus', 'aiff', 'aif', 'wma'] }] })
      if (selected.canceled || !selected.filePaths[0]) return null
      const file = selected.filePaths[0]; title ||= path.basename(file, path.extname(file)); candidates.push({ file, name: title })
    }
    const id = randomUUID(), directory = this.directory(id), sources: ScoreSource[] = []
    await mkdir(path.join(directory, 'source'), { recursive: true })
    try {
      for (const c of candidates) {
        const probe = await this.media.probe(c.file)
        if (!Number.isFinite(probe.durationMs) || probe.durationMs <= 0 || probe.durationMs > 1800_000) throw new Error('请选择时长不超过 30 分钟的有效音频')
        const sid = randomUUID(), file = `source/${sid}${path.extname(c.file).toLowerCase()}`
        await copyFile(c.file, path.join(directory, file))
        sources.push({ id: sid, file, name: c.name, stemType: c.stemType, duration: probe.durationMs / 1000, hash: await fileDigest(path.join(directory, file)) })
      }
      const now = new Date().toISOString()
      const project: ScoreProject = { id, title, sourceSongId: input.songId ?? null, sources, model: this.runtime.get().device === 'cpu' ? 'small' : 'medium', device: 'auto',
        createdAt: now, updatedAt: now, openedAt: now, activeRun: null, settings: { ...DEFAULT_SCORE_SETTINGS, tunings: {} },
        practice: { rate: 1, position: 0, loop: null, tracks: {} }, data: null, jobId: null, status: 'new', phase: '等待转谱', progress: 0, error: null }
      this.save(project); this.changed(); return project
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  }
  private queue(id: string, mode: ScoreJob['mode'], model?: ScoreModel, device?: ScoreProject['device'], settings?: ScoreSettings): string {
    const project = this.row(id)
    if (!project) throw new Error('乐谱不存在')
    const previous = project.jobId ? this.db.getJob(project.jobId) : null
    if (previous && !finished.has(previous.status)) throw new Error('该作品已有任务，请等待完成或先取消')
    if (mode === 'render' && !project.activeRun) throw new Error('请先完成转谱')
    const state = this.runtime.get(), chosen = model ?? project.model
    const ready = !state.busy && state.ready && (mode === 'render' || state.models[chosen])
    const payload: ScoreJob = { projectId: id, mode, model: chosen, device: device ?? project.device, settings: settings ?? project.settings }
    const jobId = this.db.createJob('transcribe', null, ready ? 'queued' : 'blockedRuntime', ready ? (mode === 'infer' ? '等待转谱' : '等待重新生成谱面') : '等待转谱组件与所选模型', payload)
    this.db.sqlite.prepare('UPDATE jobs SET score_project_id=? WHERE id=?').run(id, jobId)
    project.jobId = jobId; project.model = chosen; project.device = payload.device; project.updatedAt = new Date().toISOString(); this.save(project)
    this.changed(); this.kick(); return jobId
  }
  transcribe(id: string, model: ScoreModel, device: ScoreProject['device'] = 'auto'): string { return this.queue(id, 'infer', z.enum(['small', 'medium', 'large']).parse(model), z.enum(['auto', 'cpu', 'cuda', 'mps']).parse(device)) }
  render(id: string, settings: ScoreSettings): string { return this.queue(id, 'render', undefined, undefined, scoreSettingsSchema.parse(settings)) }
  unblock(): void {
    const state = this.runtime.get()
    if (!state.ready || state.busy) return
    for (const j of this.db.listJobs().filter(j => j.type === 'transcribe' && j.status === 'blockedRuntime')) {
      const job = this.db.getJob(j.id)!, payload = job.payload as ScoreJob
      if (payload.mode === 'render' || state.models[payload.model]) this.db.setJobState(j.id, 'queued', '等待转谱', 0)
    }
    this.kick()
  }
  retry(job: JobRecord & { payload: unknown }, useCpu: boolean): void {
    if (!['failed', 'cancelled', 'interrupted'].includes(job.status)) return
    const payload = job.payload as ScoreJob, project = this.row(payload.projectId)
    if (!project) throw new Error('乐谱已被删除')
    const active = project.jobId ? this.db.getJob(project.jobId) : null
    if (active && active.id !== job.id && !finished.has(active.status)) throw new Error('该作品已有任务，请等待完成或先取消')
    if (useCpu) payload.device = 'cpu'
    this.db.updateJobPayload(job.id, payload)
    project.jobId = job.id; project.model = payload.model; project.device = payload.device; this.save(project)
    this.db.retryJob(job.id)
    const ready = this.runtime.get()
    if (ready.busy || !ready.ready || payload.mode === 'infer' && !ready.models[payload.model]) this.db.setJobState(job.id, 'blockedRuntime', '等待转谱组件与所选模型', 0)
    this.changed(); this.kick()
  }
  private async worker(request: object, output: string, signal?: AbortSignal, progress?: (phase: string, value: number) => void): Promise<Record<string, unknown>[]> {
    await mkdir(output, { recursive: true })
    const requestPath = path.join(output, 'request.json'); await writeJsonAtomic(requestPath, request)
    const script = app.isPackaged ? this.paths.packagedResource('worker', 'score_worker.py') : path.resolve('python/worker/score_worker.py')
    const messages: Record<string, unknown>[] = []
    const result = await runProcess(this.runtime.python(), [script, '--request', requestPath, '--out', output], {
      env: await this.runtime.environment(), signal, timeoutMs: 12 * 60 * 60_000, maxOutputChars: 4 * 1024 * 1024, stage: 'score-worker',
      onStdoutLine: line => { try { const m = JSON.parse(line); if (m.type === 'progress') progress?.(m.phase, m.progress); else messages.push(m) } catch { /* upstream diagnostics are not protocol messages */ } }
    })
    signal?.throwIfAborted()
    if (result.code !== 0) {
      const message = String(messages.find(m => m.type === 'error')?.error ?? processFailure(result, 'SCORE_WORKER_FAILED'))
      if (/out of memory/i.test(message)) throw new DiagnosticError(/cuda|mps/i.test(message) ? 'ACCELERATOR_OOM' : 'CPU_OUT_OF_MEMORY', `${message}。可选择 CPU 或较小模型重试。`)
      throw new Error(message)
    }
    return messages
  }
  async run(job: JobRecord & { payload: unknown }, signal: AbortSignal, progress: (status: JobStatus, phase: string, value: number) => void): Promise<void> {
    const payload = job.payload as ScoreJob, project = this.row(payload.projectId)
    if (!project) throw new Error('乐谱已被删除')
    // Stage on the score volume: rename must stay atomic even when the library
    // lives on another drive. Retrying an interrupted job starts a clean stage.
    const root = this.directory(project.id), task = path.join(root, '.tasks', z.string().uuid().parse(job.id)), output = path.join(task, 'result')
    progress('preparing', '准备转谱素材', .01)
    try {
      await rm(task, { recursive: true, force: true })
      await mkdir(task, { recursive: true })
      const request: Record<string, unknown> = { ...payload, settings: payload.settings }
      if (payload.mode === 'infer') {
        await this.runtime.validate(payload.model)
        const ffmpeg = await this.media.tool('ffmpeg')
        if (!ffmpeg) throw new Error('FFMPEG_MISSING')
        const sources = []
        for (const source of project.sources) {
          const input = this.paths.resolveLibraryPath(root, source.file), audio = path.join(task, `${source.id}.wav`)
          if (await fileDigest(input) !== source.hash) throw new Error('源音频校验失败，请重新导入')
          const result = await runProcess(ffmpeg, ['-y', '-v', 'error', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_f32le', audio], { signal, timeoutMs: 180_000 })
          if (result.code !== 0) throw processFailure(result, 'SCORE_DECODE_FAILED')
          sources.push({ ...source, audio })
        }
        const beatAudio = path.join(task, 'beat.wav')
        const decoded = await runProcess(ffmpeg, ['-y', '-v', 'error', ...sources.flatMap(s => ['-i', s.audio]), '-filter_complex', `${sources.map((_, i) => `[${i}:a]`).join('')}amix=inputs=${sources.length}:normalize=1:duration=longest[out]`, '-map', '[out]', '-ar', '22050', '-ac', '1', '-c:a', 'pcm_f32le', beatAudio], { signal, timeoutMs: 180_000 })
        if (decoded.code !== 0) throw processFailure(decoded, 'SCORE_BEAT_AUDIO_FAILED')
        Object.assign(request, { sources, weights: this.runtime.weights(payload.model), beatAudio, beatCheckpoint: await this.runtime.beatCheckpoint(signal) })
      } else request.dataPath = this.dataPath(project)
      await this.worker(request, output, signal, (phase, value) => progress('transcribing', phase, value))
      progress('postprocessing', '保存 MIDI 与乐谱', .97)
      const data = JSON.parse(await readFile(path.join(output, 'score.json'), 'utf8')) as ScoreData
      if (data.version !== 1 || !data.tracks?.length || !existsSync(path.join(output, 'raw.mid'))) throw new Error('转谱结果不完整')
      signal.throwIfAborted()
      const run = randomUUID(); await mkdir(path.join(root, 'runs'), { recursive: true }); await rename(output, path.join(root, 'runs', run))
      // Only a fully written run becomes visible; previous runs survive failure/cancellation.
      const latest = this.row(project.id)
      if (!latest) throw new Error('乐谱已被删除')
      latest.activeRun = run; latest.settings = payload.settings; latest.updatedAt = new Date().toISOString(); this.save(latest)
      progress('completed', data.warnings.length ? '转谱完成 · 请查看谱面提示' : '转谱完成', 1); this.changed()
    } finally { await rm(task, { recursive: true, force: true }).catch(() => {}) }
  }
  savePractice(id: string, practice: ScorePractice): void { const p = this.row(id); if (!p) return; p.practice = scorePracticeSchema.parse(practice); this.save(p) }
  async notation(id: string, trackIds: string[], tab: boolean, startBar: number): Promise<{ xml: string; startBeat: number; bars: number }> {
    const project = this.row(id)
    if (!project?.activeRun) throw new Error('乐谱尚未生成')
    const key = createHash('sha256').update(JSON.stringify([project.activeRun, trackIds, tab, startBar])).digest('hex')
    const cache = path.join(this.directory(id), 'notation', key)
    if (existsSync(path.join(cache, 'page.json'))) return JSON.parse(await readFile(path.join(cache, 'page.json'), 'utf8'))
    const messages = await this.worker({ mode: 'notation', settings: project.settings, dataPath: this.dataPath(project), trackIds, tab, startBar }, cache)
    const value = messages.find(m => m.type === 'notation')
    if (!value) throw new Error('谱面生成失败')
    const result = { xml: String(value.xml), startBeat: Number(value.startBeat), bars: Number(value.bars) }
    await writeJsonAtomic(path.join(cache, 'page.json'), result); return result
  }
  async export(id: string, trackIds: string[], format: 'midi' | 'musicxml', quantized: boolean, tab: boolean): Promise<string | null> {
    const project = this.row(id)
    if (!project?.activeRun) throw new Error('请先完成转谱')
    const extension = format === 'midi' ? 'mid' : 'musicxml'
    const chosen = await dialog.showSaveDialog({ title: '导出乐谱', defaultPath: `${project.title.replace(/[<>:"/\\|?*]/g, '_')}.${extension}`, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] })
    if (chosen.canceled || !chosen.filePath) return null
    const temporary = this.paths.jobDirectory(randomUUID())
    try {
      await this.worker({ mode: 'export', dataPath: this.dataPath(project), settings: project.settings, trackIds }, temporary)
      const filename = format === 'midi' ? (quantized ? 'quantized.mid' : 'raw.mid') : tab ? 'tab.musicxml' : 'score.musicxml'
      if (!existsSync(path.join(temporary, filename))) throw new Error('谱面未能生成，MIDI 仍可导出')
      await copyFile(path.join(temporary, filename), chosen.filePath); return chosen.filePath
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
  async delete(id: string): Promise<void> {
    const project = this.row(id); if (!project) return
    if (project.jobId) await this.cancelJob(project.jobId)
    this.db.sqlite.prepare('DELETE FROM jobs WHERE score_project_id=?').run(id)
    this.db.sqlite.prepare('DELETE FROM score_projects WHERE id=?').run(id)
    await rm(this.directory(id), { recursive: true, force: true }); this.changed()
  }
  async soundfont(): Promise<Uint8Array> {
    const file = this.runtime.fontPath
    if (!existsSync(file) || (await stat(file)).size > 100 * 1024 * 1024) throw new Error('播放音色尚未准备，请打开转谱组件设置')
    return new Uint8Array(await readFile(file))
  }
}

import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BandBuddyDatabase } from '../src/main/database.js'
import { ScoreService } from '../src/main/scores.js'
import { AppPaths } from '../src/main/paths.js'
import { JobScheduler } from '../src/main/jobs.js'
import type { RuntimeManager } from '../src/main/runtime.js'
import type { MediaService } from '../src/main/media.js'
import type { Logger } from '../src/main/logger.js'
import { DEFAULT_SCORE_SETTINGS, scorePlaybackMidi, scorePracticeSchema, type ScoreData } from '../packages/shared/src/scores.js'

vi.mock('electron', () => ({ app: { isPackaged: false }, dialog: {}, safeStorage: {}, Notification: { isSupported: () => false } }))
vi.mock('better-sqlite3', () => ({ default: class extends DatabaseSync {
  pragma(sql: string) { this.exec(`PRAGMA ${sql}`) }
  transaction(fn: (...args: unknown[]) => unknown) {
    const run = (...args: unknown[]) => { this.exec('BEGIN'); try { const v = fn(...args); this.exec('COMMIT'); return v } catch (e) { this.exec('ROLLBACK'); throw e } }
    return Object.assign(run, { deferred: run, immediate: run, exclusive: run })
  }
} }))

const roots: string[] = [], databases: BandBuddyDatabase[] = [], schedulers: JobScheduler[] = []
afterEach(async () => { for (const s of schedulers.splice(0)) await s.shutdown(); for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() })
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bb-scores-')); roots.push(root)
  const paths = Object.assign(Object.create(AppPaths.prototype) as AppPaths, { databasePath: path.join(root, 'db'), backupRoot: path.join(root, 'backups'), defaultLibraryRoot: root, pythonRoot: root, modelRoot: root, jobsRoot: path.join(root, 'jobs') })
  const db = new BandBuddyDatabase(paths); databases.push(db)
  await writeFile(path.join(root, 'original.wav'), 'test audio snapshot')
  const songId = db.createSong({ title: '独立谱库', artist: '', sourceRelPath: 'original.wav', sourceFormat: 'wav', sourceHash: '', durationMs: 8000, sampleRate: 16000, channels: 1, artworkRelPath: null, status: 'ready' })
  const runtime = { getInfo: () => ({ selectedDevice: 'cpu', status: 'ready' }), onChange: vi.fn() } as unknown as RuntimeManager
  const service = new ScoreService(paths, db, { probe: async () => ({ durationMs: 8000 }) } as unknown as MediaService, runtime, vi.fn(), vi.fn())
  const project = (await service.create({ songId }))!
  return { root, paths, db, songId, runtime, service, project }
}
const data: ScoreData = { version: 1, duration: 8, tempo: { points: [{ time: 0, beat: 0 }, { time: 8, beat: 16 }], bpm: 120, numerator: 4, denominator: 4, firstDownbeat: 0, provisional: false }, warnings: [], tracks: [{ id: 'guitar', sourceId: 'original', name: 'Guitar', instrument: 'clean_electric_guitar', program: 26, isDrum: false, notes: [{ id: 'n1', pitch: 64, start: .25, end: 5.75, velocity: 100 }] }] }
async function completed(f: Awaited<ReturnType<typeof setup>>) {
  const run = randomUUID(), dir = path.join(f.service.directory(f.project.id), 'runs', run)
  await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'score.json'), JSON.stringify(data)); await writeFile(path.join(dir, 'raw.mid'), scorePlaybackMidi(data).bytes)
  f.db.sqlite.prepare('UPDATE score_projects SET json=? WHERE id=?').run(JSON.stringify({ ...f.project, activeRun: run }), f.project.id)
  vi.spyOn(f.service.runtime, 'get').mockReturnValue({ ready: true, busy: false, stage: '', progress: 1, device: 'cpu', models: { small: true, medium: false, large: false }, soundfont: true, accepted: true, hasToken: false, error: null })
  return run
}

describe('independent score projects and task lifecycle', () => {
  it('snapshots audio and survives deleting the originating song', async () => {
    const f = await setup(), p = f.project
    expect(p.sourceSongId).toBe(f.songId)
    f.db.deleteSongRecord(f.songId); await rm(path.join(f.root, 'original.wav'))
    expect(await readFile(path.join(f.service.directory(p.id), p.sources[0]!.file), 'utf8')).toBe('test audio snapshot')
    expect((await f.service.get(p.id))!.id).toBe(p.id)
  })
  it('blocks on its own environment and is not unblocked by separation readiness', async () => {
    const f = await setup(), id = f.service.transcribe(f.project.id, 'small')
    expect(f.db.getJob(id)).toMatchObject({ type: 'transcribe', songId: null, scoreProjectId: f.project.id, status: 'blockedRuntime' })
    f.db.unblockRuntimeJobs()
    expect(f.db.getJob(id)!.status).toBe('blockedRuntime')
    await completed(f); f.service.unblock()
    expect(f.db.getJob(id)!.status).toBe('queued')
    expect(f.db.getSong(f.songId)!.status).toBe('ready')
  })
  it('failure, retry and startup interruption cannot mark the song failed', async () => {
    const f = await setup()
    const id = f.db.createJob('transcribe', f.songId, 'queued', 'test', {}) // Also protects migrated legacy references.
    f.db.setJobState(id, 'failed', 'failed', 0); expect(f.db.getSong(f.songId)!.status).toBe('ready')
    f.db.retryJob(id); expect(f.db.getSong(f.songId)!.status).toBe('ready')
    f.db.setJobState(id, 'transcribing', 'transcribing', .5)
    f.db.close(); databases.splice(databases.indexOf(f.db), 1)
    const reopened = new BandBuddyDatabase(f.paths); databases.push(reopened)
    expect(reopened.getJob(id)!.status).toBe('interrupted')
    expect(reopened.getSong(f.songId)!.status).toBe('ready')
  })
  it('failed regeneration preserves old active data and settings', async () => {
    const f = await setup(), old = await completed(f), id = f.service.render(f.project.id, { ...DEFAULT_SCORE_SETTINGS, bpm: 90 })
    vi.spyOn(f.service as unknown as { worker(request: unknown, output: string): Promise<Record<string, unknown>[]> }, 'worker').mockRejectedValue(new Error('notation failed'))
    await expect(f.service.run(f.db.getJob(id)!, new AbortController().signal, () => {})).rejects.toThrow('notation failed')
    expect(await f.service.get(f.project.id)).toMatchObject({ activeRun: old, data, settings: { bpm: null } })
  })
  it('cancellation before publication retains old active revision', async () => {
    const f = await setup(), old = await completed(f), id = f.service.render(f.project.id, DEFAULT_SCORE_SETTINGS)
    const controller = new AbortController()
    vi.spyOn(f.service as unknown as { worker(request: unknown, output: string): Promise<Record<string, unknown>[]> }, 'worker').mockImplementation(async (_request: unknown, output: string) => {
      await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'score.json'), JSON.stringify(data)); await writeFile(path.join(output, 'raw.mid'), scorePlaybackMidi(data).bytes)
      controller.abort(); return []
    })
    await expect(f.service.run(f.db.getJob(id)!, controller.signal, () => {})).rejects.toThrow()
    expect((await f.service.get(f.project.id))!.activeRun).toBe(old)
  })
  it('publishes a complete revision and commits settings only after successful generation', async () => {
    const f = await setup(), old = await completed(f), id = f.service.render(f.project.id, { ...DEFAULT_SCORE_SETTINGS, bpm: 90 })
    vi.spyOn(f.service as unknown as { worker(request: unknown, output: string): Promise<Record<string, unknown>[]> }, 'worker').mockImplementation(async (_request: unknown, output: string) => {
      await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'score.json'), JSON.stringify(data)); await writeFile(path.join(output, 'raw.mid'), scorePlaybackMidi(data).bytes); return []
    })
    await f.service.run(f.db.getJob(id)!, new AbortController().signal, (status, phase, progress) => f.db.setJobState(id, status, phase, progress))
    const result = await f.service.get(f.project.id)
    expect(result!.activeRun).not.toBe(old); expect(result!.settings.bpm).toBe(90)
    expect(existsSync(path.join(f.service.directory(f.project.id), 'runs', old, 'score.json'))).toBe(true)
    expect(result!.status).toBe('completed')
  })
  it('runs the real Python postprocessor and reads paginated staff/TAB without loading a model', async () => {
    const f = await setup(); await completed(f)
    vi.spyOn(f.service.runtime, 'python').mockReturnValue(process.env.BANDBUDDY_SCORE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'))
    vi.spyOn(f.service.runtime, 'environment').mockResolvedValue({ ...process.env, PYTHONUTF8: '1' })
    const job = f.service.render(f.project.id, { ...DEFAULT_SCORE_SETTINGS, bpm: 100, subdivision: 3 })
    await f.service.run(f.db.getJob(job)!, new AbortController().signal, (state, phase, progress) => f.db.setJobState(job, state, phase, progress))
    const project = (await f.service.get(f.project.id))!
    expect(project.data!.tracks[0]!.notes[0]).toMatchObject({ start: .25, end: 5.75, id: 'n1' })
    expect(project.data!.tracks[0]!.notes[0]!.beat).toBeCloseTo(1 / 3)
    const page = await f.service.notation(project.id, ['guitar'], true, 0)
    expect(page.xml).toContain('<sign>TAB</sign>'); expect(page.xml).toContain('<time-modification>')
    const output = path.join(f.service.directory(project.id), 'runs', project.activeRun!)
    expect((await readFile(path.join(output, 'quantized.mid'))).subarray(0, 4).toString()).toBe('MThd')
    expect(await readFile(path.join(output, 'score.musicxml'), 'utf8')).toContain('<score-partwise')
  })
  it('refuses an old retry while another job owns the project; explicit CPU retry retains the model', async () => {
    const f = await setup(); await completed(f)
    const first = f.service.transcribe(f.project.id, 'small', 'cuda'); f.db.setJobState(first, 'failed', 'OOM', 0)
    const second = f.service.transcribe(f.project.id, 'small', 'cuda')
    expect(() => f.service.retry(f.db.getJob(first)!, true)).toThrow('已有任务')
    f.db.setJobState(second, 'failed', 'OOM', 0); f.service.retry(f.db.getJob(second)!, true)
    expect(f.db.getJob(second)!.payload).toMatchObject({ device: 'cpu', model: 'small' })
    expect((await f.service.get(f.project.id))!.device).toBe('cpu')
  })
  it('defers transcription during live capture and cancels a running worker before deletion', async () => {
    const f = await setup(); await completed(f)
    let live = true
    const scheduler = new JobScheduler(f.paths, f.db, f.runtime, {} as MediaService, { error: vi.fn() } as unknown as Logger, vi.fn(), vi.fn(), undefined, undefined, () => live)
    schedulers.push(scheduler); scheduler.setScores(f.service); f.service.setCancel(id => scheduler.cancelAndWait(id))
    const run = vi.spyOn(f.service, 'run').mockImplementation(async (_job, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('JOB_CANCELLED')), { once: true })))
    const id = f.service.transcribe(f.project.id, 'small'); scheduler.kick(); await new Promise(resolve => setTimeout(resolve, 30)); expect(run).not.toHaveBeenCalled()
    live = false; scheduler.kick(); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    await f.service.delete(f.project.id)
    expect(f.db.getJob(id)).toBeNull(); expect(await f.service.get(f.project.id)).toBeNull()
    expect(existsSync(f.service.directory(f.project.id))).toBe(false)
  })
  it('rejects paths outside the managed score directory and invalid practice loops', async () => {
    const f = await setup()
    expect(() => f.service.directory('../original')).toThrow()
    expect(() => scorePracticeSchema.parse({ rate: 3.1, position: 0, loop: null, tracks: {} })).toThrow()
    expect(() => scorePracticeSchema.parse({ rate: 1, position: 0, loop: { a: 2, b: 1 }, tracks: {} })).toThrow()
  })
})

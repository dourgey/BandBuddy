import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { GUITAR_SPLIT_STEMS, LEGACY_STEM_ORDER, VOCAL_SPLIT_STEMS, type StemStorageFormat, type StemType } from '@shared/domain.js'
import { BandBuddyDatabase, type StoredStemInput } from '../src/main/database.js'
import { JobScheduler } from '../src/main/jobs.js'
import { ImportService } from '../src/main/imports.js'
import { MediaService } from '../src/main/media.js'
import { AppPaths } from '../src/main/paths.js'
import { removeTestAnalysisWorker, testAnalysisWorker } from './helpers/analysis-worker.js'
import type { MediaAnalysisRequest } from '../src/main/media-analysis.js'

vi.mock('electron', () => ({ app: { isPackaged: false }, Notification: { isSupported: () => false } }))
vi.mock('../src/main/vocal-models.js', () => ({ prepareVocalModel: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../src/main/media-analysis.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/main/media-analysis.js')>()
  let runner: ReturnType<typeof original.createMediaAnalysisRunner> | undefined
  return { ...original, runMediaAnalysis: async (request: MediaAnalysisRequest, signal?: AbortSignal) => {
    runner ??= original.createMediaAnalysisRunner(await testAnalysisWorker())
    return runner(request, signal)
  } }
})
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  class TestDatabase extends DatabaseSync {
    pragma(sql: string) { this.exec(`PRAGMA ${sql}`) }
    transaction(fn: (...args: unknown[]) => unknown) {
      const run = (...args: unknown[]) => { this.exec('BEGIN'); try { const result = fn(...args); this.exec('COMMIT'); return result } catch (error) { this.exec('ROLLBACK'); throw error } }
      return Object.assign(run, { deferred: run, immediate: run, exclusive: run })
    }
  }
  return { default: TestDatabase }
})

const frames = 15737 // Deliberately not a whole millisecond or MP3 frame.
const roots: string[] = [], databases: BandBuddyDatabase[] = [], schedulers: JobScheduler[] = []
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(s => s.shutdown()))
  databases.splice(0).forEach(db => db.close())
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})
afterAll(removeTestAnalysisWorker)

function wave(amplitude: number, sampleFrames = frames): Buffer {
  const file = Buffer.alloc(44 + sampleFrames * 8)
  file.write('RIFF'); file.writeUInt32LE(file.length - 8, 4); file.write('WAVEfmt ', 8)
  file.writeUInt32LE(16, 16); file.writeUInt16LE(3, 20); file.writeUInt16LE(2, 22)
  file.writeUInt32LE(44100, 24); file.writeUInt32LE(44100 * 8, 28); file.writeUInt16LE(8, 32); file.writeUInt16LE(32, 34)
  file.write('data', 36); file.writeUInt32LE(sampleFrames * 8, 40)
  for (let f = 0; f < sampleFrames; f++) for (let c = 0; c < 2; c++) file.writeFloatLE(amplitude * Math.sin(2 * Math.PI * 440 * f / 44100), 44 + f * 8 + c * 4)
  return file
}
function pcm(file: Buffer): Float32Array {
  for (let at = 12; at + 8 <= file.length;) {
    const size = file.readUInt32LE(at + 4)
    if (file.toString('ascii', at, at + 4) === 'data') {
      const result = new Float32Array(size / 4)
      for (let i = 0; i < result.length; i++) result[i] = file.readFloatLE(at + 8 + i * 4)
      return result
    }
    at += 8 + size + (size % 2)
  }
  throw new Error('PCM_DATA_MISSING')
}

async function setup(format: StemStorageFormat = 'flac24') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bb-vocal-job-')); roots.push(root)
  const paths = Object.assign(Object.create(AppPaths.prototype) as AppPaths, {
    databasePath: path.join(root, 'db.sqlite'), backupRoot: path.join(root, 'backups'), defaultLibraryRoot: root,
    pythonRoot: root, modelRoot: root, toolsRoot: path.join(root, 'tools'), packagedResource: () => path.join(root, 'missing-tools')
  })
  const db = new BandBuddyDatabase(paths); databases.push(db)
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
  const media = new MediaService(paths, db, logger as never)
  const input = path.join(root, 'saved-vocals.wav'); await writeFile(input, wave(.4))
  const id = db.createSong({ title: '已保存人声', artist: '', sourceRelPath: 'saved-vocals.wav', sourceHash: 'original', sourceFormat: 'wav', durationMs: frames / 44.1, sampleRate: 44100, channels: 2, artworkRelPath: null, status: 'ready' })
  const baseStems: StoredStemInput[] = LEGACY_STEM_ORDER.map(type => ({ type, relPath: 'saved-vocals.wav', peaksRelPath: null, durationMs: frames / 44.1, sampleRate: 44100, channels: 2 }))
  const base = db.activateSeparation(id, db.createJob('separate', id, 'queued', '', {}), 'base', 'cpu', baseStems)
  let beforeVerify: (() => Promise<void> | void) | undefined, busy = false
  const runWorker = vi.fn(async (args: string[]) => {
    const value = (key: string): string => args[args.indexOf(key) + 1]!
    if (args[0] === 'separate-demucs' || args[0] === 'separate-guitar') {
      const types = args[0] === 'separate-demucs' ? LEGACY_STEM_ORDER : GUITAR_SPLIT_STEMS
      return { code: 0, error: null, result: {
        files: Object.fromEntries(types.map(type => [type, value('--input')])),
        stats: Object.fromEntries(types.map(type => [type, { peak: .4 }]))
      } }
    }
    if (args[0] === 'verify-vocals') {
      await beforeVerify?.()
      const [source, lead, backing] = await Promise.all(['--input', '--lead', '--backing'].map(async key => pcm(await readFile(value(key)))))
      expect([lead!.length, backing!.length]).toEqual([source!.length, source!.length])
      const gain = Number(value('--gain'))
      let maxError = 0
      for (let i = 0; i < source!.length; i++) maxError = Math.max(maxError, Math.abs((lead![i]! + backing![i]!) / gain - source![i]!))
      expect(maxError).toBeLessThan(format === 'flac24' ? 1e-6 : .06)
      return { code: 0, error: null, result: { frames: source!.length / 2, maxError } }
    }
    expect(args[0]).toBe('separate-vocals')
    const source = pcm(await readFile(value('--input'))), inputFrames = source.length / 2
    const output = value('--output'); mkdirSync(output, { recursive: true })
    const files = Object.fromEntries(VOCAL_SPLIT_STEMS.map(type => [type, path.join(output, `${type}.wav`)]))
    const lead = wave(0, inputFrames), backing = wave(0, inputFrames)
    for (let i = 0; i < source.length; i++) {
      lead.writeFloatLE(source[i]! * 3, 44 + i * 4)
      backing.writeFloatLE(source[i]! * -2, 44 + i * 4)
    }
    await writeFile(files.lead_vocals!, lead); await writeFile(files.backing_vocals!, backing)
    return { code: 0, error: null, result: { frames: inputFrames, files, stats: { lead_vocals: { peak: 1.2 }, backing_vocals: { peak: .8 } } } }
  })
  const runtime = { onChange: vi.fn(), ensureDetected: vi.fn().mockResolvedValue({ status: 'ready', selectedDevice: 'cpu' }), getInfo: () => ({ status: 'ready', selectedDevice: 'cpu' }), runWorker }
  const completed = vi.fn()
  const busyRead = vi.fn(() => busy)
  const scheduler = new JobScheduler(paths, db, runtime as never, media, logger as never, vi.fn(), vi.fn(), vi.fn(), completed, busyRead)
  schedulers.push(scheduler)
  const hash = createHash('sha256').update(await readFile(input)).digest('hex')
  const job = db.queueVocalSplit(id, hash, 'mel-karaoke-aufr33-viperx', format)!
  const imports = new ImportService(paths, db, media, runtime as never, logger as never, vi.fn(), vi.fn())
  return { root, db, id, base, baseStems, job, media, scheduler, runWorker, completed, runtime, busyRead, imports,
    setBeforeVerify(fn: () => Promise<void> | void) { beforeVerify = fn }, setBusy(value: boolean) { busy = value },
    async finish(status: string, targetJob = job) {
      await vi.waitFor(() => expect(['completed', 'failed', 'cancelled']).toContain(db.getJob(targetJob)?.status), { timeout: 15000, interval: 25 })
      expect(db.getJob(targetJob)?.status, JSON.stringify({ job: db.getJob(targetJob), failures: logger.error.mock.calls })).toBe(status)
      await vi.waitFor(() => expect(existsSync(path.join(root, db.getJob(targetJob)!.songId!, '.tasks', targetJob))).toBe(false))
    }
  }
}

const hasTools = existsSync(path.join(process.cwd(), 'resources/bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
describe.skipIf(!hasTools)('vocal task lifecycle with real FFmpeg and isolated library', () => {
  it.each([
    ['fast', 'mel-karaoke-aufr33-viperx'], ['high', 'bs-karaoke-frazer-becruily']
  ] as const)('uses the selected %s model for a manual request and retains it after settings change', async (quality, modelId) => {
    const f = await setup(); f.db.setJobState(f.job, 'cancelled', '', 0)
    f.db.saveSettings({ ...f.db.getSettings(), vocalSeparationQuality: quality, highQualityStems: true })
    const job = (await f.imports.requestVocalSplit(f.id))!
    expect(f.db.getJob(job)!.payload).toMatchObject({ modelId, enableVocalSplitOnSuccess: true })
    f.db.saveSettings({ ...f.db.getSettings(), vocalSeparationQuality: quality === 'fast' ? 'high' : 'fast' })
    f.scheduler.kick(); await f.finish('completed', job)
    const args = f.runWorker.mock.calls.find(([args]) => args[0] === 'separate-vocals')![0]
    expect(args[args.indexOf('--model-id') + 1]).toBe(modelId)
    expect(f.db.getSong(f.id)!.practice.vocalSplitEnabled).toBe(true)
  }, 20000)

  it.each([
    ['fast', 'mel-karaoke-aufr33-viperx'], ['high', 'bs-karaoke-frazer-becruily']
  ] as const)('automatically refines a new import with the selected %s model without an opt-in setting', async (quality, modelId) => {
    const f = await setup(); f.db.setJobState(f.job, 'cancelled', '', 0)
    f.db.saveSettings({ ...f.db.getSettings(), vocalSeparationQuality: quality, highQualityStems: true })
    const imported = await f.imports.importSource({ filePath: path.join(f.root, 'saved-vocals.wav') })
    const songId = imported.songId!, baseJob = imported.jobId!
    expect(f.db.getJob(baseJob)!.payload).toMatchObject({ vocalModelId: modelId })
    expect(f.db.getJob(baseJob)!.payload).not.toHaveProperty('autoVocalSplit')
    f.db.saveSettings({ ...f.db.getSettings(), vocalSeparationQuality: quality === 'fast' ? 'high' : 'fast' })
    f.scheduler.kick()
    await vi.waitFor(() => expect(f.db.listJobs().some(job => job.type === 'vocalSplit' && job.songId === songId)).toBe(true), { timeout: 15000, interval: 25 })
    const job = f.db.listJobs().find(job => job.type === 'vocalSplit' && job.songId === songId)!
    await f.finish('completed', job.id)
    expect(f.db.getJob(job.id)!.payload).toMatchObject({ modelId, enableVocalSplitOnSuccess: false })
    const args = f.runWorker.mock.calls.find(([args]) => args[0] === 'separate-vocals')![0]
    expect(args[args.indexOf('--model-id') + 1]).toBe(modelId)
    expect(f.db.getSong(songId)!.practice.vocalSplitEnabled).toBe(false)
  }, 20000)

  it('ignores a legacy disabled flag on a queued base task and automatically refines its vocals', async () => {
    const f = await setup(); f.db.setJobState(f.job, 'cancelled', '', 0)
    f.db.saveSettings({ ...f.db.getSettings(), highQualityStems: true })
    const baseJob = f.imports.reSeparate(f.id)
    f.db.updateJobPayload(baseJob, { ...(f.db.getJob(baseJob)!.payload as object), autoVocalSplit: false })
    f.scheduler.kick()
    await vi.waitFor(() => expect(f.db.listJobs().some(job => job.type === 'vocalSplit' && job.id !== f.job)).toBe(true), { timeout: 15000, interval: 25 })
    const job = f.db.listJobs().find(job => job.type === 'vocalSplit' && job.id !== f.job)!
    await f.finish('completed', job.id)
    expect(f.db.getSong(f.id)!.vocalSplitStatus).toBe('ready')
    expect(f.db.getSong(f.id)!.practice.vocalSplitEnabled).toBe(false)
  }, 20000)

  it.each(['flac24', 'mp3_320'] as const)('publishes a verified %s pair with exact decoded frames and shared gain compensation', async format => {
    const f = await setup(format); f.scheduler.kick(); await f.finish('completed')
    const song = f.db.getSong(f.id)!, children = song.stems.filter(s => (VOCAL_SPLIT_STEMS as readonly StemType[]).includes(s.type))
    expect(children).toHaveLength(2)
    for (const stem of children) expect(stem).toMatchObject({ separationId: f.base, numFrames: frames, durationMs: frames / 44.1, encodingGain: (format === 'flac24' ? .999 : .95) / 1.2 })
    const assets = f.db.getActiveStemFiles(f.id).filter(s => (VOCAL_SPLIT_STEMS as readonly StemType[]).includes(s.type))
    for (const asset of assets) expect(existsSync(path.join(f.root, asset.relPath))).toBe(true)
    expect(song.practice.vocalSplitEnabled).toBe(false); expect(f.completed).toHaveBeenCalledOnce()
    expect(f.runWorker).toHaveBeenCalledTimes(2)
  }, 20000)
  it('keeps the saved base playable when the input version changes during verification', async () => {
    const f = await setup()
    f.setBeforeVerify(() => { f.db.activateSeparation(f.id, f.db.createJob('separate', f.id, 'queued', '', {}), 'new-base', 'cpu', f.baseStems) })
    f.scheduler.kick(); await f.finish('failed')
    expect(f.db.getJob(f.job)!.errorCode).toBe('STALE_VOCAL_SPLIT')
    expect(f.db.getSong(f.id)).toMatchObject({ status: 'ready', vocalSplitStatus: 'missing' })
    expect(f.db.getSong(f.id)!.stems).toHaveLength(6); expect(f.completed).not.toHaveBeenCalled()
    expect(existsSync(path.join(f.root, f.id, 'versions'))).toBe(false)
  }, 20000)
  it('cleans both unpublished outputs when cancelled at final verification', async () => {
    const f = await setup(); f.setBeforeVerify(() => f.scheduler.cancel(f.job))
    f.scheduler.kick(); await f.finish('cancelled')
    expect(f.db.getSong(f.id)!.stems).toHaveLength(6); expect(f.db.getSong(f.id)!.status).toBe('ready')
    expect(f.completed).not.toHaveBeenCalled()
    expect(existsSync(path.join(f.root, f.id, 'versions'))).toBe(false)
  }, 20000)
  it('removes partial files and preserves the base after an encoding disk failure', async () => {
    const f = await setup(); vi.spyOn(f.media, 'normalize').mockRejectedValueOnce(new Error('ENOSPC'))
    f.scheduler.kick(); await f.finish('failed')
    expect(f.db.getJob(f.job)!.errorCode).toBe('DISK_FULL'); expect(f.db.getSong(f.id)!.stems).toHaveLength(6)
    expect(f.completed).not.toHaveBeenCalled()
    expect(await readdir(path.join(f.root, f.id, '.tasks'))).toEqual([])
  }, 20000)
  it('waits while live audio is active and resumes the same queued task after it becomes idle', async () => {
    const f = await setup(); f.setBusy(true); f.scheduler.kick()
    await vi.waitFor(() => expect(f.busyRead).toHaveBeenCalled())
    expect(f.runtime.ensureDetected).not.toHaveBeenCalled()
    expect(f.db.getJob(f.job)!.status).toBe('queued'); expect(f.runWorker).not.toHaveBeenCalled()
    f.setBusy(false); f.scheduler.kick(); await f.finish('completed')
  }, 20000)
})

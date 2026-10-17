import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BandBuddyDatabase, type VocalSplitJobPayload, type StoredStemInput } from '../src/main/database.js'
import { LEGACY_STEM_ORDER, STEM_ORDER, VOCAL_SPLIT_STEMS, isStemVisible, isTrackAudible, normalizeTrackStates, stemPlaybackGain, type StemType } from '@shared/domain.js'
import { appSettingsSchema, practiceStateSchema } from '@shared/ipc.js'

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
const roots: string[] = [], databases: BandBuddyDatabase[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
const stems = (types: readonly StemType[]): StoredStemInput[] => types.map(type => ({ type, relPath: `base/${type}.flac`, peaksRelPath: null, durationMs: 1000, sampleRate: 44100, channels: 2, numFrames: 44100, encodingGain: .8 }))
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-vocals-')); roots.push(root)
  const db = new BandBuddyDatabase({ databasePath: path.join(root, 'db.sqlite'), backupRoot: path.join(root, 'backups'), defaultLibraryRoot: root, pythonRoot: root, modelRoot: root } as never); databases.push(db)
  const id = db.createSong({ title: '人声测试', artist: '', sourceRelPath: 'source.wav', sourceHash: 'hash', sourceFormat: 'wav', durationMs: 1000, sampleRate: 44100, channels: 2, artworkRelPath: null, status: 'ready' })
  const job = db.createJob('separate', id, 'queued', '', {})
  const base = db.activateSeparation(id, job, 'base-model', 'cpu', stems(LEGACY_STEM_ORDER))
  return { db, id, base }
}
function queue(db: BandBuddyDatabase, id: string) {
  const job = db.queueVocalSplit(id, 'a'.repeat(64), 'mel-karaoke-aufr33-viperx', 'flac24')!
  return { job, payload: db.getJob(job)!.payload as VocalSplitJobPayload }
}

describe('vocal refinement publication', () => {
  it('defaults legacy settings to the efficiency tier and persists the selected tier', () => {
    const { db } = setup()
    const { vocalSeparationQuality: _quality, ...legacy } = db.getSettings()
    const oldSettings = { ...legacy, autoVocalSplit: false }
    expect(appSettingsSchema.parse(oldSettings)).toMatchObject({ vocalSeparationQuality: 'fast' })
    expect(appSettingsSchema.parse(oldSettings)).not.toHaveProperty('autoVocalSplit')
    db.sqlite.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES ('app',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json")
      .run(JSON.stringify(oldSettings), new Date().toISOString())
    expect(db.getSettings().vocalSeparationQuality).toBe('fast')
    expect(db.getSettings()).not.toHaveProperty('autoVocalSplit')
    db.saveSettings({ ...db.getSettings(), vocalSeparationQuality: 'high' })
    expect(db.getSettings().vocalSeparationQuality).toBe('high')
    expect(appSettingsSchema.safeParse({ ...legacy, vocalSeparationQuality: 'balanced' }).success).toBe(false)
  })

  it('publishes both children atomically, inherits the latest faders, retains the base identity and stays in full mode', () => {
    const { db, id, base } = setup(); const { job, payload } = queue(db, id)
    expect(queue(db, id).job).toBe(job)
    const practice = db.getSong(id)!.practice
    db.savePractice({ ...practice, tracks: practice.tracks.map(t => t.stemType === 'vocals' ? { ...t, gainDb: -7, muted: true, solo: true, outputChannelPair: 3 } : t) })
    const result = db.completeVocalSplit(id, job, payload, stems(VOCAL_SPLIT_STEMS), { modelSha256: 'verified' })
    const song = db.getSong(id)!
    expect(song.stems).toHaveLength(8); expect(song.vocalSplitStatus).toBe('ready'); expect(song.practice.vocalSplitEnabled).toBe(false)
    for (const type of VOCAL_SPLIT_STEMS) {
      expect(song.stems.find(s => s.type === type)).toMatchObject({ separationId: base, refinementId: result.refinementId, encodingGain: .8, numFrames: 44100 })
      expect(song.practice.tracks.find(t => t.stemType === type)).toMatchObject({ gainDb: -7, muted: true, solo: true, outputChannelPair: 3 })
    }
    expect(db.sqlite.prepare('SELECT model_revision,device FROM separation_runs WHERE id=?').get(base)).toMatchObject({ model_revision: 'base-model', device: 'cpu' })
    expect(db.getJob(job)!.status).toBe('completed'); expect(db.queueVocalSplit(id, 'a'.repeat(64), payload.modelId, payload.storageFormat)).toBeNull()
  })
  it('rejects partial pairs and stale results without attaching either child', () => {
    const { db, id } = setup(); const { job, payload } = queue(db, id)
    expect(() => db.completeVocalSplit(id, job, payload, stems(['lead_vocals']), {})).toThrow('INCOMPLETE_VOCAL_STEMS')
    const next = db.createJob('separate', id, 'queued', '', {})
    db.publishBaseSeparationAndQueueGuitar(id, next, 'new-base', 'cuda', stems(LEGACY_STEM_ORDER), { sourceRelPath: 'source.wav', storageFormat: 'mp3_320', baseEncodingGain: 1, targetDurationMs: 1000 })
    expect(() => db.completeVocalSplit(id, job, payload, stems(VOCAL_SPLIT_STEMS), {})).toThrow('STALE_VOCAL_SPLIT')
    expect(db.getSong(id)!.stems).toHaveLength(6)
    db.setJobState(job, 'failed', '旧版本', 0, 'STALE_VOCAL_SPLIT')
    expect(db.getSong(id)!.status).toBe('ready')
  })
  it.each([false, true])('enables a manually requested pair on completion, including an existing background task (existing=%s)', existing => {
    const { db, id } = setup()
    const running = existing ? queue(db, id) : null
    if (running) db.setJobState(running.job, 'separating', '正在细分', .5)
    const job = db.queueVocalSplit(id, 'a'.repeat(64), 'mel-karaoke-aufr33-viperx', 'flac24', true)!
    if (running) expect(job).toBe(running.job)
    const practice = db.getSong(id)!.practice
    db.savePractice({ ...practice, tracks: practice.tracks.map(track => track.stemType === 'vocals' ? { ...track, gainDb: -9, solo: true } : track) })
    // An automatic queue request must not clear the user's request to enable.
    expect(queue(db, id).job).toBe(job)
    const payload = running?.payload ?? db.getJob(job)!.payload as VocalSplitJobPayload
    const result = db.completeVocalSplit(id, job, payload, stems(VOCAL_SPLIT_STEMS), {})
    expect(result.enableVocalSplitOnSuccess).toBe(true)
    const song = db.getSong(id)!
    expect(song.practice.vocalSplitEnabled).toBe(true)
    expect(song.practice.selectedStem).toBe('lead_vocals')
    for (const type of VOCAL_SPLIT_STEMS) expect(song.practice.tracks.find(track => track.stemType === type)).toMatchObject({ gainDb: -9, solo: true })
    db.savePractice({ ...song.practice, vocalSplitEnabled: false, selectedStem: 'vocals' })
    expect(db.getSong(id)!.practice.vocalSplitEnabled).toBe(false)
    expect(db.getSong(id)!.stems.filter(stem => (VOCAL_SPLIT_STEMS as readonly StemType[]).includes(stem.type))).toHaveLength(2)
  })
  it('keeps vocal and guitar provenance independent when their jobs complete in either order', () => {
    const { db, id } = setup(); const baseJob = db.createJob('separate', id, 'queued', '', {})
    const published = db.publishBaseSeparationAndQueueGuitar(id, baseJob, 'independent-base', 'cuda', stems(LEGACY_STEM_ORDER), { sourceRelPath: 'source.wav', storageFormat: 'flac24', baseEncodingGain: 1, targetDurationMs: 1000 })
    const { job, payload } = queue(db, id)
    db.completeVocalSplit(id, job, payload, stems(VOCAL_SPLIT_STEMS), {})
    db.completeGuitarSplit(id, published.guitarJobId, { baseSeparationId: published.separationId, expectedActiveSeparationId: published.separationId }, 'guitar-only', 'cpu', stems(['acoustic_guitar', 'lead_guitar', 'rhythm_guitar']))
    expect(db.getSong(id)!.stems).toHaveLength(11)
    expect(db.sqlite.prepare('SELECT model_revision FROM separation_runs WHERE id=?').get(published.separationId)).toMatchObject({ model_revision: 'independent-base' })
  })
  it('normalizes old nine-track practice without exposing a missing vocal pair', () => {
    const { db, id } = setup(), practice = db.getSong(id)!.practice
    const legacy = { ...practice, vocalSplitEnabled: true, tracks: practice.tracks.filter(t => !(VOCAL_SPLIT_STEMS as readonly string[]).includes(t.stemType)), trackOrder: practice.trackOrder.filter(k => !k.includes('_vocals')) }
    db.sqlite.prepare('UPDATE practice_states SET state_json=? WHERE song_id=?').run(JSON.stringify(legacy), id)
    const song = db.getSong(id)!
    expect(song.practice.vocalSplitEnabled).toBe(false); expect(song.practice.tracks).toHaveLength(STEM_ORDER.length)
    expect(practiceStateSchema.parse(song.practice)).toMatchObject({ vocalSplitEnabled: false })
  })
  it.each(['cancelling', 'cancelled', 'failed', 'interrupted', 'completed'] as const)('never publishes a late result after the task became %s', status => {
    const { db, id } = setup(); const { job, payload } = queue(db, id)
    db.setJobState(job, status, '已结束', 0)
    expect(() => db.completeVocalSplit(id, job, payload, stems(VOCAL_SPLIT_STEMS), {})).toThrow('VOCAL_TASK_NOT_ACTIVE')
    expect(db.getSong(id)!.stems).toHaveLength(6)
    expect(db.sqlite.prepare('SELECT count(*) AS total FROM stem_refinements').get()).toMatchObject({ total: 0 })
  })
  it('does not show a failed task for the previous base version on a new separation', () => {
    const { db, id } = setup(); const { job } = queue(db, id)
    db.setJobState(job, 'failed', '旧版本失败', 0)
    expect(db.getSong(id)!.vocalSplitStatus).toBe('failed')
    const next = db.createJob('separate', id, 'queued', '', {})
    db.activateSeparation(id, next, 'new-base', 'cpu', stems(LEGACY_STEM_ORDER))
    expect(db.getSong(id)!.vocalSplitStatus).toBe('missing')
    expect(db.listSongs()[0]!.vocalSplitStatus).toBe('missing')
  })
})

describe('vocal mix group', () => {
  it('hides exactly one representation and ignores solos on the hidden representation', () => {
    for (const split of [false, true]) {
      expect(isStemVisible('vocals', false, split)).toBe(!split)
      expect(isStemVisible('lead_vocals', false, split)).toBe(split)
      expect(isStemVisible('backing_vocals', false, split)).toBe(split)
      const tracks = normalizeTrackStates([{ stemType: split ? 'vocals' : 'lead_vocals', solo: true }])
      expect(isTrackAudible(tracks.find(t => t.stemType === 'drums')!, tracks, false, split)).toBe(true)
    }
    expect(stemPlaybackGain({ encodingGain: .8 })).toBe(1.25)
  })
})

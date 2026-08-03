import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createDefaultPracticeState } from '@shared/domain.js'
import { recordingAudioSettingsSchema } from '@shared/ipc.js'
import { DATABASE_MIGRATIONS } from '../src/main/database.js'
import { buildMixFilter } from '../src/main/export-filter.js'
import { buildClockCorrectionFilters, calculateTakeAlignmentOffset, resolveRecordingRange } from '../src/main/recording.js'

describe('recording range and device configuration', () => {
  it('records once from A to B, otherwise from the current position to the song end', () => {
    const practice = createDefaultPracticeState('00000000-0000-4000-8000-000000000000')
    practice.loopEnabled = true
    practice.loopStartMs = 12_000
    practice.loopEndMs = 19_500
    expect(resolveRecordingRange(60_000, 30_000, practice)).toEqual({ startPositionMs: 12_000, endPositionMs: 19_500, plannedEnd: true })
    practice.loopEnabled = false
    expect(resolveRecordingRange(60_000, 30_000, practice)).toEqual({ startPositionMs: 30_000, endPositionMs: 60_000, plannedEnd: false })
  })

  it('validates mono/stereo channel counts, sample rate and buffer size', () => {
    const valid = {
      backend: 'asio', inputDeviceId: 'asio:0', outputDeviceId: 'asio:0', inputChannelMode: 'stereo',
      inputChannels: [2, 3], sampleRate: 48_000, bufferFrames: 128, alignmentOffsetMs: 4
    }
    const parsed = recordingAudioSettingsSchema.safeParse({ ...valid, softwareMonitoring: true, monitorGainDb: -9 })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('softwareMonitoring')
      expect(parsed.data).not.toHaveProperty('monitorGainDb')
    }
    expect(recordingAudioSettingsSchema.safeParse({ ...valid, inputChannels: [2] }).success).toBe(false)
    expect(recordingAudioSettingsSchema.safeParse({ ...valid, bufferFrames: 8 }).success).toBe(false)
  })

  it('builds deterministic offline correction only for split clocks', () => {
    expect(buildClockCorrectionFilters(48_000, false, 1.005)).toEqual([])
    expect(buildClockCorrectionFilters(48_000, true, 1.005)).toEqual([
      'asetrate=48240.000000',
      'aresample=48000:async=1000:first_pts=0'
    ])
  })

  it('combines driver latency, saved calibration and a split-device capture start', () => {
    expect(calculateTakeAlignmentOffset(4, 10, false, 256, 48_000)).toBe(-6)
    expect(calculateTakeAlignmentOffset(4, 10, true, 256, 48_000)).toBeCloseTo(-0.6667, 3)
  })
})

describe('recording track persistence', () => {
  it('keeps take selection and mix state independent across recording tracks', () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    for (const migration of DATABASE_MIGRATIONS) database.exec(migration)
    const songId = '10000000-0000-4000-8000-000000000000'
    const trackOneId = '20000000-0000-4000-8000-000000000000'
    const trackTwoId = '30000000-0000-4000-8000-000000000000'
    const takeOneId = '40000000-0000-4000-8000-000000000000'
    const takeTwoId = '50000000-0000-4000-8000-000000000000'
    const now = new Date().toISOString()
    database.prepare('INSERT INTO songs(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(songId, 'Take test', now, now)
    database.prepare(`
      INSERT INTO recording_tracks(id, song_id, name, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(trackOneId, songId, '主唱', 0, now, now)
    database.prepare(`
      INSERT INTO recording_tracks(id, song_id, name, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(trackTwoId, songId, '和声', 1, now, now)
    const insertTake = database.prepare(`INSERT INTO recording_takes(
      id, song_id, recording_track_id, name, source_rel_path, preview_rel_path, duration_ms, start_position_ms, end_position_ms,
      playback_rate, sample_rate, channels, alignment_offset_ms, backend, input_device_name, input_channels_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    insertTake.run(
      takeOneId, songId, trackOneId, 'Take 1', `${songId}/recordings/one/source.flac`, `${songId}/recordings/one/preview.flac`,
      2_500, 5_000, 7_000, 0.8, 48_000, 1, -3, 'asio', 'Interface', '[0]', now
    )
    insertTake.run(
      takeTwoId, songId, trackTwoId, 'Take 1', `${songId}/recordings/two/source.flac`, `${songId}/recordings/two/preview.flac`,
      2_500, 5_000, 7_000, 0.8, 48_000, 1, -3, 'asio', 'Interface', '[0]', now
    )
    database.prepare('UPDATE recording_tracks SET active_take_id = ? WHERE id = ?').run(takeOneId, trackOneId)
    database.prepare('UPDATE recording_tracks SET active_take_id = ?, gain_db = ?, solo = 1 WHERE id = ?').run(takeTwoId, -4, trackTwoId)
    database.prepare('UPDATE recording_takes SET name = ?, alignment_offset_ms = ? WHERE id = ?').run('Best take', 7, takeOneId)
    expect(database.prepare('SELECT name, alignment_offset_ms FROM recording_takes WHERE id = ?').get(takeOneId)).toEqual({ name: 'Best take', alignment_offset_ms: 7 })
    expect(database.prepare('SELECT active_take_id, gain_db, solo FROM recording_tracks WHERE id = ?').get(trackTwoId)).toEqual({ active_take_id: takeTwoId, gain_db: -4, solo: 1 })
    database.prepare('DELETE FROM recording_takes WHERE id = ?').run(takeOneId)
    expect(database.prepare('SELECT active_take_id FROM recording_tracks WHERE id = ?').get(trackOneId)).toEqual({ active_take_id: null })
    expect(database.prepare('SELECT active_take_id FROM recording_tracks WHERE id = ?').get(trackTwoId)).toEqual({ active_take_id: takeTwoId })
    database.prepare('DELETE FROM songs WHERE id = ?').run(songId)
    expect(database.prepare('SELECT COUNT(*) AS count FROM recording_tracks').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM recording_takes').get()).toEqual({ count: 0 })
    database.close()
  })

  it('migrates the legacy single recording track without losing its selected take', () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    for (const migration of DATABASE_MIGRATIONS.slice(0, 3)) database.exec(migration)
    const songId = '60000000-0000-4000-8000-000000000000'
    const takeId = '70000000-0000-4000-8000-000000000000'
    const now = new Date().toISOString()
    database.prepare('INSERT INTO songs(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(songId, 'Legacy take', now, now)
    database.prepare(`INSERT INTO recording_takes(
      id, song_id, name, source_rel_path, preview_rel_path, duration_ms, start_position_ms, end_position_ms,
      playback_rate, sample_rate, channels, alignment_offset_ms, backend, input_device_name, input_channels_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      takeId, songId, 'Take 1', `${songId}/recordings/one/source.flac`, `${songId}/recordings/one/preview.flac`,
      2_500, 5_000, 7_000, 0.8, 48_000, 1, -3, 'asio', 'Interface', '[0]', now
    )
    database.prepare('INSERT INTO recording_track_states(song_id, active_take_id, updated_at) VALUES (?, ?, ?)').run(songId, takeId, now)
    for (const migration of DATABASE_MIGRATIONS.slice(3)) database.exec(migration)
    expect(database.prepare('SELECT id, song_id, active_take_id FROM recording_tracks').get()).toEqual({
      id: songId,
      song_id: songId,
      active_take_id: takeId
    })
    expect(database.prepare('SELECT recording_track_id FROM recording_takes WHERE id = ?').get(takeId)).toEqual({ recording_track_id: songId })
    database.close()
  })
})

describe('recording take export placement', () => {
  it('mixes every audible recording track independently', () => {
    const filter = buildMixFilter({
      tracks: [],
      takes: [
        { inputIndex: 0, gainDb: -3, startPositionMs: 0, playbackRate: 1, alignmentOffsetMs: 0 },
        { inputIndex: 1, gainDb: -9, startPositionMs: 500, playbackRate: 1, alignmentOffsetMs: 0 }
      ],
      masterGainDb: 0,
      playbackRate: 1,
      loopStartMs: null,
      loopEndMs: null,
      sourceDurationMs: 10_000
    })
    expect(filter).toContain('[0:a]')
    expect(filter).toContain('[1:a]')
    expect(filter).toContain('[recording0][recording1]amix=inputs=2')
  })

  it('places raw take audio on the speed-adjusted song timeline and applies alignment', () => {
    const filter = buildMixFilter({
      tracks: [],
      takes: [{ inputIndex: 0, gainDb: -6, startPositionMs: 1_000, playbackRate: 0.5, alignmentOffsetMs: 12 }],
      masterGainDb: 0,
      playbackRate: 0.5,
      loopStartMs: null,
      loopEndMs: null,
      sourceDurationMs: 10_000
    })
    expect(filter).toContain('adelay=2012:all=1')
    expect(filter).toContain('volume=0.50118723')
    expect(filter).toContain('atrim=end=20.000000')
  })

  it('trims a take that begins before an exported A-B range', () => {
    const filter = buildMixFilter({
      tracks: [],
      takes: [{ inputIndex: 0, gainDb: 0, startPositionMs: 1_000, playbackRate: 1, alignmentOffsetMs: 0 }],
      masterGainDb: 0,
      playbackRate: 1,
      loopStartMs: 2_000,
      loopEndMs: 5_000,
      sourceDurationMs: 10_000
    })
    expect(filter).toContain('atrim=start=1.000000')
    expect(filter).toContain('atrim=end=3.000000')
  })
})

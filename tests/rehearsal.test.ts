import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  createDefaultPracticeState,
  type SongDetail
} from '@shared/domain.js'
import {
  buildRehearsalTimeline,
  rehearsalTimelinePosition,
  type RehearsalItem
} from '@shared/rehearsal.js'
import { DATABASE_MIGRATIONS } from '../src/main/database.js'

function song(id: string, durationMs = 60_000): SongDetail {
  const practice = createDefaultPracticeState(id)
  return {
    id,
    title: `Song ${id.slice(0, 4)}`,
    artist: 'Band',
    durationMs,
    artworkUrl: null,
    favorite: false,
    status: 'ready',
    progress: 1,
    phase: null,
    stemTypes: ['vocals'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastPracticedAt: null,
    bpm: 120,
    beatOffsetMs: 0,
    musicalKey: null,
    timeSignature: '4/4',
    sourceFormat: 'wav',
    sampleRate: 48_000,
    channels: 2,
    lyrics: null,
    stems: [{
      id: `${id.slice(0, 24)}111111111111`,
      songId: id,
      separationId: `${id.slice(0, 24)}222222222222`,
      type: 'vocals',
      durationMs,
      sampleRate: 48_000,
      channels: 2,
      mediaUrl: `bandbuddy-media://song/${id}/stem/vocals`,
      peaksUrl: null
    }],
    practice,
    recordingTakes: [],
    recordingTracks: []
  }
}

function songItem(id: string, songId: string): Extract<RehearsalItem, { kind: 'song' }> {
  return {
    id,
    kind: 'song',
    songId,
    title: 'Song',
    artist: 'Band',
    durationMs: 60_000,
    artworkUrl: null,
    available: true
  }
}

describe('rehearsal timeline', () => {
  it('builds independent count-in, speed-adjusted songs and arbitrary silent transitions', () => {
    const first = song('10000000-0000-4000-8000-000000000000')
    first.practice.playbackRate = 0.5
    first.practice.metronomeEnabled = false
    first.practice.metronomeBpm = 120
    first.practice.countInBeats = 4
    const items: RehearsalItem[] = [
      songItem('20000000-0000-4000-8000-000000000000', first.id),
      { id: '30000000-0000-4000-8000-000000000000', kind: 'transition', durationMs: 15_000 },
      songItem('40000000-0000-4000-8000-000000000000', first.id)
    ]

    const timeline = buildRehearsalTimeline(items, [first])

    expect(timeline.segments.map((segment) => segment.kind)).toEqual([
      'countIn', 'song', 'transition', 'countIn', 'song'
    ])
    expect(timeline.segments[0]).toMatchObject({
      startMs: 0,
      endMs: 4_000,
      metronomeEnabled: false,
      countInBeats: 4
    })
    expect(timeline.segments[1]).toMatchObject({ startMs: 4_000, endMs: 124_000 })
    expect(timeline.segments[2]).toMatchObject({ startMs: 124_000, endMs: 139_000 })
    expect(timeline.totalDurationMs).toBe(263_000)

    const insideFirstSong = rehearsalTimelinePosition(timeline, 14_000)
    expect(insideFirstSong.segment?.kind).toBe('song')
    expect(insideFirstSong.songSourceMs).toBe(5_000)
    expect(rehearsalTimelinePosition(timeline, 124_000).segment?.kind).toBe('transition')
    expect(rehearsalTimelinePosition(timeline, timeline.totalDurationMs).globalMs).toBe(timeline.totalDurationMs)
  })

  it('versions only changes that affect wall-clock alignment', () => {
    const source = song('50000000-0000-4000-8000-000000000000')
    source.practice.countInBeats = 0
    const items = [songItem('60000000-0000-4000-8000-000000000000', source.id)]
    const baseline = buildRehearsalTimeline(items, [source]).fingerprint

    const mixOnly = structuredClone(source)
    mixOnly.practice.masterGainDb = -8
    mixOnly.practice.positionMs = 22_000
    mixOnly.practice.loopEnabled = true
    mixOnly.practice.loopStartMs = 1_000
    mixOnly.practice.loopEndMs = 3_000
    mixOnly.practice.metronomeEnabled = true
    mixOnly.practice.desktopLyricsEnabled = true
    mixOnly.practice.metronomeBpm = 188
    mixOnly.practice.tracks[0]!.muted = true
    expect(buildRehearsalTimeline(items, [mixOnly]).fingerprint).toBe(baseline)

    const speedChanged = structuredClone(source)
    speedChanged.practice.playbackRate = 1.25
    expect(buildRehearsalTimeline(items, [speedChanged]).fingerprint).not.toBe(baseline)

    const countInChanged = structuredClone(source)
    countInChanged.practice.countInBeats = 4
    const countInFingerprint = buildRehearsalTimeline(items, [countInChanged]).fingerprint
    expect(countInFingerprint).not.toBe(baseline)
    countInChanged.practice.metronomeBpm = 90
    expect(buildRehearsalTimeline(items, [countInChanged]).fingerprint).not.toBe(countInFingerprint)
  })

  it('retains unavailable placeholders while excluding them from playback', () => {
    const missing = songItem(
      '70000000-0000-4000-8000-000000000000',
      '80000000-0000-4000-8000-000000000000'
    )
    const timeline = buildRehearsalTimeline([
      missing,
      { id: '90000000-0000-4000-8000-000000000000', kind: 'transition', durationMs: 5_000 }
    ], [])
    expect(timeline.unavailableItemIds).toEqual([missing.id])
    expect(timeline.segments).toHaveLength(1)
    expect(timeline.segments[0]?.kind).toBe('transition')
  })
})

describe('rehearsal persistence', () => {
  it('atomically saves, structurally duplicates and cascades rehearsal-owned data', () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    for (const migration of DATABASE_MIGRATIONS) database.exec(migration)
    try {
      const rehearsalId = 'd0000000-0000-4000-8000-000000000000'
      const duplicateId = 'd1000000-0000-4000-8000-000000000000'
      const itemId = 'd2000000-0000-4000-8000-000000000000'
      const duplicateItemId = 'd3000000-0000-4000-8000-000000000000'
      const trackId = 'd4000000-0000-4000-8000-000000000000'
      const now = new Date().toISOString()
      database.prepare(`
        INSERT INTO rehearsal_sets(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
      `).run(rehearsalId, '周末排练', now, now)
      database.prepare(`
        INSERT INTO rehearsal_items(
          id, rehearsal_id, kind, title_snapshot, artist_snapshot, duration_ms, sort_order
        ) VALUES (?, ?, 'transition', '空白衔接', '', 10000, 0)
      `).run(itemId, rehearsalId)

      database.exec('BEGIN')
      expect(() => {
        database.prepare('DELETE FROM rehearsal_items WHERE rehearsal_id = ?').run(rehearsalId)
        const insert = database.prepare(`
          INSERT INTO rehearsal_items(
            id, rehearsal_id, kind, title_snapshot, artist_snapshot, duration_ms, sort_order
          ) VALUES (?, ?, 'transition', '空白衔接', '', 10000, ?)
        `)
        insert.run(itemId, rehearsalId, 0)
        insert.run(itemId, rehearsalId, 1)
      }).toThrow()
      database.exec('ROLLBACK')
      expect(database.prepare(
        'SELECT id, duration_ms FROM rehearsal_items WHERE rehearsal_id = ?'
      ).all(rehearsalId)).toEqual([{ id: itemId, duration_ms: 10_000 }])

      database.prepare(`
        INSERT INTO rehearsal_recording_tracks(
          id, rehearsal_id, name, sort_order, created_at, updated_at
        ) VALUES (?, ?, '录音轨 1', 0, ?, ?)
      `).run(trackId, rehearsalId, now, now)
      database.prepare(`
        INSERT INTO rehearsal_sets(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
      `).run(duplicateId, '周末排练 副本', now, now)
      database.prepare(`
        INSERT INTO rehearsal_items(
          id, rehearsal_id, kind, title_snapshot, artist_snapshot, duration_ms, sort_order
        ) SELECT ?, ?, kind, title_snapshot, artist_snapshot, duration_ms, sort_order
          FROM rehearsal_items WHERE rehearsal_id = ?
      `).run(duplicateItemId, duplicateId, rehearsalId)
      expect(database.prepare(
        'SELECT id, duration_ms FROM rehearsal_items WHERE rehearsal_id = ?'
      ).all(duplicateId)).toEqual([{ id: duplicateItemId, duration_ms: 10_000 }])
      expect(database.prepare(
        'SELECT COUNT(*) AS count FROM rehearsal_recording_tracks WHERE rehearsal_id = ?'
      ).get(duplicateId)).toEqual({ count: 0 })

      database.prepare('DELETE FROM rehearsal_sets WHERE id = ?').run(rehearsalId)
      expect(database.prepare(
        'SELECT COUNT(*) AS count FROM rehearsal_items WHERE rehearsal_id = ?'
      ).get(rehearsalId)).toEqual({ count: 0 })
      expect(database.prepare(
        'SELECT COUNT(*) AS count FROM rehearsal_recording_tracks WHERE rehearsal_id = ?'
      ).get(rehearsalId)).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  })

  it('keeps a song placeholder after the source song is deleted', () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    for (const migration of DATABASE_MIGRATIONS) database.exec(migration)
    try {
      const now = new Date().toISOString()
      const songId = 'b0000000-0000-4000-8000-000000000000'
      database.prepare(`
        INSERT INTO songs(id, title, artist, duration_ms, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'ready', ?, ?)
      `).run(songId, '被删除的歌', '乐队', 42_000, now, now)
      const rehearsalId = 'b1000000-0000-4000-8000-000000000000'
      const itemId = 'c0000000-0000-4000-8000-000000000000'
      database.prepare(`
        INSERT INTO rehearsal_sets(id, name, created_at, updated_at) VALUES (?, '占位测试', ?, ?)
      `).run(rehearsalId, now, now)
      database.prepare(`
        INSERT INTO rehearsal_items(
          id, rehearsal_id, kind, song_id, title_snapshot, artist_snapshot, duration_ms, sort_order
        ) VALUES (?, ?, 'song', ?, '被删除的歌', '乐队', 42000, 0)
      `).run(itemId, rehearsalId, songId)
      database.prepare('DELETE FROM songs WHERE id = ?').run(songId)

      expect(database.prepare(`
        SELECT id, song_id, title_snapshot, artist_snapshot, duration_ms
        FROM rehearsal_items WHERE rehearsal_id = ?
      `).get(rehearsalId)).toEqual({
        id: itemId,
        song_id: null,
        title_snapshot: '被删除的歌',
        artist_snapshot: '乐队',
        duration_ms: 42_000
      })
    } finally {
      database.close()
    }
  })
})

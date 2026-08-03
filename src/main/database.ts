import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  createDefaultRecordingAudioSettings,
  createDefaultPracticeState,
  type AppSettings,
  type JobRecord,
  type JobStatus,
  type PracticeState,
  type RecordingTake,
  type RecordingDeviceSnapshot,
  type RecordingTrackState,
  type SongDetail,
  type SongStatus,
  type SongSummary,
  type StemRecord,
  type StemType
} from '@shared/domain.js'
import { parseLrc } from '@shared/lyrics.js'
import { RUNTIME_SOURCE_PRESETS } from '@shared/runtime-sources.js'
import type {
  RehearsalItem,
  RehearsalRecordingTake,
  RehearsalRecordingTrackState,
  RehearsalRevision,
  RehearsalRevisionSnapshot,
  RehearsalSetDetail,
  RehearsalSetSummary,
  SaveRehearsalRequest
} from '@shared/rehearsal.js'
import type { AppPaths } from './paths.js'

interface SongRow {
  id: string
  title: string
  artist: string
  source_rel_path: string | null
  source_hash: string | null
  source_format: string | null
  duration_ms: number
  sample_rate: number | null
  channels: number | null
  artwork_rel_path: string | null
  favorite: number
  status: SongStatus
  progress: number
  phase: string | null
  bpm: number | null
  beat_offset_ms: number
  musical_key: string | null
  time_signature: string | null
  lyrics_lrc: string | null
  lyrics_file_name: string | null
  active_separation_id: string | null
  created_at: string
  updated_at: string
  last_practiced_at: string | null
}

interface StemRow {
  id: string
  song_id: string
  separation_id: string
  type: StemType
  rel_path: string
  peaks_rel_path: string | null
  duration_ms: number
  sample_rate: number
  channels: number
}

interface JobRow {
  id: string
  song_id: string | null
  type: JobRecord['type']
  status: JobStatus
  phase: string
  progress: number
  payload_json: string
  error_code: string | null
  error_message: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

interface RecordingTakeRow {
  id: string
  song_id: string
  recording_track_id: string | null
  name: string
  source_rel_path: string
  preview_rel_path: string
  peaks_rel_path: string | null
  duration_ms: number
  start_position_ms: number
  end_position_ms: number
  playback_rate: number
  sample_rate: number
  channels: number
  alignment_offset_ms: number
  backend: RecordingTake['backend']
  input_device_name: string
  input_channels_json: string
  device_snapshot_json: string
  interrupted: number
  created_at: string
}

interface RecordingTrackRow {
  id: string
  song_id: string
  name: string
  active_take_id: string | null
  gain_db: number
  muted: number
  solo: number
  sort_order: number
  created_at: string
  updated_at: string
}

interface RehearsalSetRow {
  id: string
  name: string
  created_at: string
  updated_at: string
  last_opened_at: string | null
}

interface RehearsalItemRow {
  id: string
  rehearsal_id: string
  kind: RehearsalItem['kind']
  song_id: string | null
  title_snapshot: string
  artist_snapshot: string
  duration_ms: number
  sort_order: number
}

interface RehearsalRevisionRow {
  id: string
  rehearsal_id: string
  fingerprint: string
  snapshot_json: string
  created_at: string
}

interface RehearsalRecordingTrackRow {
  id: string
  rehearsal_id: string
  name: string
  active_take_id: string | null
  gain_db: number
  muted: number
  solo: number
  sort_order: number
  created_at: string
  updated_at: string
}

interface RehearsalRecordingTakeRow {
  id: string
  rehearsal_id: string
  recording_track_id: string
  revision_id: string
  timeline_fingerprint: string
  name: string
  source_rel_path: string
  preview_rel_path: string
  duration_ms: number
  start_position_ms: number
  end_position_ms: number
  sample_rate: number
  channels: number
  alignment_offset_ms: number
  input_device_name: string
  input_channels_json: string
  device_snapshot_json: string
  interrupted: number
  created_at: string
}

export interface StoredRecordingTakeInput {
  id?: string
  songId: string
  recordingTrackId: string
  name: string
  sourceRelPath: string
  previewRelPath: string
  peaksRelPath: string | null
  durationMs: number
  startPositionMs: number
  endPositionMs: number
  playbackRate: number
  sampleRate: number
  channels: number
  alignmentOffsetMs: number
  backend: RecordingTake['backend']
  inputDeviceName: string
  inputChannels: number[]
  deviceSnapshot: RecordingDeviceSnapshot
  interrupted?: boolean
}

export interface StoredRehearsalRecordingTakeInput {
  id?: string
  rehearsalId: string
  recordingTrackId: string
  revisionId: string
  timelineFingerprint: string
  name: string
  sourceRelPath: string
  previewRelPath: string
  durationMs: number
  startPositionMs: number
  endPositionMs: number
  sampleRate: number
  channels: number
  alignmentOffsetMs: number
  inputDeviceName: string
  inputChannels: number[]
  deviceSnapshot: RecordingDeviceSnapshot
  interrupted?: boolean
}

export interface CreateSongInput {
  title: string
  artist: string
  sourceRelPath: string | null
  sourceHash: string | null
  sourceFormat: string | null
  durationMs: number
  sampleRate: number | null
  channels: number | null
  artworkRelPath: string | null
  status: SongStatus
  phase?: string | null
}

export interface StoredStemInput {
  id?: string
  type: StemType
  relPath: string
  peaksRelPath: string | null
  durationMs: number
  sampleRate: number
  channels: number
}

export const DATABASE_MIGRATIONS = [
  `
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT NOT NULL DEFAULT '',
      source_rel_path TEXT,
      source_hash TEXT,
      source_format TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      sample_rate INTEGER,
      channels INTEGER,
      artwork_rel_path TEXT,
      favorite INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      progress REAL NOT NULL DEFAULT 0,
      phase TEXT,
      bpm INTEGER,
      musical_key TEXT,
      time_signature TEXT,
      active_separation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_practiced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS songs_source_hash_idx ON songs(source_hash);
    CREATE INDEX IF NOT EXISTS songs_updated_at_idx ON songs(updated_at DESC);

    CREATE TABLE IF NOT EXISTS separation_runs (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      model_name TEXT NOT NULL,
      model_revision TEXT NOT NULL,
      device TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stems (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      separation_id TEXT NOT NULL REFERENCES separation_runs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      peaks_rel_path TEXT,
      duration_ms INTEGER NOT NULL,
      sample_rate INTEGER NOT NULL,
      channels INTEGER NOT NULL,
      UNIQUE(separation_id, type)
    );

    CREATE TABLE IF NOT EXISTS practice_states (
      song_id TEXT PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS track_states (
      song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      stem_type TEXT NOT NULL,
      gain_db REAL NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      solo INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(song_id, stem_type)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      song_id TEXT REFERENCES songs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT '',
      progress REAL NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  `
    ALTER TABLE songs ADD COLUMN beat_offset_ms REAL NOT NULL DEFAULT 0;
  `,
  `
    CREATE TABLE IF NOT EXISTS recording_takes (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      source_rel_path TEXT NOT NULL,
      preview_rel_path TEXT NOT NULL,
      peaks_rel_path TEXT,
      duration_ms INTEGER NOT NULL,
      start_position_ms REAL NOT NULL,
      end_position_ms REAL NOT NULL,
      playback_rate REAL NOT NULL,
      sample_rate INTEGER NOT NULL,
      channels INTEGER NOT NULL,
      alignment_offset_ms REAL NOT NULL DEFAULT 0,
      backend TEXT NOT NULL,
      input_device_name TEXT NOT NULL DEFAULT '',
      input_channels_json TEXT NOT NULL DEFAULT '[]',
      interrupted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS recording_takes_song_created_idx ON recording_takes(song_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS recording_track_states (
      song_id TEXT PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
      active_take_id TEXT REFERENCES recording_takes(id) ON DELETE SET NULL,
      gain_db REAL NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      solo INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `,
  `
    ALTER TABLE recording_takes ADD COLUMN device_snapshot_json TEXT NOT NULL DEFAULT '{}';
  `,
  `
    CREATE TABLE IF NOT EXISTS recording_tracks (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      active_take_id TEXT REFERENCES recording_takes(id) ON DELETE SET NULL,
      gain_db REAL NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      solo INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(song_id, sort_order)
    );
    CREATE INDEX IF NOT EXISTS recording_tracks_song_order_idx ON recording_tracks(song_id, sort_order);

    INSERT OR IGNORE INTO recording_tracks(
      id, song_id, name, active_take_id, gain_db, muted, solo, sort_order, created_at, updated_at
    )
    SELECT song_id, song_id, '录音轨 1', active_take_id, gain_db, muted, solo, 0, updated_at, updated_at
    FROM recording_track_states;

    ALTER TABLE recording_takes ADD COLUMN recording_track_id TEXT REFERENCES recording_tracks(id) ON DELETE CASCADE;
    UPDATE recording_takes
    SET recording_track_id = song_id
    WHERE recording_track_id IS NULL
      AND song_id IN (SELECT id FROM recording_tracks);
    CREATE INDEX IF NOT EXISTS recording_takes_track_created_idx ON recording_takes(recording_track_id, created_at DESC);
  `,
  `
    ALTER TABLE songs ADD COLUMN lyrics_lrc TEXT;
    ALTER TABLE songs ADD COLUMN lyrics_file_name TEXT;
  `,
  `
    CREATE TABLE IF NOT EXISTS rehearsal_sets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_opened_at TEXT
    );
    CREATE INDEX IF NOT EXISTS rehearsal_sets_updated_idx ON rehearsal_sets(updated_at DESC);

    CREATE TABLE IF NOT EXISTS rehearsal_items (
      id TEXT PRIMARY KEY,
      rehearsal_id TEXT NOT NULL REFERENCES rehearsal_sets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('song', 'transition')),
      song_id TEXT REFERENCES songs(id) ON DELETE SET NULL,
      title_snapshot TEXT NOT NULL DEFAULT '',
      artist_snapshot TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL,
      UNIQUE(rehearsal_id, sort_order)
    );
    CREATE INDEX IF NOT EXISTS rehearsal_items_set_order_idx ON rehearsal_items(rehearsal_id, sort_order);

    CREATE TABLE IF NOT EXISTS rehearsal_revisions (
      id TEXT PRIMARY KEY,
      rehearsal_id TEXT NOT NULL REFERENCES rehearsal_sets(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(rehearsal_id, fingerprint)
    );

    CREATE TABLE IF NOT EXISTS rehearsal_recording_tracks (
      id TEXT PRIMARY KEY,
      rehearsal_id TEXT NOT NULL REFERENCES rehearsal_sets(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      active_take_id TEXT,
      gain_db REAL NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      solo INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(rehearsal_id, sort_order)
    );

    CREATE TABLE IF NOT EXISTS rehearsal_recording_takes (
      id TEXT PRIMARY KEY,
      rehearsal_id TEXT NOT NULL REFERENCES rehearsal_sets(id) ON DELETE CASCADE,
      recording_track_id TEXT NOT NULL REFERENCES rehearsal_recording_tracks(id) ON DELETE CASCADE,
      revision_id TEXT NOT NULL REFERENCES rehearsal_revisions(id) ON DELETE CASCADE,
      timeline_fingerprint TEXT NOT NULL,
      name TEXT NOT NULL,
      source_rel_path TEXT NOT NULL,
      preview_rel_path TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      start_position_ms REAL NOT NULL,
      end_position_ms REAL NOT NULL,
      sample_rate INTEGER NOT NULL,
      channels INTEGER NOT NULL,
      alignment_offset_ms REAL NOT NULL DEFAULT 0,
      input_device_name TEXT NOT NULL DEFAULT '',
      input_channels_json TEXT NOT NULL DEFAULT '[]',
      device_snapshot_json TEXT NOT NULL DEFAULT '{}',
      interrupted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rehearsal_takes_track_created_idx
      ON rehearsal_recording_takes(recording_track_id, created_at DESC);
  `
]

function parseDeviceSnapshot(row: RecordingTakeRow): RecordingDeviceSnapshot {
  let saved: Partial<RecordingDeviceSnapshot> = {}
  try { saved = JSON.parse(row.device_snapshot_json || '{}') as Partial<RecordingDeviceSnapshot> } catch { /* use legacy columns */ }
  const inputChannels = Array.isArray(saved.inputChannels)
    ? saved.inputChannels
    : JSON.parse(row.input_channels_json) as number[]
  return {
    backend: saved.backend ?? row.backend,
    inputDeviceId: saved.inputDeviceId ?? '',
    inputDeviceName: saved.inputDeviceName ?? row.input_device_name,
    outputDeviceId: saved.outputDeviceId ?? '',
    outputDeviceName: saved.outputDeviceName ?? '',
    inputChannels,
    sampleRate: saved.sampleRate ?? row.sample_rate,
    bufferFrames: saved.bufferFrames ?? 0,
    latencyMs: saved.latencyMs ?? 0,
    splitDevices: saved.splitDevices ?? false,
    softwareMonitoring: saved.softwareMonitoring ?? false
  }
}

export class BandBuddyDatabase {
  readonly sqlite: Database.Database
  readonly orm: BetterSQLite3Database

  constructor(private readonly paths: AppPaths) {
    this.backupBeforeMigrate()
    this.sqlite = new Database(paths.databasePath)
    this.orm = drizzle(this.sqlite)
    this.sqlite.pragma('journal_mode = WAL')
    this.sqlite.pragma('foreign_keys = ON')
    this.sqlite.pragma('busy_timeout = 5000')
    this.migrate()
    this.recoverInterruptedJobs()
  }

  private backupBeforeMigrate(): void {
    if (!existsSync(this.paths.databasePath) || statSync(this.paths.databasePath).size === 0) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(this.paths.databasePath, path.join(this.paths.backupRoot, `bandbuddy-${stamp}.db`))
    const backups = readdirSync(this.paths.backupRoot)
      .filter((name) => /^bandbuddy-.*\.db$/.test(name))
      .map((name) => ({ name, time: statSync(path.join(this.paths.backupRoot, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
    for (const old of backups.slice(3)) unlinkSync(path.join(this.paths.backupRoot, old.name))
  }

  private migrate(): void {
    this.orm.run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const current = this.orm.get<{ version: number }>('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version')
    DATABASE_MIGRATIONS.forEach((migration, index) => {
      const version = index + 1
      if (version <= current.version) return
      const statements = migration.split(';').map((statement) => statement.trim()).filter(Boolean)
      this.orm.transaction((transaction) => {
        for (const statement of statements) transaction.run(statement)
        transaction.run(sql`INSERT INTO schema_version(version, applied_at) VALUES (${version}, ${new Date().toISOString()})`)
      })
    })
  }

  private recoverInterruptedJobs(): void {
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      UPDATE jobs SET status = 'interrupted', phase = '应用异常退出，可重新尝试',
        error_code = 'APP_INTERRUPTED', error_message = '应用在任务完成前退出', finished_at = ?
      WHERE status IN ('preparing', 'separating', 'postprocessing', 'cancelling')
    `).run(now)
    this.sqlite.prepare(`
      UPDATE songs SET status = 'failed', phase = '任务已中断', updated_at = ?
      WHERE id IN (SELECT song_id FROM jobs WHERE status = 'interrupted' AND song_id IS NOT NULL)
    `).run(now)
  }

  close(): void {
    this.sqlite.close()
  }

  defaultSettings(): AppSettings {
    return {
      libraryRoot: this.paths.defaultLibraryRoot,
      runtimeRoot: this.paths.pythonRoot,
      modelRoot: this.paths.modelRoot,
      preferredDevice: 'auto',
      audioOutputDeviceId: '',
      latencyMode: 'balanced',
      recordingAudio: createDefaultRecordingAudioSettings(),
      keepSource: true,
      closeToTrayWhileWorking: true,
      network: {
        proxyMode: 'system',
        proxyUrl: '',
        ...RUNTIME_SOURCE_PRESETS.china
      }
    }
  }

  getSettings(): AppSettings {
    const row = this.sqlite.prepare("SELECT value_json FROM settings WHERE key = 'app'").get() as { value_json: string } | undefined
    if (!row) return this.defaultSettings()
    const saved = JSON.parse(row.value_json) as Partial<AppSettings>
    const defaults = this.defaultSettings()
    return {
      ...defaults,
      ...saved,
      network: { ...defaults.network, ...saved.network },
      recordingAudio: { ...defaults.recordingAudio, ...saved.recordingAudio }
    }
  }

  saveSettings(settings: AppSettings): AppSettings {
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES ('app', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(settings), now)
    return settings
  }

  createSong(input: CreateSongInput, id = randomUUID()): string {
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      INSERT INTO songs(
        id, title, artist, source_rel_path, source_hash, source_format, duration_ms, sample_rate,
        channels, artwork_rel_path, status, phase, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.title, input.artist, input.sourceRelPath, input.sourceHash, input.sourceFormat,
      input.durationMs, input.sampleRate, input.channels, input.artworkRelPath, input.status,
      input.phase ?? null, now, now
    )
    const state = createDefaultPracticeState(id)
    this.savePractice(state)
    return id
  }

  findBySourceHash(hash: string): SongSummary | null {
    const row = this.sqlite.prepare('SELECT * FROM songs WHERE source_hash = ? ORDER BY created_at LIMIT 1').get(hash) as SongRow | undefined
    return row ? this.songRowToSummary(row) : null
  }

  listSongs(query = '', filter: 'all' | 'favorite' | 'processing' | 'recent' = 'all'): SongSummary[] {
    const rows = this.sqlite.prepare('SELECT * FROM songs ORDER BY COALESCE(last_practiced_at, updated_at) DESC').all() as SongRow[]
    const normalized = query.trim().toLocaleLowerCase()
    return rows
      .filter((row) => !normalized || `${row.title}\n${row.artist}`.toLocaleLowerCase().includes(normalized))
      .filter((row) => {
        if (filter === 'favorite') return Boolean(row.favorite)
        if (filter === 'processing') return ['blockedRuntime', 'queued', 'processing'].includes(row.status)
        if (filter === 'recent') return Boolean(row.last_practiced_at)
        return true
      })
      .map((row) => this.songRowToSummary(row))
  }

  getSong(id: string): SongDetail | null {
    const row = this.sqlite.prepare('SELECT * FROM songs WHERE id = ?').get(id) as SongRow | undefined
    if (!row) return null
    const stems = row.active_separation_id
      ? (this.sqlite.prepare('SELECT * FROM stems WHERE separation_id = ?').all(row.active_separation_id) as StemRow[]).map(this.stemRowToRecord)
      : []
    const practiceRow = this.sqlite.prepare('SELECT state_json FROM practice_states WHERE song_id = ?').get(id) as { state_json: string } | undefined
    const defaults = createDefaultPracticeState(id)
    const savedPractice = practiceRow ? JSON.parse(practiceRow.state_json) as Partial<PracticeState> : {}
    const practice: PracticeState = {
      ...defaults,
      ...savedPractice,
      ...(row.bpm === null ? {} : { metronomeBpm: row.bpm }),
      metronomeOffsetMs: row.beat_offset_ms,
      tracks: savedPractice.tracks ?? defaults.tracks
    }
    const recordingTakes = this.getRecordingTakes(id)
    const recordingTracks = this.getRecordingTracks(id)
    return {
      ...this.songRowToSummary(row),
      bpm: row.bpm,
      beatOffsetMs: row.beat_offset_ms,
      musicalKey: row.musical_key,
      timeSignature: row.time_signature,
      sourceFormat: row.source_format,
      sampleRate: row.sample_rate,
      channels: row.channels,
      lyrics: row.lyrics_lrc ? parseLrc(row.lyrics_lrc, row.lyrics_file_name ?? 'lyrics.lrc') : null,
      stems,
      practice,
      recordingTakes,
      recordingTracks
    }
  }

  getSongRow(id: string): SongRow | null {
    return (this.sqlite.prepare('SELECT * FROM songs WHERE id = ?').get(id) as SongRow | undefined) ?? null
  }

  private songRowToSummary = (row: SongRow): SongSummary => {
    const stemRows = row.active_separation_id
      ? this.sqlite.prepare('SELECT type FROM stems WHERE separation_id = ?').all(row.active_separation_id) as Array<{ type: StemType }>
      : []
    return {
      id: row.id,
      title: row.title,
      artist: row.artist,
      durationMs: row.duration_ms,
      artworkUrl: row.artwork_rel_path ? `bandbuddy-media://song/${row.id}/artwork` : null,
      favorite: Boolean(row.favorite),
      status: row.status,
      progress: row.progress,
      phase: row.phase,
      stemTypes: stemRows.map((stem) => stem.type),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastPracticedAt: row.last_practiced_at
    }
  }

  private stemRowToRecord = (row: StemRow): StemRecord => ({
    id: row.id,
    songId: row.song_id,
    separationId: row.separation_id,
    type: row.type,
    durationMs: row.duration_ms,
    sampleRate: row.sample_rate,
    channels: row.channels,
    mediaUrl: `bandbuddy-media://song/${row.song_id}/stem/${row.id}`,
    peaksUrl: row.peaks_rel_path ? `bandbuddy-media://song/${row.song_id}/peaks/${row.id}` : null
  })

  updateSong(id: string, patch: {
    title?: string
    artist?: string
    favorite?: boolean
    bpm?: number | null
    beatOffsetMs?: number
    musicalKey?: string | null
    timeSignature?: string | null
  }): SongDetail {
    const mapping: Record<string, string> = {
      title: 'title', artist: 'artist', favorite: 'favorite', bpm: 'bpm', beatOffsetMs: 'beat_offset_ms', musicalKey: 'musical_key', timeSignature: 'time_signature'
    }
    const updates: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in mapping)) continue
      updates.push(`${mapping[key]} = ?`)
      values.push(typeof value === 'boolean' ? Number(value) : value)
    }
    if (updates.length) {
      updates.push('updated_at = ?')
      values.push(new Date().toISOString(), id)
      this.sqlite.prepare(`UPDATE songs SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    }
    const song = this.getSong(id)
    if (!song) throw new Error('SONG_NOT_FOUND')
    return song
  }

  setLyrics(id: string, fileName: string, lrc: string): SongDetail {
    const result = this.sqlite.prepare(
      'UPDATE songs SET lyrics_lrc = ?, lyrics_file_name = ?, updated_at = ? WHERE id = ?'
    ).run(lrc, fileName, new Date().toISOString(), id)
    if (result.changes === 0) throw new Error('SONG_NOT_FOUND')
    const song = this.getSong(id)
    if (!song) throw new Error('SONG_NOT_FOUND')
    return song
  }

  savePractice(state: PracticeState): void {
    const now = new Date().toISOString()
    const normalized = { ...state, updatedAt: now }
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO practice_states(song_id, state_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(song_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
      `).run(state.songId, JSON.stringify(normalized), now)
      const upsert = this.sqlite.prepare(`
        INSERT INTO track_states(song_id, stem_type, gain_db, muted, solo) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(song_id, stem_type) DO UPDATE SET gain_db = excluded.gain_db, muted = excluded.muted, solo = excluded.solo
      `)
      for (const track of state.tracks) upsert.run(state.songId, track.stemType, track.gainDb, Number(track.muted), Number(track.solo))
      this.sqlite.prepare('UPDATE songs SET beat_offset_ms = ?, last_practiced_at = ?, updated_at = ? WHERE id = ?')
        .run(state.metronomeOffsetMs, now, now, state.songId)
    })()
  }

  createJob(type: JobRecord['type'], songId: string | null, status: JobStatus, phase: string, payload: unknown): string {
    const id = randomUUID()
    this.sqlite.prepare(`
      INSERT INTO jobs(id, song_id, type, status, phase, progress, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, songId, type, status, phase, JSON.stringify(payload), new Date().toISOString())
    return id
  }

  listJobs(): JobRecord[] {
    const rows = this.sqlite.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as JobRow[]
    return rows.map(this.jobRowToRecord)
  }

  getJob(id: string): (JobRecord & { payload: unknown }) | null {
    const row = this.sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
    return row ? { ...this.jobRowToRecord(row), payload: JSON.parse(row.payload_json) as unknown } : null
  }

  updateJobPayload(id: string, payload: unknown): void {
    this.sqlite.prepare('UPDATE jobs SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), id)
  }

  nextQueuedJob(): (JobRecord & { payload: unknown }) | null {
    const row = this.sqlite.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as JobRow | undefined
    return row ? { ...this.jobRowToRecord(row), payload: JSON.parse(row.payload_json) as unknown } : null
  }

  setJobState(id: string, status: JobStatus, phase: string, progress: number, errorCode: string | null = null, errorMessage: string | null = null): void {
    const now = new Date().toISOString()
    const started = ['preparing', 'separating', 'postprocessing'].includes(status) ? now : null
    const finished = ['completed', 'failed', 'cancelled', 'interrupted'].includes(status) ? now : null
    this.sqlite.prepare(`
      UPDATE jobs SET status = ?, phase = ?, progress = ?, error_code = ?, error_message = ?,
        started_at = COALESCE(started_at, ?), finished_at = COALESCE(?, finished_at) WHERE id = ?
    `).run(status, phase, progress, errorCode, errorMessage, started, finished, id)
    const row = this.sqlite.prepare('SELECT song_id, type FROM jobs WHERE id = ?').get(id) as { song_id: string | null; type: JobRecord['type'] } | undefined
    if (row?.song_id && row.type !== 'export') {
      const songStatus: SongStatus = status === 'blockedRuntime' ? 'blockedRuntime'
        : status === 'queued' ? 'queued'
          : ['preparing', 'separating', 'postprocessing', 'cancelling'].includes(status) ? 'processing'
            : status === 'completed' ? 'ready' : 'failed'
      this.sqlite.prepare('UPDATE songs SET status = ?, progress = ?, phase = ?, updated_at = ? WHERE id = ?')
        .run(songStatus, progress, phase, now, row.song_id)
    }
  }

  unblockRuntimeJobs(): number {
    const result = this.sqlite.prepare("UPDATE jobs SET status = 'queued', phase = '等待分离' WHERE status = 'blockedRuntime'").run()
    this.sqlite.prepare("UPDATE songs SET status = 'queued', phase = '等待分离' WHERE status = 'blockedRuntime'").run()
    return result.changes
  }

  retryJob(id: string): void {
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      UPDATE jobs SET status = 'queued', phase = '等待重试', progress = 0, error_code = NULL,
        error_message = NULL, started_at = NULL, finished_at = NULL, created_at = ?
      WHERE id = ? AND status IN ('failed', 'cancelled', 'interrupted')
    `).run(now, id)
    const row = this.sqlite.prepare('SELECT song_id FROM jobs WHERE id = ?').get(id) as { song_id: string | null } | undefined
    if (row?.song_id) this.sqlite.prepare("UPDATE songs SET status = 'queued', phase = '等待重试', progress = 0 WHERE id = ?").run(row.song_id)
  }

  clearFinishedJobs(): void {
    this.sqlite.prepare("DELETE FROM jobs WHERE status IN ('completed', 'cancelled')").run()
  }

  activateSeparation(songId: string, jobId: string, modelRevision: string, device: string, stems: StoredStemInput[]): string {
    const separationId = randomUUID()
    const now = new Date().toISOString()
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO separation_runs(id, song_id, model_name, model_revision, device, status, created_at, completed_at)
        VALUES (?, ?, 'htdemucs_6s', ?, ?, 'completed', ?, ?)
      `).run(separationId, songId, modelRevision, device, now, now)
      const insert = this.sqlite.prepare(`
        INSERT INTO stems(id, song_id, separation_id, type, rel_path, peaks_rel_path, duration_ms, sample_rate, channels)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const stem of stems) {
        insert.run(stem.id ?? randomUUID(), songId, separationId, stem.type, stem.relPath, stem.peaksRelPath, stem.durationMs, stem.sampleRate, stem.channels)
      }
      this.sqlite.prepare(`
        UPDATE songs SET active_separation_id = ?, status = 'ready', progress = 1,
          phase = '分离完成', duration_ms = ?, sample_rate = 44100, channels = 2, updated_at = ? WHERE id = ?
      `).run(separationId, Math.max(...stems.map((stem) => stem.durationMs)), now, songId)
      this.sqlite.prepare(`
        UPDATE jobs SET status = 'completed', phase = '分离完成', progress = 1, finished_at = ? WHERE id = ?
      `).run(now, jobId)
    })()
    return separationId
  }

  getStemAsset(songId: string, stemId: string): { relPath: string; peaksRelPath: string | null } | null {
    const row = this.sqlite.prepare('SELECT rel_path, peaks_rel_path FROM stems WHERE id = ? AND song_id = ?').get(stemId, songId) as { rel_path: string; peaks_rel_path: string | null } | undefined
    return row ? { relPath: row.rel_path, peaksRelPath: row.peaks_rel_path } : null
  }

  getActiveStemFiles(songId: string): Array<{ id: string; type: StemType; relPath: string; durationMs: number }> {
    const song = this.sqlite.prepare('SELECT active_separation_id FROM songs WHERE id = ?').get(songId) as { active_separation_id: string | null } | undefined
    if (!song?.active_separation_id) return []
    const rows = this.sqlite.prepare('SELECT id, type, rel_path, duration_ms FROM stems WHERE separation_id = ?').all(song.active_separation_id) as Array<{ id: string; type: StemType; rel_path: string; duration_ms: number }>
    return rows.map((row) => ({ id: row.id, type: row.type, relPath: row.rel_path, durationMs: row.duration_ms }))
  }

  getRecordingTakes(songId: string): RecordingTake[] {
    const rows = this.sqlite.prepare('SELECT * FROM recording_takes WHERE song_id = ? ORDER BY created_at DESC').all(songId) as RecordingTakeRow[]
    return rows.map(this.recordingTakeRowToRecord)
  }

  getRecordingTake(id: string): RecordingTake | null {
    const row = this.sqlite.prepare('SELECT * FROM recording_takes WHERE id = ?').get(id) as RecordingTakeRow | undefined
    return row ? this.recordingTakeRowToRecord(row) : null
  }

  getRecordingTakeFile(id: string): { songId: string; sourceRelPath: string; previewRelPath: string; peaksRelPath: string | null } | null {
    const row = this.sqlite.prepare('SELECT song_id, source_rel_path, preview_rel_path, peaks_rel_path FROM recording_takes WHERE id = ?').get(id) as {
      song_id: string; source_rel_path: string; preview_rel_path: string; peaks_rel_path: string | null
    } | undefined
    return row ? { songId: row.song_id, sourceRelPath: row.source_rel_path, previewRelPath: row.preview_rel_path, peaksRelPath: row.peaks_rel_path } : null
  }

  getRecordingTracks(songId: string): RecordingTrackState[] {
    const rows = this.sqlite.prepare('SELECT * FROM recording_tracks WHERE song_id = ? ORDER BY sort_order, created_at').all(songId) as RecordingTrackRow[]
    return rows.map(this.recordingTrackRowToRecord)
  }

  getRecordingTrack(id: string): RecordingTrackState | null {
    const row = this.sqlite.prepare('SELECT * FROM recording_tracks WHERE id = ?').get(id) as RecordingTrackRow | undefined
    return row ? this.recordingTrackRowToRecord(row) : null
  }

  createRecordingTrack(songId: string): RecordingTrackState {
    const song = this.sqlite.prepare('SELECT id FROM songs WHERE id = ?').get(songId) as { id: string } | undefined
    if (!song) throw new Error('SONG_NOT_FOUND')
    const rows = this.sqlite.prepare('SELECT name, sort_order FROM recording_tracks WHERE song_id = ? ORDER BY sort_order').all(songId) as Array<{ name: string; sort_order: number }>
    const names = new Set(rows.map((row) => row.name))
    let index = 1
    while (names.has(`录音轨 ${index}`)) index += 1
    const id = randomUUID()
    const now = new Date().toISOString()
    const sortOrder = rows.reduce((maximum, row) => Math.max(maximum, row.sort_order), -1) + 1
    this.sqlite.prepare(`
      INSERT INTO recording_tracks(id, song_id, name, active_take_id, gain_db, muted, solo, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 0, 0, 0, ?, ?, ?)
    `).run(id, songId, `录音轨 ${index}`, sortOrder, now, now)
    const track = this.getRecordingTrack(id)
    if (!track) throw new Error('RECORDING_TRACK_CREATE_FAILED')
    return track
  }

  createRecordingTake(input: StoredRecordingTakeInput): RecordingTake {
    const id = input.id ?? randomUUID()
    const createdAt = new Date().toISOString()
    const recordingTrack = this.getRecordingTrack(input.recordingTrackId)
    if (!recordingTrack || recordingTrack.songId !== input.songId) throw new Error('RECORDING_TRACK_NOT_FOUND')
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO recording_takes(
          id, song_id, recording_track_id, name, source_rel_path, preview_rel_path, peaks_rel_path, duration_ms,
          start_position_ms, end_position_ms, playback_rate, sample_rate, channels,
          alignment_offset_ms, backend, input_device_name, input_channels_json, interrupted, created_at, device_snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.songId, input.recordingTrackId, input.name, input.sourceRelPath, input.previewRelPath, input.peaksRelPath,
        Math.round(input.durationMs), input.startPositionMs, input.endPositionMs, input.playbackRate,
        input.sampleRate, input.channels, input.alignmentOffsetMs, input.backend, input.inputDeviceName,
        JSON.stringify(input.inputChannels), Number(Boolean(input.interrupted)), createdAt, JSON.stringify(input.deviceSnapshot)
      )
      this.sqlite.prepare(`
        UPDATE recording_tracks SET active_take_id = ?, updated_at = ? WHERE id = ?
      `).run(id, createdAt, input.recordingTrackId)
    })()
    const take = this.getRecordingTake(id)
    if (!take) throw new Error('RECORDING_TAKE_CREATE_FAILED')
    return take
  }

  updateRecordingTake(id: string, patch: { name?: string; alignmentOffsetMs?: number; previewRelPath?: string; peaksRelPath?: string | null }): RecordingTake {
    const updates: string[] = []
    const values: unknown[] = []
    if (patch.name !== undefined) { updates.push('name = ?'); values.push(patch.name) }
    if (patch.alignmentOffsetMs !== undefined) { updates.push('alignment_offset_ms = ?'); values.push(patch.alignmentOffsetMs) }
    if (patch.previewRelPath !== undefined) { updates.push('preview_rel_path = ?'); values.push(patch.previewRelPath) }
    if (patch.peaksRelPath !== undefined) { updates.push('peaks_rel_path = ?'); values.push(patch.peaksRelPath) }
    if (updates.length) this.sqlite.prepare(`UPDATE recording_takes SET ${updates.join(', ')} WHERE id = ?`).run(...values, id)
    const take = this.getRecordingTake(id)
    if (!take) throw new Error('RECORDING_TAKE_NOT_FOUND')
    return take
  }

  selectRecordingTake(recordingTrackId: string, takeId: string | null): void {
    const track = this.getRecordingTrack(recordingTrackId)
    if (!track) throw new Error('RECORDING_TRACK_NOT_FOUND')
    if (takeId) {
      const take = this.getRecordingTake(takeId)
      if (!take || take.recordingTrackId !== recordingTrackId) throw new Error('RECORDING_TAKE_NOT_FOUND')
    }
    const now = new Date().toISOString()
    this.sqlite.prepare('UPDATE recording_tracks SET active_take_id = ?, updated_at = ? WHERE id = ?').run(takeId, now, recordingTrackId)
  }

  updateRecordingTrackState(
    recordingTrackId: string,
    patch: Partial<Pick<RecordingTrackState, 'name' | 'gainDb' | 'muted' | 'solo'>>
  ): RecordingTrackState {
    const current = this.getRecordingTrack(recordingTrackId)
    if (!current) throw new Error('RECORDING_TRACK_NOT_FOUND')
    const next = { ...current, ...patch }
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      UPDATE recording_tracks
      SET name = ?, gain_db = ?, muted = ?, solo = ?, updated_at = ?
      WHERE id = ?
    `).run(next.name, next.gainDb, Number(next.muted), Number(next.solo), now, recordingTrackId)
    return { ...next, updatedAt: now }
  }

  deleteRecordingTake(id: string): void {
    const take = this.getRecordingTake(id)
    this.sqlite.transaction(() => {
      this.sqlite.prepare('DELETE FROM recording_takes WHERE id = ?').run(id)
      if (take) {
        this.sqlite.prepare(`
          UPDATE recording_tracks
          SET muted = 0, solo = 0, updated_at = ?
          WHERE id = ? AND active_take_id IS NULL
        `).run(new Date().toISOString(), take.recordingTrackId)
      }
    })()
  }

  nextRecordingTakeName(recordingTrackId: string): string {
    const rows = this.sqlite.prepare('SELECT name FROM recording_takes WHERE recording_track_id = ?').all(recordingTrackId) as Array<{ name: string }>
    const names = new Set(rows.map((row) => row.name))
    for (let index = 1; index < 100_000; index += 1) {
      const candidate = `Take ${index}`
      if (!names.has(candidate)) return candidate
    }
    return `Take ${new Date().toISOString()}`
  }

  private recordingTakeRowToRecord = (row: RecordingTakeRow): RecordingTake => ({
    id: row.id,
    songId: row.song_id,
    recordingTrackId: row.recording_track_id ?? row.song_id,
    name: row.name,
    durationMs: row.duration_ms,
    startPositionMs: row.start_position_ms,
    endPositionMs: row.end_position_ms,
    playbackRate: row.playback_rate,
    sampleRate: row.sample_rate,
    channels: row.channels,
    alignmentOffsetMs: row.alignment_offset_ms,
    backend: row.backend,
    inputDeviceName: row.input_device_name,
    inputChannels: JSON.parse(row.input_channels_json) as number[],
    deviceSnapshot: parseDeviceSnapshot(row),
    sourceMediaUrl: `bandbuddy-media://song/${row.song_id}/recording-source/${row.id}`,
    previewMediaUrl: `bandbuddy-media://song/${row.song_id}/recording-preview/${row.id}?alignment=${row.alignment_offset_ms}`,
    peaksUrl: row.peaks_rel_path ? `bandbuddy-media://song/${row.song_id}/recording-peaks/${row.id}?alignment=${row.alignment_offset_ms}` : null,
    interrupted: Boolean(row.interrupted),
    createdAt: row.created_at
  })

  private recordingTrackRowToRecord = (row: RecordingTrackRow): RecordingTrackState => ({
    id: row.id,
    songId: row.song_id,
    name: row.name,
    activeTakeId: row.active_take_id,
    gainDb: row.gain_db,
    muted: Boolean(row.muted),
    solo: Boolean(row.solo),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })

  listRehearsals(): RehearsalSetSummary[] {
    const rows = this.sqlite.prepare(`
      SELECT
        rehearsal_sets.*,
        COUNT(rehearsal_items.id) AS item_count,
        SUM(CASE WHEN rehearsal_items.kind = 'song' THEN 1 ELSE 0 END) AS song_count
      FROM rehearsal_sets
      LEFT JOIN rehearsal_items ON rehearsal_items.rehearsal_id = rehearsal_sets.id
      GROUP BY rehearsal_sets.id
      ORDER BY COALESCE(rehearsal_sets.last_opened_at, rehearsal_sets.updated_at) DESC
    `).all() as Array<RehearsalSetRow & { item_count: number; song_count: number | null }>
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      itemCount: row.item_count,
      songCount: row.song_count ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastOpenedAt: row.last_opened_at
    }))
  }

  createRehearsal(name = '新排练编排'): RehearsalSetDetail {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      INSERT INTO rehearsal_sets(id, name, created_at, updated_at, last_opened_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, now, now, now)
    const rehearsal = this.getRehearsal(id)
    if (!rehearsal) throw new Error('REHEARSAL_CREATE_FAILED')
    return rehearsal
  }

  getRehearsal(id: string, markOpened = true): RehearsalSetDetail | null {
    const row = this.sqlite.prepare('SELECT * FROM rehearsal_sets WHERE id = ?').get(id) as RehearsalSetRow | undefined
    if (!row) return null
    if (markOpened) {
      const now = new Date().toISOString()
      this.sqlite.prepare('UPDATE rehearsal_sets SET last_opened_at = ? WHERE id = ?').run(now, id)
      row.last_opened_at = now
    }
    const itemRows = this.sqlite.prepare(
      'SELECT * FROM rehearsal_items WHERE rehearsal_id = ? ORDER BY sort_order'
    ).all(id) as RehearsalItemRow[]
    const items = itemRows.map((item): RehearsalItem => {
      if (item.kind === 'transition') return { id: item.id, kind: 'transition', durationMs: item.duration_ms }
      const song = item.song_id
        ? this.sqlite.prepare('SELECT * FROM songs WHERE id = ?').get(item.song_id) as SongRow | undefined
        : undefined
      return {
        id: item.id,
        kind: 'song',
        songId: item.song_id,
        title: song?.title ?? (item.title_snapshot || '歌曲不可用'),
        artist: song?.artist ?? item.artist_snapshot,
        durationMs: song?.duration_ms ?? item.duration_ms,
        artworkUrl: song?.artwork_rel_path ? `bandbuddy-media://song/${song.id}/artwork` : null,
        available: Boolean(song && song.status === 'ready' && song.active_separation_id)
      }
    })
    return {
      id: row.id,
      name: row.name,
      itemCount: items.length,
      songCount: items.filter((item) => item.kind === 'song').length,
      items,
      recordingTracks: this.getRehearsalRecordingTracks(id),
      recordingTakes: this.getRehearsalRecordingTakes(id),
      revisions: this.getRehearsalRevisions(id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastOpenedAt: row.last_opened_at
    }
  }

  saveRehearsal(request: SaveRehearsalRequest): RehearsalSetDetail {
    const current = this.sqlite.prepare('SELECT id FROM rehearsal_sets WHERE id = ?').get(request.id) as { id: string } | undefined
    if (!current) throw new Error('REHEARSAL_NOT_FOUND')
    const now = new Date().toISOString()
    this.sqlite.transaction(() => {
      this.sqlite.prepare('UPDATE rehearsal_sets SET name = ?, updated_at = ? WHERE id = ?')
        .run(request.name, now, request.id)
      this.sqlite.prepare('DELETE FROM rehearsal_items WHERE rehearsal_id = ?').run(request.id)
      const insert = this.sqlite.prepare(`
        INSERT INTO rehearsal_items(
          id, rehearsal_id, kind, song_id, title_snapshot, artist_snapshot, duration_ms, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      request.items.forEach((item, sortOrder) => {
        if (item.kind === 'transition') {
          insert.run(item.id, request.id, item.kind, null, '空白衔接', '', item.durationMs, sortOrder)
          return
        }
        const song = item.songId
          ? this.sqlite.prepare('SELECT title, artist, duration_ms FROM songs WHERE id = ?').get(item.songId) as {
            title: string; artist: string; duration_ms: number
          } | undefined
          : undefined
        insert.run(
          item.id,
          request.id,
          item.kind,
          song ? item.songId : null,
          song?.title ?? item.title,
          song?.artist ?? item.artist,
          song?.duration_ms ?? item.durationMs,
          sortOrder
        )
      })
    })()
    const result = this.getRehearsal(request.id, false)
    if (!result) throw new Error('REHEARSAL_NOT_FOUND')
    return result
  }

  duplicateRehearsal(rehearsalId: string, revisionId?: string): RehearsalSetDetail {
    const source = this.getRehearsal(rehearsalId, false)
    if (!source) throw new Error('REHEARSAL_NOT_FOUND')
    let sourceItems = source.items
    if (revisionId) {
      const revision = this.getRehearsalRevision(revisionId)
      if (!revision || revision.rehearsalId !== rehearsalId) throw new Error('REHEARSAL_REVISION_NOT_FOUND')
      sourceItems = revision.snapshot.items
    }
    const copy = this.createRehearsal(`${source.name} 副本`)
    const items = sourceItems.map((item): RehearsalItem => ({ ...item, id: randomUUID() }))
    return this.saveRehearsal({ id: copy.id, name: copy.name, items })
  }

  deleteRehearsalRecord(id: string): void {
    this.sqlite.prepare('DELETE FROM rehearsal_sets WHERE id = ?').run(id)
  }

  getRehearsalRevisions(rehearsalId: string): RehearsalRevision[] {
    const rows = this.sqlite.prepare(
      'SELECT * FROM rehearsal_revisions WHERE rehearsal_id = ? ORDER BY created_at DESC'
    ).all(rehearsalId) as RehearsalRevisionRow[]
    return rows.map(this.rehearsalRevisionRowToRecord)
  }

  getRehearsalRevision(id: string): RehearsalRevision | null {
    const row = this.sqlite.prepare('SELECT * FROM rehearsal_revisions WHERE id = ?').get(id) as RehearsalRevisionRow | undefined
    return row ? this.rehearsalRevisionRowToRecord(row) : null
  }

  getOrCreateRehearsalRevision(
    rehearsalId: string,
    fingerprint: string,
    snapshot: RehearsalRevisionSnapshot
  ): RehearsalRevision {
    const existing = this.sqlite.prepare(
      'SELECT * FROM rehearsal_revisions WHERE rehearsal_id = ? AND fingerprint = ?'
    ).get(rehearsalId, fingerprint) as RehearsalRevisionRow | undefined
    if (existing) return this.rehearsalRevisionRowToRecord(existing)
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.sqlite.prepare(`
      INSERT INTO rehearsal_revisions(id, rehearsal_id, fingerprint, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, rehearsalId, fingerprint, JSON.stringify(snapshot), createdAt)
    return { id, rehearsalId, fingerprint, snapshot, createdAt }
  }

  getRehearsalRecordingTracks(rehearsalId: string): RehearsalRecordingTrackState[] {
    const rows = this.sqlite.prepare(
      'SELECT * FROM rehearsal_recording_tracks WHERE rehearsal_id = ? ORDER BY sort_order, created_at'
    ).all(rehearsalId) as RehearsalRecordingTrackRow[]
    return rows.map(this.rehearsalRecordingTrackRowToRecord)
  }

  getRehearsalRecordingTrack(id: string): RehearsalRecordingTrackState | null {
    const row = this.sqlite.prepare('SELECT * FROM rehearsal_recording_tracks WHERE id = ?').get(id) as RehearsalRecordingTrackRow | undefined
    return row ? this.rehearsalRecordingTrackRowToRecord(row) : null
  }

  createRehearsalRecordingTrack(rehearsalId: string): RehearsalRecordingTrackState {
    if (!this.sqlite.prepare('SELECT id FROM rehearsal_sets WHERE id = ?').get(rehearsalId)) throw new Error('REHEARSAL_NOT_FOUND')
    const rows = this.sqlite.prepare(
      'SELECT name, sort_order FROM rehearsal_recording_tracks WHERE rehearsal_id = ? ORDER BY sort_order'
    ).all(rehearsalId) as Array<{ name: string; sort_order: number }>
    const names = new Set(rows.map((row) => row.name))
    let index = 1
    while (names.has(`录音轨 ${index}`)) index += 1
    const id = randomUUID()
    const now = new Date().toISOString()
    const sortOrder = rows.reduce((maximum, row) => Math.max(maximum, row.sort_order), -1) + 1
    this.sqlite.prepare(`
      INSERT INTO rehearsal_recording_tracks(
        id, rehearsal_id, name, active_take_id, gain_db, muted, solo, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, 0, 0, 0, ?, ?, ?)
    `).run(id, rehearsalId, `录音轨 ${index}`, sortOrder, now, now)
    const result = this.getRehearsalRecordingTrack(id)
    if (!result) throw new Error('REHEARSAL_RECORDING_TRACK_CREATE_FAILED')
    return result
  }

  updateRehearsalRecordingTrack(
    recordingTrackId: string,
    patch: Partial<Pick<RehearsalRecordingTrackState, 'name' | 'gainDb' | 'muted' | 'solo'>>
  ): RehearsalRecordingTrackState {
    const current = this.getRehearsalRecordingTrack(recordingTrackId)
    if (!current) throw new Error('REHEARSAL_RECORDING_TRACK_NOT_FOUND')
    const next = { ...current, ...patch }
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      UPDATE rehearsal_recording_tracks
      SET name = ?, gain_db = ?, muted = ?, solo = ?, updated_at = ?
      WHERE id = ?
    `).run(next.name, next.gainDb, Number(next.muted), Number(next.solo), now, recordingTrackId)
    return { ...next, updatedAt: now }
  }

  getRehearsalRecordingTakes(rehearsalId: string): RehearsalRecordingTake[] {
    const rows = this.sqlite.prepare(
      'SELECT * FROM rehearsal_recording_takes WHERE rehearsal_id = ? ORDER BY created_at DESC'
    ).all(rehearsalId) as RehearsalRecordingTakeRow[]
    return rows.map(this.rehearsalRecordingTakeRowToRecord)
  }

  getRehearsalRecordingTake(id: string): RehearsalRecordingTake | null {
    const row = this.sqlite.prepare('SELECT * FROM rehearsal_recording_takes WHERE id = ?').get(id) as RehearsalRecordingTakeRow | undefined
    return row ? this.rehearsalRecordingTakeRowToRecord(row) : null
  }

  getRehearsalRecordingTakeFile(id: string): {
    rehearsalId: string
    sourceRelPath: string
    previewRelPath: string
  } | null {
    const row = this.sqlite.prepare(`
      SELECT rehearsal_id, source_rel_path, preview_rel_path
      FROM rehearsal_recording_takes WHERE id = ?
    `).get(id) as { rehearsal_id: string; source_rel_path: string; preview_rel_path: string } | undefined
    return row ? {
      rehearsalId: row.rehearsal_id,
      sourceRelPath: row.source_rel_path,
      previewRelPath: row.preview_rel_path
    } : null
  }

  createRehearsalRecordingTake(input: StoredRehearsalRecordingTakeInput): RehearsalRecordingTake {
    const track = this.getRehearsalRecordingTrack(input.recordingTrackId)
    if (!track || track.rehearsalId !== input.rehearsalId) throw new Error('REHEARSAL_RECORDING_TRACK_NOT_FOUND')
    const revision = this.getRehearsalRevision(input.revisionId)
    if (!revision || revision.rehearsalId !== input.rehearsalId) throw new Error('REHEARSAL_REVISION_NOT_FOUND')
    const id = input.id ?? randomUUID()
    const createdAt = new Date().toISOString()
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO rehearsal_recording_takes(
          id, rehearsal_id, recording_track_id, revision_id, timeline_fingerprint, name,
          source_rel_path, preview_rel_path, duration_ms, start_position_ms, end_position_ms,
          sample_rate, channels, alignment_offset_ms, input_device_name, input_channels_json,
          device_snapshot_json, interrupted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.rehearsalId, input.recordingTrackId, input.revisionId, input.timelineFingerprint,
        input.name, input.sourceRelPath, input.previewRelPath, Math.round(input.durationMs),
        input.startPositionMs, input.endPositionMs, input.sampleRate, input.channels,
        input.alignmentOffsetMs, input.inputDeviceName, JSON.stringify(input.inputChannels),
        JSON.stringify(input.deviceSnapshot), Number(Boolean(input.interrupted)), createdAt
      )
      this.sqlite.prepare(`
        UPDATE rehearsal_recording_tracks SET active_take_id = ?, updated_at = ? WHERE id = ?
      `).run(id, createdAt, input.recordingTrackId)
    })()
    const result = this.getRehearsalRecordingTake(id)
    if (!result) throw new Error('REHEARSAL_RECORDING_TAKE_CREATE_FAILED')
    return result
  }

  updateRehearsalRecordingTake(
    id: string,
    patch: { name?: string; alignmentOffsetMs?: number; previewRelPath?: string }
  ): RehearsalRecordingTake {
    const updates: string[] = []
    const values: unknown[] = []
    if (patch.name !== undefined) { updates.push('name = ?'); values.push(patch.name) }
    if (patch.alignmentOffsetMs !== undefined) { updates.push('alignment_offset_ms = ?'); values.push(patch.alignmentOffsetMs) }
    if (patch.previewRelPath !== undefined) { updates.push('preview_rel_path = ?'); values.push(patch.previewRelPath) }
    if (updates.length) this.sqlite.prepare(
      `UPDATE rehearsal_recording_takes SET ${updates.join(', ')} WHERE id = ?`
    ).run(...values, id)
    const result = this.getRehearsalRecordingTake(id)
    if (!result) throw new Error('REHEARSAL_RECORDING_TAKE_NOT_FOUND')
    return result
  }

  selectRehearsalRecordingTake(recordingTrackId: string, takeId: string | null): void {
    const track = this.getRehearsalRecordingTrack(recordingTrackId)
    if (!track) throw new Error('REHEARSAL_RECORDING_TRACK_NOT_FOUND')
    if (takeId) {
      const take = this.getRehearsalRecordingTake(takeId)
      if (!take || take.recordingTrackId !== recordingTrackId) throw new Error('REHEARSAL_RECORDING_TAKE_NOT_FOUND')
    }
    this.sqlite.prepare(`
      UPDATE rehearsal_recording_tracks SET active_take_id = ?, updated_at = ? WHERE id = ?
    `).run(takeId, new Date().toISOString(), recordingTrackId)
  }

  deleteRehearsalRecordingTake(id: string): void {
    const take = this.getRehearsalRecordingTake(id)
    this.sqlite.transaction(() => {
      this.sqlite.prepare('DELETE FROM rehearsal_recording_takes WHERE id = ?').run(id)
      if (take) {
        this.sqlite.prepare(`
          UPDATE rehearsal_recording_tracks
          SET active_take_id = NULL, muted = 0, solo = 0, updated_at = ?
          WHERE id = ? AND active_take_id = ?
        `).run(new Date().toISOString(), take.recordingTrackId, id)
      }
    })()
  }

  nextRehearsalRecordingTakeName(recordingTrackId: string): string {
    const rows = this.sqlite.prepare(
      'SELECT name FROM rehearsal_recording_takes WHERE recording_track_id = ?'
    ).all(recordingTrackId) as Array<{ name: string }>
    const names = new Set(rows.map((row) => row.name))
    for (let index = 1; index < 100_000; index += 1) {
      const candidate = `Take ${index}`
      if (!names.has(candidate)) return candidate
    }
    return `Take ${new Date().toISOString()}`
  }

  private rehearsalRevisionRowToRecord = (row: RehearsalRevisionRow): RehearsalRevision => ({
    id: row.id,
    rehearsalId: row.rehearsal_id,
    fingerprint: row.fingerprint,
    snapshot: JSON.parse(row.snapshot_json) as RehearsalRevisionSnapshot,
    createdAt: row.created_at
  })

  private rehearsalRecordingTrackRowToRecord = (
    row: RehearsalRecordingTrackRow
  ): RehearsalRecordingTrackState => ({
    id: row.id,
    rehearsalId: row.rehearsal_id,
    name: row.name,
    activeTakeId: row.active_take_id,
    gainDb: row.gain_db,
    muted: Boolean(row.muted),
    solo: Boolean(row.solo),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })

  private rehearsalRecordingTakeRowToRecord = (
    row: RehearsalRecordingTakeRow
  ): RehearsalRecordingTake => {
    let deviceSnapshot: RecordingDeviceSnapshot
    try {
      deviceSnapshot = JSON.parse(row.device_snapshot_json) as RecordingDeviceSnapshot
    } catch {
      deviceSnapshot = {
        backend: 'wasapi-shared',
        inputDeviceId: '',
        inputDeviceName: row.input_device_name,
        outputDeviceId: '',
        outputDeviceName: '',
        inputChannels: JSON.parse(row.input_channels_json) as number[],
        sampleRate: row.sample_rate,
        bufferFrames: 0,
        latencyMs: 0,
        splitDevices: false,
        softwareMonitoring: false
      }
    }
    return {
      id: row.id,
      rehearsalId: row.rehearsal_id,
      recordingTrackId: row.recording_track_id,
      revisionId: row.revision_id,
      timelineFingerprint: row.timeline_fingerprint,
      name: row.name,
      durationMs: row.duration_ms,
      startPositionMs: row.start_position_ms,
      endPositionMs: row.end_position_ms,
      sampleRate: row.sample_rate,
      channels: row.channels,
      alignmentOffsetMs: row.alignment_offset_ms,
      inputDeviceName: row.input_device_name,
      inputChannels: JSON.parse(row.input_channels_json) as number[],
      deviceSnapshot,
      sourceMediaUrl: `bandbuddy-media://rehearsal/${row.rehearsal_id}/recording-source/${row.id}`,
      previewMediaUrl: `bandbuddy-media://rehearsal/${row.rehearsal_id}/recording-preview/${row.id}?alignment=${row.alignment_offset_ms}`,
      interrupted: Boolean(row.interrupted),
      createdAt: row.created_at
    }
  }

  getArtworkRelative(songId: string): string | null {
    const row = this.sqlite.prepare('SELECT artwork_rel_path FROM songs WHERE id = ?').get(songId) as { artwork_rel_path: string | null } | undefined
    return row?.artwork_rel_path ?? null
  }

  deleteSongRecord(id: string): void {
    this.sqlite.prepare('DELETE FROM songs WHERE id = ?').run(id)
  }

  hasActiveJobs(): boolean {
    const row = this.sqlite.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','preparing','separating','postprocessing','cancelling')`).get() as { count: number }
    return row.count > 0
  }

  private jobRowToRecord = (row: JobRow): JobRecord => ({
    id: row.id,
    songId: row.song_id,
    type: row.type,
    status: row.status,
    phase: row.phase,
    progress: row.progress,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  })
}

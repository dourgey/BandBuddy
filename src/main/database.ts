import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  createDefaultPracticeState,
  type AppSettings,
  type JobRecord,
  type JobStatus,
  type PracticeState,
  type SongDetail,
  type SongStatus,
  type SongSummary,
  type StemRecord,
  type StemType
} from '@shared/domain.js'
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
  `
]

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
      keepSource: true,
      closeToTrayWhileWorking: true,
      network: {
        proxyMode: 'system',
        proxyUrl: '',
        pythonIndexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple',
        pytorchIndexUrl: ''
      }
    }
  }

  getSettings(): AppSettings {
    const row = this.sqlite.prepare("SELECT value_json FROM settings WHERE key = 'app'").get() as { value_json: string } | undefined
    if (!row) return this.defaultSettings()
    const saved = JSON.parse(row.value_json) as Partial<AppSettings>
    const defaults = this.defaultSettings()
    return { ...defaults, ...saved, network: { ...defaults.network, ...saved.network } }
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
    return {
      ...this.songRowToSummary(row),
      bpm: row.bpm,
      beatOffsetMs: row.beat_offset_ms,
      musicalKey: row.musical_key,
      timeSignature: row.time_signature,
      sourceFormat: row.source_format,
      sampleRate: row.sample_rate,
      channels: row.channels,
      stems,
      practice
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

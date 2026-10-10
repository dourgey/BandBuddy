import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BandBuddyDatabase, DATABASE_MIGRATIONS } from '../src/main/database.js'
import type { AppPaths } from '../src/main/paths.js'

vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  class TestDatabase extends DatabaseSync {
    pragma(statement: string): void { this.exec(`PRAGMA ${statement}`) }
    transaction(fn: (...args: unknown[]) => unknown) {
      const run = (...args: unknown[]) => {
        this.exec('BEGIN')
        try { const result = fn(...args); this.exec('COMMIT'); return result }
        catch (error) { this.exec('ROLLBACK'); throw error }
      }
      return Object.assign(run, { deferred: run, immediate: run, exclusive: run })
    }
  }
  return { default: TestDatabase }
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function paths(): AppPaths {
  const root = mkdtempSync(path.join(tmpdir(), 'bandbuddy-db-中文 '))
  roots.push(root)
  return { databasePath: path.join(root, 'library.db'), backupRoot: path.join(root, '备份'), defaultLibraryRoot: root, pythonRoot: root, modelRoot: root } as AppPaths
}

describe('migration backups and large-library queries', () => {
  it('restores song EQ after reopening and defaults legacy practice JSON without a migration', () => {
    const locations = paths()
    let database = new BandBuddyDatabase(locations)
    const id = '11111111-1111-4111-8111-111111111111'
    database.sqlite.prepare('INSERT INTO songs(id,title,artist,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, 'EQ 乐曲', '', '2026-10-10', '2026-10-10')
    const legacy = database.getSong(id)!.practice
    const { eq: omitted, ...saved } = legacy
    database.sqlite.prepare('INSERT INTO practice_states(song_id,state_json,updated_at) VALUES (?,?,?)').run(id, JSON.stringify(saved), '2026-10-10')
    const normalized = database.getSong(id)!.practice
    expect(normalized.eq.enabled).toBe(false)
    expect(normalized.eq.graphicGains).toHaveLength(10)
    normalized.eq.enabled = true; normalized.eq.mode = 'parametric'
    normalized.eq.graphicGains[4] = -5.2
    normalized.eq.nodes[0] = { id: 'custom', frequency: 333.3, gainDb: 7.4, q: 3.2 }
    database.savePractice(normalized)
    database.close()
    database = new BandBuddyDatabase(locations)
    expect(database.getSong(id)!.practice.eq).toEqual(normalized.eq)
    expect(database.sqlite.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toMatchObject({ version: DATABASE_MIGRATIONS.length })
    database.close()
  })
  it('backs up committed WAL content only when a migration is required', () => {
    const locations = paths()
    const writer = new DatabaseSync(locations.databasePath)
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    for (let index = 0; index < DATABASE_MIGRATIONS.length - 1; index += 1) {
      writer.exec(DATABASE_MIGRATIONS[index]!)
      writer.prepare('INSERT INTO schema_version VALUES (?, ?)').run(index + 1, '2026-09-22')
    }
    writer.prepare("INSERT INTO songs(id,title,artist,created_at,updated_at) VALUES ('wal-song','WAL 中的乐曲','乐队','2026-09-22','2026-09-22')").run()
    const database = new BandBuddyDatabase(locations)
    const files = readdirSync(locations.backupRoot)
    expect(files).toHaveLength(1)
    const snapshot = new DatabaseSync(path.join(locations.backupRoot, files[0]!))
    expect(snapshot.prepare("SELECT title FROM songs WHERE id='wal-song'").get()?.title).toBe('WAL 中的乐曲')
    expect(snapshot.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version).toBe(DATABASE_MIGRATIONS.length - 1)
    snapshot.close()
    database.close()
    writer.close()
    new BandBuddyDatabase(locations).close()
    expect(readdirSync(locations.backupRoot)).toEqual(files)
  })

  it('paginates stable results, preserves Unicode/literal search and reads recent songs independently', () => {
    const database = new BandBuddyDatabase(paths())
    const insert = database.sqlite.prepare('INSERT INTO songs(id,title,artist,favorite,status,created_at,updated_at,last_practiced_at) VALUES (?,?,?,?,?,?,?,?)')
    for (let i = 0; i < 450; i += 1) insert.run(String(i).padStart(4, '0'), i === 2 ? 'ÉTÉ 100%_中文' : `Song ${i}`, '乐队', i % 2, i === 1 ? 'queued' : 'ready', '2026-01-01', '2026-01-01', i === 7 ? '2026-09-22' : null)
    const first = database.listSongsPage({ limit: 80 })
    expect(first.total).toBe(450)
    expect(first.items).toHaveLength(80)
    const second = database.listSongsPage({ offset: 80, limit: 80 })
    expect(second.items.some(item => first.items.some(previous => previous.id === item.id))).toBe(false)
    expect(database.listSongs('été 100%_中文')).toHaveLength(1)
    expect(database.listSongsPage({ filter: 'favorite' }).total).toBe(225)
    expect(database.listSongsPage({ filter: 'processing' }).total).toBe(1)
    expect(database.recentSongs().map(song => song.id)).toEqual(['0007'])
    const prepare = vi.spyOn(database.sqlite, 'prepare')
    expect(database.listSongs()).toHaveLength(450)
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(5)
    prepare.mockRestore()
    database.close()
  })
})

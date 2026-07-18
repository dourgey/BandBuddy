import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('SQLite migration contract', () => {
  it('contains every durable MVP table and WAL initialization', () => {
    const source = readFileSync(new URL('../src/main/database.ts', import.meta.url), 'utf8')
    for (const table of ['songs', 'separation_runs', 'stems', 'practice_states', 'track_states', 'jobs', 'settings']) {
      expect(source).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    expect(source).toContain("journal_mode = WAL")
    expect(source).toContain('backupBeforeMigrate')
    expect(source).toContain('beat_offset_ms REAL NOT NULL DEFAULT 0')
  })
})

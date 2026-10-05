import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyDatabaseRecovery, stageDatabaseRecovery } from '../src/main/database-recovery.js'

vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  return { default: class {
    db: DatabaseSync
    constructor(file: string) { this.db = new DatabaseSync(file, { readOnly: true }) }
    pragma(sql: string) { return Object.values(this.db.prepare('PRAGMA ' + sql).get()!)[0] }
    prepare(sql: string) { return this.db.prepare(sql) }
    close() { this.db.close() }
  } }
})
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bb-db-recovery-')); roots.push(root)
  const backup = path.join(root, 'backup.db'), current = path.join(root, 'bandbuddy.db')
  const database = new DatabaseSync(backup); database.exec('CREATE TABLE songs(id TEXT); CREATE TABLE settings(key TEXT); INSERT INTO songs VALUES ("saved")'.replace('"saved"', "'saved'")); database.close()
  await writeFile(current, 'damaged original database'); await writeFile(current + '-wal', 'original wal')
  return { root, backup, current }
}
describe('database-independent recovery', () => {
  it('validates before staging and keeps original database and sidecar evidence', async () => {
    const { root, backup, current } = await setup()
    await stageDatabaseRecovery(root, backup)
    expect(await readFile(current, 'utf8')).toBe('damaged original database')
    await applyDatabaseRecovery(root, current)
    const database = new DatabaseSync(current); expect(database.prepare('SELECT id FROM songs').get()?.id).toBe('saved'); database.close()
    const saved = (await readdir(path.join(root, 'recovery'))).find(name => name.startsWith('before-restore-'))!
    expect(await readFile(path.join(root, 'recovery', saved, 'bandbuddy.db'), 'utf8')).toBe('damaged original database')
    expect(await readFile(path.join(root, 'recovery', saved, 'bandbuddy.db-wal'), 'utf8')).toBe('original wal')
    await applyDatabaseRecovery(root, current) // Consumed requests cannot repeat a restore.
  })
  it('rejects corrupted backups and refuses a staged candidate altered after validation', async () => {
    const { root, backup, current } = await setup()
    await expect(stageDatabaseRecovery(root, current)).rejects.toThrow()
    expect(await readFile(current, 'utf8')).toBe('damaged original database')
    await stageDatabaseRecovery(root, backup); await writeFile(path.join(root, 'recovery/restore-candidate.db'), 'tampered')
    await expect(applyDatabaseRecovery(root, current)).rejects.toThrow('校验失败')
    expect(await readFile(current + '-wal', 'utf8')).toBe('original wal')
  })
})

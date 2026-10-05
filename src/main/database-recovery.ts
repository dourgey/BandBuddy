import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { writeJsonAtomic, fileDigest } from './artifact-download.js'

/** Staging never touches the current database; apply only in a fresh process. */
export async function stageDatabaseRecovery(root: string, backup: string): Promise<void> {
  const directory = path.join(root, 'recovery'); await mkdir(directory, { recursive: true })
  const staged = path.join(directory, 'restore-candidate.db')
  if (path.resolve(backup) === path.resolve(staged)) throw new Error('请选择原始数据库备份。')
  await copyFile(backup, staged)
  let database: Database.Database | undefined
  try {
    database = new Database(staged, { readonly: true, fileMustExist: true })
    if (database.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('备份数据库未通过完整性检查。')
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('songs', 'settings')").all()
    if (tables.length !== 2) throw new Error('请选择 BandBuddy 曲库备份。')
  } finally { database?.close() }
  await writeJsonAtomic(path.join(directory, 'restore-request.json'), { schema: 1, sha256: await fileDigest(staged) })
}

export async function applyDatabaseRecovery(root: string, databasePath: string): Promise<void> {
  const directory = path.join(root, 'recovery'), requestFile = path.join(directory, 'restore-request.json')
  let request: { schema: number; sha256: string }
  try { request = JSON.parse(await readFile(requestFile, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const staged = path.join(directory, 'restore-candidate.db')
  if (request.schema !== 1 || !/^[a-f0-9]{64}$/.test(request.sha256) || await fileDigest(staged) !== request.sha256) throw new Error('数据库恢复文件校验失败，原有数据已保留。')
  const preserved = path.join(directory, `before-restore-${Date.now()}`); await mkdir(preserved, { recursive: true })
  // Copy every original sidecar before replacing anything. A failed copy leaves the live files intact.
  const originals: string[] = []
  for (const suffix of ['', '-wal', '-shm']) {
    const source = databasePath + suffix
    if (!await stat(source).catch(() => null)) continue
    await copyFile(source, path.join(preserved, 'bandbuddy.db' + suffix), constants.COPYFILE_EXCL)
    originals.push(source)
  }
  const candidate = databasePath + '.restore.part'
  await copyFile(staged, candidate)
  try {
    for (const file of originals.filter(file => file !== databasePath)) await rm(file)
    await rename(candidate, databasePath)
  } catch (error) {
    // Restore the originals if replacement fails (for example antivirus locks).
    await Promise.all(originals.map(file => copyFile(path.join(preserved, path.basename(file)), file).catch(() => {})))
    throw error
  }
  await rm(requestFile)
}

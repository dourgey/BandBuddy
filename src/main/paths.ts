import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export class AppPaths {
  readonly dataRoot: string
  readonly localRoot: string
  readonly databasePath: string
  readonly backupRoot: string
  readonly cacheRoot: string
  readonly downloadRoot: string
  readonly logsRoot: string
  readonly jobsRoot: string
  readonly pythonRoot: string
  readonly modelRoot: string
  readonly toolsRoot: string
  readonly defaultLibraryRoot: string

  constructor() {
    const developmentTestRoot = process.env.BANDBUDDY_SMOKE === '1' || !app.isPackaged ? process.env.BANDBUDDY_TEST_ROOT : undefined
    this.dataRoot = app.getPath('userData')
    this.localRoot = developmentTestRoot
      ? path.join(developmentTestRoot, 'local')
      : path.join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'BandBuddy')
    this.databasePath = path.join(this.dataRoot, 'bandbuddy.db')
    this.backupRoot = path.join(this.dataRoot, 'backups')
    this.cacheRoot = path.join(this.localRoot, 'cache')
    this.downloadRoot = path.join(this.cacheRoot, 'downloads')
    this.logsRoot = path.join(this.localRoot, 'logs')
    this.jobsRoot = path.join(this.localRoot, 'jobs')
    this.pythonRoot = path.join(this.localRoot, 'envs')
    this.modelRoot = path.join(this.pythonRoot, 'models')
    this.toolsRoot = path.join(this.localRoot, 'tools')
    this.defaultLibraryRoot = path.join(this.localRoot, 'music')
  }

  ensure(): void {
    for (const directory of [
      this.dataRoot,
      this.localRoot,
      this.backupRoot,
      this.cacheRoot,
      this.downloadRoot,
      this.logsRoot,
      this.jobsRoot,
      this.pythonRoot,
      this.modelRoot,
      this.toolsRoot,
      this.defaultLibraryRoot
    ]) {
      mkdirSync(directory, { recursive: true })
    }
  }

  private assertInside(root: string, candidate: string): string {
    const resolvedRoot = path.resolve(root)
    const resolvedCandidate = path.resolve(candidate)
    const relative = path.relative(resolvedRoot, resolvedCandidate)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('PATH_OUTSIDE_MANAGED_ROOT')
    }
    return resolvedCandidate
  }

  resolveLibraryPath(libraryRoot: string, relativePath: string): string {
    if (path.isAbsolute(relativePath)) throw new Error('ABSOLUTE_LIBRARY_PATH_REJECTED')
    return this.assertInside(libraryRoot, path.join(libraryRoot, relativePath))
  }

  toLibraryRelative(libraryRoot: string, absolutePath: string): string {
    const safe = this.assertInside(libraryRoot, absolutePath)
    return path.relative(path.resolve(libraryRoot), safe).split(path.sep).join('/')
  }

  songDirectory(libraryRoot: string, songId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(songId)) throw new Error('INVALID_SONG_ID')
    return this.assertInside(libraryRoot, path.join(libraryRoot, songId))
  }

  jobDirectory(jobId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error('INVALID_JOB_ID')
    return this.assertInside(this.jobsRoot, path.join(this.jobsRoot, jobId))
  }

  packagedResource(...segments: string[]): string {
    return path.join(process.resourcesPath, ...segments)
  }
}

export { isManagedPath } from './path-safety.js'

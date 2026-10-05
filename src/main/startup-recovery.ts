import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Small boot journal independent of SQLite, Python and native audio libraries. */
export class StartupRecovery {
  private failures = 0
  private rendered = false
  readonly safeMode: boolean
  private readonly file: string
  constructor(root: string, forceSafe = false) {
    this.file = path.join(root, 'startup-recovery.json')
    try { const saved = JSON.parse(readFileSync(this.file, 'utf8')); this.failures = Math.min(10, Math.max(0, Number(saved.failures) || 0)) } catch { /* First launch. */ }
    this.safeMode = forceSafe || this.failures >= 2
  }
  begin(): void { this.save(this.failures + 1) }
  success(): void { this.rendered = true; this.save(0) }
  fail(): void { this.save(Math.max(2, this.failures)) }
  clear(): void { this.save(0) }
  private save(failures: number): void {
    this.failures = failures
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${process.pid}.part`
      writeFileSync(temporary, JSON.stringify({ schema: 1, failures, rendered: this.rendered }))
      renameSync(temporary, this.file)
    } catch { /* Read-only/full disks must still allow a recovery screen. */ }
  }
}

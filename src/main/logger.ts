import { appendFileSync, mkdirSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'

const SENSITIVE = /(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/gi
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export class Logger {
  private readonly applicationLogPath: string
  readonly debugLogPath: string
  private queue: Array<{ file: string; line: string; bytes: number }> = []
  private queuedBytes = 0
  private timer: NodeJS.Timeout | null = null
  private flushing: Promise<void> | null = null

  constructor(private readonly logsRoot: string, private debugMode = false) {
    try { mkdirSync(logsRoot, { recursive: true }) } catch { /* Diagnostics must not block startup. */ }
    this.applicationLogPath = path.join(logsRoot, 'bandbuddy.log')
    this.debugLogPath = path.join(logsRoot, 'debug.log')
    if (debugMode) this.capture('debug', 'debug logging session started', { pid: process.pid })
  }

  private redact(value: unknown): string {
    let text: string
    if (typeof value === 'string') text = value
    else if (value instanceof Error) text = `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`
    else {
      try {
        text = JSON.stringify(value, (_key, nested) => nested instanceof Error
          ? { name: nested.name, message: nested.message, stack: nested.stack }
          : nested) ?? String(value)
      }
      catch { text = String(value) }
    }
    return text.replace(SENSITIVE, '$1***:***@').replace(/(token|password|authorization)["'=:\s]+[^\s",}]+/gi, '$1=***')
  }

  private format(level: LogLevel, message: string, detail?: unknown): string {
    return JSON.stringify({
      at: new Date().toISOString(),
      level,
      message: this.redact(message),
      ...(detail === undefined ? {} : { detail: this.redact(detail) })
    })
  }

  private append(filePath: string, line: string): void {
    const content = `${line}\n`
    const bytes = Buffer.byteLength(content)
    // Bound both the number of entries and their memory footprint. Retain the
    // newest context when a slow disk cannot keep up with verbose diagnostics.
    if (bytes > 256 * 1024) return
    while (this.queue.length >= 2048 || this.queuedBytes + bytes > 1024 * 1024) {
      this.queuedBytes -= this.queue.shift()!.bytes
    }
    this.queue.push({ file: filePath, line: content, bytes })
    this.queuedBytes += bytes
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush() }, 100)
      this.timer.unref()
    }
  }

  /** Await at shutdown and before reading an exported diagnostic log. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0)
        this.queuedBytes = 0
        const files = new Map<string, string[]>()
        for (const entry of batch) {
          const lines = files.get(entry.file) ?? []
          lines.push(entry.line)
          files.set(entry.file, lines)
        }
        await Promise.all([...files].map(async ([file, lines]) => {
          try { await appendFile(file, lines.join(''), 'utf8') } catch { /* Best-effort logging, including full/read-only disks. */ }
        }))
      }
    })().finally(() => { this.flushing = null })
    return this.flushing
  }

  write(level: Exclude<LogLevel, 'debug'>, message: string, detail?: unknown): void {
    const line = this.format(level, message, detail)
    this.append(this.applicationLogPath, line)
    if (this.debugMode) this.append(this.debugLogPath, line)
  }

  capture(level: LogLevel, message: string, detail?: unknown): void {
    if (!this.debugMode) return
    this.append(this.debugLogPath, this.format(level, message, detail))
  }

  setDebugMode(enabled: boolean): void {
    if (enabled === this.debugMode) return
    if (enabled) {
      this.debugMode = true
      this.capture('info', 'debug mode enabled', { pid: process.pid })
    } else {
      this.capture('info', 'debug mode disabled')
      this.debugMode = false
    }
  }

  ensureDebugLog(): string {
    mkdirSync(this.logsRoot, { recursive: true })
    appendFileSync(this.debugLogPath, '', 'utf8')
    return this.debugLogPath
  }

  info(message: string, detail?: unknown): void { this.write('info', message, detail) }
  warn(message: string, detail?: unknown): void { this.write('warn', message, detail) }
  error(message: string, detail?: unknown): void { this.write('error', message, detail) }
}

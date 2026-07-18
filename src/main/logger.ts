import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const SENSITIVE = /(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/gi

export class Logger {
  constructor(private readonly logsRoot: string) {
    mkdirSync(logsRoot, { recursive: true })
  }

  private redact(value: unknown): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.replace(SENSITIVE, '$1***:***@').replace(/(token|password|authorization)["'=:\s]+[^\s",}]+/gi, '$1=***')
  }

  write(level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      level,
      message: this.redact(message),
      ...(detail === undefined ? {} : { detail: this.redact(detail) })
    })
    appendFileSync(path.join(this.logsRoot, 'bandbuddy.log'), `${line}\n`, 'utf8')
  }

  info(message: string, detail?: unknown): void { this.write('info', message, detail) }
  warn(message: string, detail?: unknown): void { this.write('warn', message, detail) }
  error(message: string, detail?: unknown): void { this.write('error', message, detail) }
}

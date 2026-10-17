import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DiagnosticEvent, DiagnosticReport, DiagnosticScope, EnvironmentCapability, EnvironmentIssue } from '@shared/environment.js'
import { errorEvidence, redactDiagnostics, registerDiagnosticRoots } from './diagnostic-errors.js'
import { environmentIssue } from './environment-issues.js'

const MAX_EVENTS = 600, MAX_ISSUES = 80, MAX_BYTES = 2 * 1024 * 1024
const scopeContext = new AsyncLocalStorage<DiagnosticScope>()
export class DiagnosticStore {
  readonly runId = randomUUID()
  private events: DiagnosticEvent[] = []
  private issues: EnvironmentIssue[] = []
  private file?: string
  private version = 'unknown'
  private persistenceError: DiagnosticReport['persistenceError'] = null
  private timer?: NodeJS.Timeout
  private saving = Promise.resolve()
  private loaded = Promise.resolve()
  withScope<T>(scope: DiagnosticScope, work: () => T): T { return scopeContext.run({ ...scopeContext.getStore(), ...scope }, work) }
  initialize(root: string, version: string): void {
    this.file = path.join(root, 'environment-diagnostics.json'); this.version = version
    registerDiagnosticRoots([root])
    this.loaded = readFile(this.file, 'utf8').then(text => {
      if (Buffer.byteLength(text) > MAX_BYTES * 2) return
      const old = JSON.parse(text)
      if (old.schema !== 2) return
      this.events = [...(Array.isArray(old.events) ? old.events.filter((e: DiagnosticEvent) => e && typeof e.id === 'string' && typeof e.at === 'string') : []), ...this.events].slice(-MAX_EVENTS)
      this.issues = [...(Array.isArray(old.issues) ? old.issues.filter((i: EnvironmentIssue) => i && typeof i.code === 'string' && typeof i.diagnosticId === 'string') : []), ...this.issues].slice(-MAX_ISSUES)
    }).catch(error => { if (error.code !== 'ENOENT') this.persistenceError = errorEvidence(error) })
  }
  record(event: Omit<DiagnosticEvent, 'id' | 'at' | 'runId'>): void {
    const clean = JSON.parse(redactDiagnostics({ ...scopeContext.getStore(), ...event })) as typeof event
    this.events.push({ ...clean, id: randomUUID(), at: new Date().toISOString(), runId: this.runId })
    this.events = this.events.slice(-MAX_EVENTS)
    if (this.file && !this.timer) { this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 100); this.timer.unref() }
  }
  report(error: unknown, capability: EnvironmentCapability, context: Partial<EnvironmentIssue> & { jobId?: string } = {}): EnvironmentIssue {
    const { jobId, ...rest } = { ...scopeContext.getStore(), ...context }
    const issue = JSON.parse(redactDiagnostics(environmentIssue(error, capability, { runId: this.runId, ...rest }))) as EnvironmentIssue
    this.issues = [...this.issues.filter(item => item.diagnosticId !== issue.diagnosticId), issue].slice(-MAX_ISSUES)
    this.record({ component: issue.component!, stage: issue.stage!, result: issue.code, diagnosticId: issue.diagnosticId, jobId, details: issue })
    return issue
  }
  getIssue(id?: string): EnvironmentIssue | undefined { return this.issues.find(issue => issue.diagnosticId === id) }
  resolved(id?: string): void {
    const issue = this.getIssue(id)
    if (!issue || issue.resolvedAt) return
    issue.resolvedAt = new Date().toISOString()
    this.attempted(id, '复检完成', '已解决')
  }
  attempted(id: string | undefined, action: string, result: string): void {
    const issue = this.getIssue(id)
    if (!issue) return
    issue.attempts = [...(issue.attempts ?? []), { at: new Date().toISOString(), action, result }].slice(-12)
    this.record({ component: issue.component!, stage: issue.stage!, diagnosticId: id, result, details: { action } })
  }
  snapshot(scope: DiagnosticScope = {}): DiagnosticReport {
    const jobEvents = scope.jobId ? this.events.filter(event => event.jobId === scope.jobId) : this.events
    const ids = new Set(jobEvents.map(event => event.diagnosticId))
    const issues = this.issues.filter(issue => scope.diagnosticId ? issue.diagnosticId === scope.diagnosticId : scope.jobId ? ids.has(issue.diagnosticId) : true)
    const events = scope.diagnosticId ? this.events.filter(event => event.diagnosticId === scope.diagnosticId) : jobEvents
    const summary = issues.map(issue => [
      `诊断编号：${issue.diagnosticId}`, `功能：${issue.capability}；阶段：${issue.stage}；组件：${issue.component}`,
      `状态：${issue.resolvedAt ? '已解决' : '待处理'}`, `问题：${issue.message}（${issue.code}）`, `原因判断：${issue.confidence === 'confirmed' ? '已确认' : issue.confidence === 'suspected' ? '可能原因，需核实' : '原因待确认'}`,
      `原始证据：${issue.evidence?.message ?? '未提供'}`,
      `已尝试：${issue.attempts?.map(item => `${item.action} → ${item.result}`).join('；') || '未执行修复'}`,
      `下一步：${issue.nextSteps?.join('；') ?? '导出诊断进一步排查'}`
    ].join('\n')).join('\n\n') || '当前没有记录到故障。'
    return JSON.parse(redactDiagnostics({ schema: 2, runId: this.runId, applicationVersion: this.version, platform: process.platform, arch: process.arch, os: os.release(), issues, events, persistenceError: this.persistenceError, summary }))
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    this.saving = this.saving.then(async () => {
      await this.loaded
      if (!this.file) return
      const report = this.snapshot()
      // The summary is derived for display/export; do not duplicate it in the bounded journal.
      report.summary = ''
      let text = redactDiagnostics(report)
      while (Buffer.byteLength(text) > MAX_BYTES && (report.events.length || report.issues.length)) {
        if (report.events.length) report.events.splice(0, Math.max(1, Math.ceil(report.events.length / 4)))
        else report.issues.splice(0, Math.max(1, Math.ceil(report.issues.length / 4)))
        text = redactDiagnostics(report)
      }
      const temporary = `${this.file}.${this.runId}.part`
      try { await mkdir(path.dirname(this.file), { recursive: true }); await writeFile(temporary, text, 'utf8'); await rename(temporary, this.file); this.persistenceError = null }
      catch (error) { this.persistenceError = errorEvidence(error) }
      finally { await rm(temporary, { force: true }).catch(() => {}) }
    }).catch(error => { this.persistenceError = errorEvidence(error) })
    await this.saving
  }
  async export(destination: string, scope?: DiagnosticScope, details?: unknown): Promise<void> {
    await this.flush()
    await writeFile(destination, redactDiagnostics({ ...this.snapshot(scope), ...(details ? { details } : {}) }), 'utf8')
  }
}
export const diagnostics = new DiagnosticStore()

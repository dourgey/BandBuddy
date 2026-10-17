import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { DiagnosticScope, EnvironmentCapability, EnvironmentCheck, EnvironmentComponent, EnvironmentIssue, EnvironmentState } from '@shared/environment.js'
import type { RuntimeInfo } from '@shared/domain.js'
import { writeJsonAtomic } from './artifact-download.js'
import { DiagnosticError, errorEvidence, evidenceText, registerDiagnosticRoots } from './diagnostic-errors.js'
import { diagnostics, type DiagnosticStore } from './diagnostics.js'
import { environmentIssue } from './environment-issues.js'
import type { RuntimeManager } from './runtime.js'
import type { MediaService } from './media.js'
import type { Logger } from './logger.js'
import type { AppPaths } from './paths.js'
export { environmentIssue } from './environment-issues.js'
export { redactDiagnostics } from './diagnostic-errors.js'

interface Journal {
  schema: 2; version: string; paused: boolean; attempts: string[]; issues: EnvironmentIssue[]
  pending?: string; configuration?: string; reachable?: Partial<Record<EnvironmentCapability, boolean>>
}
interface Operation { mode: 'check' | 'prepare' | 'repair'; capability?: EnvironmentCapability; component?: EnvironmentComponent; explicit?: boolean; forceCpu?: boolean }
interface Options {
  diagnostics?: DiagnosticStore
  inspectAudio?: (signal: AbortSignal) => Promise<{ checks: EnvironmentCheck[]; issues: EnvironmentIssue[] }>
}
const capabilities: EnvironmentCapability[] = ['startup', 'media', 'recording', 'separation', 'acceleration']
const requiresAction = new Set(['AUTHORIZATION_REQUIRED', 'RESTART_REQUIRED', 'SYSTEM_INSTALL_PENDING', 'SYSTEM_PROBE_FAILED', 'UNSUPPORTED_SYSTEM', 'STORAGE_UNAVAILABLE', 'DISK_FULL', 'SIGNATURE_INVALID', 'TRUST_CHECK_FAILED', 'CERTIFICATE_TIME_INVALID', 'CPU_OUT_OF_MEMORY'])

export class EnvironmentManager {
  private readonly file: string
  private journal: Journal
  private task: Promise<EnvironmentState> | null = null
  private closing = false
  private deferring: Promise<void> | null = null
  private state: EnvironmentState
  private saving = Promise.resolve()
  private controller = new AbortController()
  private listeners = new Set<(state: EnvironmentState) => void>()
  private readonly unsubscribe: () => void
  private readonly loaded: Promise<void>
  private readonly diagnostics: DiagnosticStore
  private networkTask: Promise<void> | null = null
  private persistenceFailed = false
  constructor(private readonly paths: AppPaths, private readonly runtime: RuntimeManager, private readonly media: MediaService,
    private readonly logger: Logger, private readonly version: string, private readonly busy: () => boolean,
    safeMode = false, private readonly suppressAutomatic = false, private readonly options: Options = {}) {
    this.diagnostics = options.diagnostics ?? diagnostics
    registerDiagnosticRoots([paths.localRoot, paths.dataRoot])
    this.file = path.join(paths.localRoot, 'environment-state.json')
    this.journal = { schema: 2, version, paused: false, attempts: [], issues: [], reachable: {} }
    this.state = { phase: 'checking', message: '正在检查可用功能', progress: null, receivedBytes: 0, totalBytes: null,
      pausedByUser: false, safeMode, capabilities: { startup: 'ready', media: 'unchecked', recording: 'unchecked', separation: 'unchecked', acceleration: 'unchecked' }, issues: [], checks: [], runId: this.diagnostics.runId }
    this.loaded = this.load()
    this.unsubscribe = runtime.onChange(info => this.runtimeChanged(info))
    runtime.setPreparationGate(signal => this.waitForIdle(signal))
    runtime.setFaultRecovery(async cpu => {
      await this.loaded; await this.task
      if (this.journal.paused || this.closing || this.state.safeMode) return false
      const key = `fault:separation:${cpu ? 'cpu' : 'repair'}`
      if (this.journal.attempts.includes(key)) return false
      this.journal.attempts.push(key); await this.persist()
      await this.schedule({ mode: 'repair', capability: 'separation', forceCpu: cpu })
      return this.state.capabilities.separation === 'ready' && !this.state.issues.some(issue => issue.capability === 'separation' && issue.severity !== 'warning')
    })
  }
  private async load(): Promise<void> {
    try {
      const saved = await readFile(this.file, 'utf8')
      if (saved.length > 2 * 1024 * 1024) throw new Error('ENVIRONMENT_JOURNAL_TOO_LARGE')
      const data = JSON.parse(saved)
      if (data.schema === 1 || data.schema === 2) {
        this.journal.paused = data.paused === true
        if (data.version === this.version) {
          this.journal.attempts = Array.isArray(data.attempts) ? data.attempts.filter((v: unknown) => typeof v === 'string').slice(-30) : []
          this.journal.issues = Array.isArray(data.issues) ? data.issues.filter((issue: EnvironmentIssue) => issue && typeof issue.code === 'string' && typeof issue.message === 'string' && capabilities.includes(issue.capability)).slice(-30) : []
          this.journal.reachable = data.reachable && typeof data.reachable === 'object' ? data.reachable : {}
          this.journal.configuration = typeof data.configuration === 'string' ? data.configuration : undefined
        }
        if (data.pending) this.diagnostics.record({ component: 'startup', stage: String(data.pending), result: 'interrupted', details: '上次准备中断，将先复检实际结果' })
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.diagnostics.record({ component: 'startup', stage: 'load-environment-state', result: 'failed', details: errorEvidence(error) }) }
    this.patch({ pausedByUser: this.journal.paused, issues: this.journal.issues })
    if (this.journal.paused || this.state.safeMode) this.patch({ phase: 'paused', message: this.state.safeMode ? '兼容启动已暂停自动准备' : '准备已暂停，下载进度已保留' })
  }
  private persist(): Promise<void> {
    const snapshot = structuredClone(this.journal)
    this.saving = this.saving.then(() => writeJsonAtomic(this.file, snapshot)).then(() => { this.persistenceFailed = false }).catch(error => {
      if (!this.persistenceFailed) this.diagnostics.record({ component: 'storage', stage: 'save-environment-state', result: 'failed', details: errorEvidence(error) })
      this.persistenceFailed = true
    })
    return this.saving
  }
  get(): EnvironmentState { return structuredClone(this.state) }
  isBusy(): boolean { return this.task !== null }
  onChanged(listener: (state: EnvironmentState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private patch(patch: Partial<EnvironmentState>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(this.get()) }
  private setCheck(check: EnvironmentCheck): void { this.patch({ checks: [...(this.state.checks ?? []).filter(item => item.id !== check.id), check] }) }
  private runtimeChanged(info: RuntimeInfo): void {
    for (const check of info.checks ?? []) this.setCheck(check)
    this.patch({ issues: [...this.state.issues.filter(issue => issue.capability !== 'acceleration'), ...(info.warnings ?? [])] })
    const active = ['installing', 'downloadingModel', 'verifying', 'detecting'].includes(info.status)
    if (active && !this.journal.paused && !this.closing) this.patch({ phase: 'preparing', message: info.stage || '正在检查可用功能', progress: info.downloadTotalBytes ? Math.min(1, (info.downloadedBytes ?? 0) / info.downloadTotalBytes) : null, receivedBytes: info.downloadedBytes ?? 0, totalBytes: info.downloadTotalBytes ?? null })
    if (!active && !this.task && !this.closing) { this.refreshCapabilities(); this.settle() }
  }
  private refreshCapabilities(): void {
    const passed = (id: string): boolean => this.state.checks?.find(check => check.id === id)?.status === 'passed'
    const failed = (capability: EnvironmentCapability): boolean => this.state.issues.some(issue => issue.severity !== 'warning' && issue.capability === capability)
    const runtime = this.runtime.getInfo(), media = passed('media-tools'), native = passed('native-components')
    const separation = runtime.status === 'ready' && media && !failed('separation')
    this.patch({ capabilities: { ...this.state.capabilities, media: media ? 'ready' : 'unavailable', recording: native && !failed('recording') ? 'ready' : 'unavailable', separation: separation ? 'ready' : 'unavailable', acceleration: separation && runtime.selectedDevice !== 'cpu' ? 'ready' : 'unavailable' } })
    if (!media && runtime.status === 'ready') this.setCheck({ id: 'separation-media', component: 'media', stage: '分轨输入解码与输出', level: 'launch', status: 'blocked', blockedBy: 'media-tools', detail: '计算环境可用，等待媒体工具恢复' })
    else if (media) this.setCheck({ id: 'separation-media', component: 'media', stage: '分轨输入解码与输出', level: 'launch', status: 'passed' })
  }
  private fail(issue: EnvironmentIssue): void {
    this.patch({ issues: [...this.state.issues.filter(item => !(item.capability === issue.capability && item.component === issue.component && item.stage === issue.stage)), issue] })
    this.journal.issues = this.state.issues.filter(item => item.severity !== 'warning')
  }
  private resolve(capability: EnvironmentCapability, component: EnvironmentComponent): void {
    for (const issue of this.state.issues.filter(issue => issue.capability === capability && (issue.component === component || !issue.component))) this.diagnostics.resolved(issue.diagnosticId)
    this.patch({ issues: this.state.issues.filter(issue => !(issue.capability === capability && (issue.component === component || !issue.component))) })
    this.journal.issues = this.state.issues.filter(issue => issue.severity !== 'warning')
  }
  async waitForIdle(signal: AbortSignal): Promise<void> {
    while (this.busy()) {
      signal.throwIfAborted()
      this.patch({ phase: 'waitingIdle', message: '录音或监听结束后继续准备', progress: null })
      await new Promise<void>(resolve => { const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }; const timer = setTimeout(done, 500); signal.addEventListener('abort', done, { once: true }) })
    }
    signal.throwIfAborted()
  }
  async startAutomatically(): Promise<void> {
    await this.loaded
    if (this.closing || this.journal.paused || this.state.safeMode || this.suppressAutomatic) return
    await this.prepare()
  }
  networkRestored(): Promise<void> {
    if (this.networkTask) return this.networkTask
    const task = (async () => {
      await this.loaded
      if (this.journal.paused || this.closing || this.state.safeMode || this.task) return
      const failed = [...new Set(this.state.issues.filter(issue => issue.code === 'NETWORK_UNAVAILABLE').map(issue => issue.capability))]
      let retry = false
      for (const capability of failed) {
        const signal = AbortSignal.timeout(50_000)
        const issue = this.journal.issues.find(item => item.capability === capability && item.code === 'NETWORK_UNAVAILABLE')
        const reachable = capability === 'media' ? await this.media.networkReachable?.(signal) : await this.runtime.networkReachable?.(signal, issue)
        if (reachable && !this.journal.reachable?.[capability]) { this.journal.attempts = this.journal.attempts.filter(key => key !== `prepare:${capability}`); retry = true }
        ;(this.journal.reachable ??= {})[capability] = reachable === true
      }
      await this.persist()
      if (retry) await this.startAutomatically()
    })().finally(() => { if (this.networkTask === task) this.networkTask = null })
    this.networkTask = task; return task
  }
  private target(id?: string): Partial<Operation> {
    if (!id) return {}
    const issue = this.state.issues.find(item => item.diagnosticId === id)
    if (!issue) throw new Error('DIAGNOSTIC_ISSUE_NOT_ACTIVE')
    return { capability: issue.capability, component: issue.component }
  }
  check(id?: string): Promise<EnvironmentState> { return this.schedule({ mode: 'check', ...this.target(id) }) }
  prepare(): Promise<EnvironmentState> { return this.schedule({ mode: 'prepare' }) }
  repair(id?: string): Promise<EnvironmentState> { return this.schedule({ mode: 'repair', explicit: true, ...this.target(id) }) }
  resume(): Promise<EnvironmentState> { return this.schedule({ mode: 'prepare', explicit: true }) }
  private schedule(operation: Operation): Promise<EnvironmentState> {
    if (this.task) return this.task
    const task = this.run(operation).finally(() => { if (this.task === task) this.task = null })
    this.task = task; return task
  }
  private async run(operation: Operation): Promise<EnvironmentState> {
    await this.loaded
    if (this.closing) return this.get()
    if (operation.explicit) {
      this.journal.paused = false
      const scope = operation.capability ? [operation.capability] : this.journal.issues.map(issue => issue.capability)
      this.journal.attempts = this.journal.attempts.filter(key => !scope.some(cap => key === `prepare:${cap}` || key.startsWith(`fault:${cap}:`)))
      if (!operation.capability || ['recording', 'separation'].includes(operation.capability)) this.runtime.allowSystemInstallerRetry?.()
      this.patch({ pausedByUser: false })
    }
    if (this.journal.paused && operation.mode !== 'check') return this.get()
    this.controller = new AbortController(); const signal = this.controller.signal
    const wanted = (capability: EnvironmentCapability): boolean => !operation.capability || operation.capability === capability
    try {
      this.patch({ phase: 'checking', message: '正在检查可用功能', progress: null })
      await this.waitForIdle(signal)
      if (wanted('media')) await this.component('media', 'media', 'media-tools', 'integrity', async () => {
        if (this.media.healthCheck) await this.media.healthCheck(signal, operation.mode === 'check' || !!operation.explicit)
        else { await this.media.ready(); if (!await this.media.toolsReady()) throw new Error('FFMPEG_MISSING') }
      }, () => this.media.repair(signal), operation, signal)
      if ((wanted('recording') && operation.component !== 'audio-device') || wanted('separation')) {
        await this.component('recording', 'system-runtime', 'native-components', 'launch', () => this.runtime.verifyNativePrerequisites(signal, false), () => this.runtime.verifyNativePrerequisites(signal, true), operation, signal)
      }
      if (wanted('recording') && this.options.inspectAudio) {
        if (this.state.checks?.find(check => check.id === 'native-components')?.status === 'passed') {
          const audio = await this.options.inspectAudio(signal)
          // Enumeration cannot clear a failure from actually opening a device stream.
          this.patch({ issues: this.state.issues.filter(issue => issue.component !== 'audio-device' || issue.stage === '音频采集与监听') })
          audio.checks.forEach(check => this.setCheck(check)); audio.issues.forEach(issue => this.fail(issue))
        } else this.setCheck({ id: 'audio-device', component: 'audio-device', stage: '音频设备配置', status: 'blocked', blockedBy: 'native-components', level: 'inventory' })
      }
      if (wanted('separation') || wanted('acceleration')) {
        const blocker = this.state.issues.find(issue => issue.capability === 'recording' && /SYSTEM_|AUTHORIZATION|RESTART|SIGNATURE/.test(issue.code))
        if (blocker) {
          this.fail({ ...blocker, capability: 'separation', affectedCapabilities: ['recording', 'separation'] })
          this.setCheck({ id: 'runtime', component: 'dependencies', stage: '分轨环境', status: 'blocked', blockedBy: 'system-runtime', level: 'imports', diagnosticId: blocker.diagnosticId })
        } else {
          this.resolve('separation', 'system-runtime')
          await this.component('separation', 'dependencies', 'runtime', 'inference', async () => {
            const info = await this.runtime.detect(); signal.throwIfAborted()
            if (info.status !== 'ready' || info.error) throw new DiagnosticError(info.issue?.code ?? 'RUNTIME_MISSING', info.error ?? '分轨环境尚未通过验证', { stage: info.stage }, info.issue?.evidence)
          }, async () => {
            const info = await this.runtime.repair(operation.forceCpu); signal.throwIfAborted()
            if (info.status !== 'ready' || info.error) throw new DiagnosticError(info.issue?.code ?? 'RUNTIME_COMPONENT_FAILED', info.error ?? '组件准备未完成', { stage: info.stage }, info.issue?.evidence)
          }, operation, signal)
        }
      }
    } catch (error) {
      if (!signal.aborted && !this.closing) this.fail(this.diagnostics.report(error, operation.capability ?? 'separation', { stage: this.state.message }))
    } finally {
      this.journal.pending = undefined; this.journal.configuration = this.runtime.recoveryKey?.()
      this.refreshCapabilities(); this.settle(); await this.persist()
    }
    return this.get()
  }
  private async component(capability: EnvironmentCapability, component: EnvironmentComponent, id: string, level: EnvironmentCheck['level'], inspect: () => Promise<void>, repair: () => Promise<void>, operation: Operation, signal: AbortSignal): Promise<void> {
    const diagnosticId = this.state.issues.find(issue => issue.capability === capability && (issue.component === component || !issue.component))?.diagnosticId ?? randomUUID()
    return this.diagnostics.withScope({ diagnosticId }, async () => {
    await this.waitForIdle(signal)
    const key = `prepare:${capability}`
    let previous = this.state.issues.find(issue => issue.capability === capability && (issue.component === component || !issue.component))
    const pass = (): void => {
      this.resolve(capability, component)
      this.setCheck({ id, component, stage: id, status: 'passed', level, checkedAt: new Date().toISOString() })
      this.journal.attempts = this.journal.attempts.filter(attempt => attempt !== key)
      if (previous) this.diagnostics.attempted(previous.diagnosticId, '重新检测', '通过')
    }
    let failure: unknown
    try {
      await inspect(); signal.throwIfAborted()
      if (!(capability === 'separation' && operation.mode === 'repair')) { pass(); return }
    } catch (error) { signal.throwIfAborted(); failure = error }
    let issue = failure ? environmentIssue(failure, capability, { component, stage: id }) : previous
    // Preserve authorization/reboot state until validation passes or the user explicitly retries.
    if (previous && failure && !operation.explicit && (requiresAction.has(previous.code) || /PYTHON_MISSING|RUNTIME_MISSING/.test(evidenceText(failure)))) issue = previous
    const configuration = this.runtime.recoveryKey?.()
    if (capability === 'separation' && configuration && this.journal.configuration && configuration !== this.journal.configuration && (!issue || !requiresAction.has(issue.code))) {
      this.journal.attempts = this.journal.attempts.filter(attempt => attempt !== key && !attempt.startsWith('fault:separation:'))
    }
    const allowed = operation.mode !== 'check' && !this.journal.attempts.includes(key) && (!issue || operation.explicit || !requiresAction.has(issue.code))
    if (allowed) {
      this.journal.attempts.push(key); this.journal.pending = id; await this.persist()
      if (issue) { previous = this.diagnostics.report(failure, capability, { component, stage: id, attempts: previous?.attempts }); this.diagnostics.attempted(previous.diagnosticId, '定向修复', '开始') }
      try {
        await repair(); signal.throwIfAborted(); await inspect(); signal.throwIfAborted()
        if (previous) this.diagnostics.attempted(previous.diagnosticId, '定向修复并复检', '通过')
        pass(); return
      } catch (error) { signal.throwIfAborted(); failure = error; if (previous) this.diagnostics.attempted(previous.diagnosticId, '定向修复并复检', errorEvidence(error).code) }
    }
    issue = this.diagnostics.report(issue === previous && previous?.evidence ? previous.evidence : failure ?? new Error('AUTOMATIC_REPAIR_EXHAUSTED'), capability, { component, stage: id,
      attempts: this.diagnostics.getIssue(previous?.diagnosticId)?.attempts ?? previous?.attempts ?? [], ...(previous?.diagnosticId ? { diagnosticId: previous.diagnosticId } : {}) })
    if (operation.mode !== 'check' && !this.journal.attempts.includes(key)) this.journal.attempts.push(key)
    this.fail(issue)
    this.setCheck({ id, component, stage: id, status: 'failed', level, checkedAt: new Date().toISOString(), diagnosticId: issue.diagnosticId })
    this.logger.warn('environment check stopped', { capability, component, diagnosticId: issue.diagnosticId, code: issue.code })
    })
  }
  private settle(): void {
    if (this.journal.paused) { this.patch({ phase: 'paused', message: '准备已暂停，下载进度已保留', progress: null }); return }
    const failures = this.state.issues.filter(issue => issue.severity !== 'warning')
    const issue = failures.find(issue => issue.code !== 'NETWORK_UNAVAILABLE') ?? failures[0]
    if (issue) { this.patch({ phase: issue.code === 'NETWORK_UNAVAILABLE' ? 'waitingNetwork' : 'needsAction', message: issue.message, progress: null }); return }
    const ready = ['media', 'recording', 'separation'].every(key => this.state.capabilities[key as EnvironmentCapability] === 'ready')
    this.patch({ phase: ready ? 'ready' : 'needsAction', message: ready ? '组件已就绪；实际音频设备将在使用时验证' : '部分组件尚未就绪，可以继续准备。', progress: ready ? 1 : null })
  }
  async pause(): Promise<EnvironmentState> {
    await this.loaded; this.journal.paused = true
    this.controller.abort(); this.runtime.cancelInstall(); this.patch({ pausedByUser: true }); this.settle()
    await this.persist(); await this.task; return this.get()
  }
  reportAudioFailure(error: unknown): void {
    this.fail(this.diagnostics.report(error, 'recording', { component: 'audio-device', stage: '音频采集与监听' }))
    this.setCheck({ id: 'audio-stream', component: 'audio-device', stage: '实际设备流', level: 'stream', status: 'failed', checkedAt: new Date().toISOString() })
    this.refreshCapabilities(); this.settle(); void this.persist()
  }
  reportAudioSuccess(detail: string): void {
    this.resolve('recording', 'audio-device')
    this.setCheck({ id: 'audio-stream', component: 'audio-device', stage: '实际设备流', level: 'stream', status: 'passed', checkedAt: new Date().toISOString(), detail })
    this.refreshCapabilities(); this.settle(); void this.persist()
  }
  async suspend(): Promise<void> { this.controller.abort(new DiagnosticError('SYSTEM_SUSPEND', '系统休眠或采集开始，准备已中断')); this.runtime.cancelInstall(); await this.task }
  deferForLiveAudio(): void {
    if (!this.task || this.deferring || this.journal.paused) return
    this.deferring = this.suspend().then(() => this.startAutomatically()).finally(() => { this.deferring = null })
    void this.deferring.catch(error => this.logger.warn('background preparation deferred', error))
  }
  async configurationChanged(rootsChanged: boolean): Promise<void> {
    await this.loaded
    if (this.journal.paused || this.state.safeMode || this.closing) return
    const configuration = this.runtime.recoveryKey?.()
    if (configuration && configuration === this.journal.configuration) return
    await this.suspend()
    const retry = this.journal.issues.filter(issue => issue.action === 'network' || (rootsChanged && issue.action === 'storage') || issue.capability === 'separation' && !requiresAction.has(issue.code)).map(issue => `prepare:${issue.capability}`)
    this.journal.attempts = this.journal.attempts.filter(key => !retry.includes(key) && !key.startsWith('fault:separation:')); this.journal.reachable = {}
    await this.persist(); await this.startAutomatically()
  }
  diagnosticReport(scope?: DiagnosticScope): ReturnType<DiagnosticStore['snapshot']> { return this.diagnostics.snapshot(scope) }
  async exportDiagnostics(destination: string, scope?: DiagnosticScope): Promise<void> {
    await this.logger.flush()
    const runtime = this.runtime.getInfo(); registerDiagnosticRoots([runtime.runtimePath, runtime.modelPath])
    await this.diagnostics.export(destination, scope, { environment: this.get(), runtime, recovery: this.journal, downloads: [...this.runtime.downloadDiagnostics(), ...this.media.downloadDiagnostics()] })
  }
  async shutdown(): Promise<void> { this.closing = true; this.controller.abort(); this.runtime.cancelInstall(); await this.task; await this.networkTask; await this.saving; await this.diagnostics.flush(); this.unsubscribe() }
}

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { EnvironmentCapability, EnvironmentIssue, EnvironmentState } from '@shared/environment.js'
import type { RuntimeInfo } from '@shared/domain.js'
import { writeJsonAtomic } from './artifact-download.js'
import type { RuntimeManager } from './runtime.js'
import type { MediaService } from './media.js'
import type { Logger } from './logger.js'
import type { AppPaths } from './paths.js'

export function environmentIssue(error: unknown, capability: EnvironmentCapability = 'separation'): EnvironmentIssue {
  const text = String(error)
  const issue = (code: string, message: string, action: EnvironmentIssue['action']): EnvironmentIssue => ({ code, message, action, capability })
  if (/DISK_FULL|ENOSPC|NO SPACE/i.test(text)) return issue('DISK_FULL', '磁盘空间不足，请选择有足够空间的位置。已有数据已保留。', 'storage')
  if (/spawn.*(?:EACCES|EPERM)|EXECUTION_BLOCKED|ACCESS_DISABLED_BY_POLICY/i.test(text)) return issue('EXECUTION_BLOCKED', '系统阻止了组件运行，请查看系统安全记录或联系设备管理员。', 'security')
  if (/EACCES|EPERM|EROFS|ENOENT.*(?:directory|目录)/i.test(text)) return issue('STORAGE_UNAVAILABLE', '组件目录无法读写，请检查磁盘连接或选择新的位置。', 'storage')
  if (/MICROPHONE_PERMISSION/.test(text)) return issue('MICROPHONE_PERMISSION', '请在系统设置中允许 BandBuddy 访问麦克风。', 'microphone')
  if (/UNSUPPORTED_SYSTEM:darwin-arm64:14/.test(text)) return issue('UNSUPPORTED_SYSTEM', '本地分轨需要 macOS 14 或更新版本，其他已就绪功能仍可使用。', 'repairApplication')
  if (/VC_RUNTIME_RESTART_REQUIRED/.test(text)) return issue('RESTART_REQUIRED', '系统组件已更新，请重启电脑后继续。', 'restart')
  if (/VC_RUNTIME_ELEVATION_CANCELLED/.test(text)) return issue('AUTHORIZATION_REQUIRED', '系统组件尚未安装，继续准备时需要确认系统授权。', 'retry')
  if (/VC_RUNTIME_INSTALL_FAILED|VC_RUNTIME_SELF_TEST_FAILED/.test(text)) return issue('SYSTEM_RUNTIME_FAILED', '系统组件安装未完成，请重试修复或使用同版本安装包修复。', 'repairApplication')
  if (/CERT_DATE_INVALID|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|CLOCK_SKEW/i.test(text)) return issue('CERTIFICATE_TIME_INVALID', '证书时间校验未通过，请检查系统日期与时间；如果日期正确，请检查网络证书。', 'time')
  if (/CERT|SSL|TLS|SIGNATURE/i.test(text)) return issue('TRUST_CHECK_FAILED', '安全校验未通过，请检查网络证书或系统安全记录。', 'security')
  if (/HASH_MISMATCH|UNEXPECTED_HTML|TOO_LARGE|MANIFEST_INVALID|CATALOG_INVALID/.test(text)) return issue('DOWNLOAD_INTEGRITY_FAILED', '下载的组件未通过完整性校验，已停止使用。请检查网络后重试。', 'network')
  if (/DOWNLOAD|NETWORK|ENOTFOUND|ECONN|ETIMEDOUT|ERR_PROXY|PROXY_|fetch failed/i.test(text)) return issue('NETWORK_UNAVAILABLE', '下载已暂停，恢复网络后将继续；已下载的内容会保留。', 'network')
  if (/APPLICATION_COMPONENT_MISSING|RUNTIME_PROFILE_MISSING|SYSTEM_HELPER_MISSING|AUDIO_HOST_MISSING|UNSUPPORTED_TOOL|ABI|NODE_MODULE_VERSION/.test(text)) return issue('APPLICATION_COMPONENT_MISSING', '此版本的组件不完整或不适合这台电脑，请使用官方修复安装。', 'repairApplication')
  if (/ILLEGAL_INSTRUCTION|3221225501|-1073741795|UNSUPPORTED_CPU|UNSUPPORTED_SYSTEM/.test(text)) return issue('UNSUPPORTED_HARDWARE', '这台电脑暂不满足此功能的运行要求，其他已就绪功能仍可使用。', 'repairApplication')
  if (/DEVICE_CHANGED/.test(text)) return issue('AUDIO_DEVICE_CHANGED', '音频设备发生变化，监听和录音已停止。请检查所选设备后手动开始。', 'audio')
  if (/AUDIO_HOST|DEVICE_|AUDIO_DRIVER|NO_COMMON_SAMPLE_RATE/.test(text)) return issue('AUDIO_UNAVAILABLE', '音频设备未就绪，请检查所选设备、连接和占用情况。', 'audio')
  return issue('COMPONENT_FAILED', '组件准备未完成。可以重试修复，或导出诊断信息。', 'repair')
}

export function redactDiagnostics(value: unknown, privateRoots: string[] = []): string {
  const roots = [os.homedir(), ...privateRoots].filter(Boolean).sort((a, b) => b.length - a.length)
  return JSON.stringify(value, (key, nested: unknown) => {
    if (/password|token|secret|authorization|proxyUrl/i.test(key)) return '<redacted>'
    if (typeof nested !== 'string') return nested
    let text = nested
    for (const root of roots) text = text.split(root).join('<local-path>').split(root.replaceAll('\\', '/')).join('<local-path>')
    return text.replace(/https?:[^\s"<>]+/gi, raw => {
      try { const url = new URL(raw); return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}/<redacted>` } catch { return '<url>' }
    }).replace(/((?:password|token|secret|authorization)["'\s]*[:=]["'\s]*)[^,\s"'}]+/gi, '$1<redacted>')
  }, 2)
}

interface Journal { schema: 1; version: string; paused: boolean; attempts: string[]; issues: EnvironmentIssue[]; pending?: string; downloads?: unknown[]; events?: Array<{ at: string; capability: EnvironmentCapability; result: string }> }
export class EnvironmentManager {
  private readonly file: string
  private journal: Journal
  private task: Promise<EnvironmentState> | null = null
  private closing = false
  private forceRepair = false
  private forceCpu = false
  private deferring: Promise<void> | null = null
  private state: EnvironmentState
  private saving = Promise.resolve()
  private controller = new AbortController()
  private listeners = new Set<(state: EnvironmentState) => void>()
  private readonly unsubscribe: () => void
  private readonly loaded: Promise<void>
  constructor(private readonly paths: AppPaths, private readonly runtime: RuntimeManager, private readonly media: MediaService, private readonly logger: Logger, private readonly version: string, private readonly busy: () => boolean, safeMode = false, private readonly suppressAutomatic = false) {
    this.file = path.join(paths.localRoot, 'environment-state.json')
    this.journal = { schema: 1, version, paused: false, attempts: [], issues: [] }
    this.state = { phase: 'checking', message: '正在检查可用功能', progress: null, receivedBytes: 0, totalBytes: null, pausedByUser: false, safeMode, capabilities: { startup: 'ready', media: 'unchecked', recording: 'unchecked', separation: 'unchecked', acceleration: 'unchecked' }, issues: [] }
    this.loaded = this.load()
    this.unsubscribe = runtime.onChange(info => this.runtimeChanged(info))
    runtime.setPreparationGate(signal => this.waitForIdle(signal))
    runtime.setFaultRecovery(async cpu => {
      await this.loaded
      if (this.journal.paused || this.closing || this.state.safeMode) return false
      const attempt = `fault:separation:${cpu ? 'cpu' : 'repair'}`
      if (this.journal.attempts.includes(attempt)) return false
      await this.task
      this.journal.attempts.push(attempt); await this.persist()
      this.forceRepair = true; this.forceCpu = cpu
      await this.prepare()
      return this.state.capabilities.separation === 'ready' && !this.state.issues.some(issue => issue.capability === 'separation')
    })
  }
  private async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as Journal
      if (data.schema === 1) this.journal = { schema: 1, version: this.version, paused: data.paused === true, attempts: data.version === this.version && Array.isArray(data.attempts) ? data.attempts.filter(v => typeof v === 'string') : [], issues: data.version === this.version && Array.isArray(data.issues) ? data.issues.filter(issue => issue && typeof issue.code === 'string' && typeof issue.message === 'string' && ['media', 'recording', 'separation'].includes(issue.capability)) : [] }
      // An interrupted system installer must not trigger another UAC prompt.
      if (data.pending === 'recording') {
        this.journal.attempts.push('prepare:recording')
        this.journal.issues.push(environmentIssue('VC_RUNTIME_ELEVATION_CANCELLED', 'recording'))
      }
      this.journal.downloads = Array.isArray(data.downloads) ? data.downloads.slice(-300) : []
      this.journal.events = Array.isArray(data.events) ? data.events.slice(-60) : []
    } catch { /* First run, or a torn journal: never touch user content. */ }
    if (this.journal.paused || this.state.safeMode) this.patch({ phase: 'paused', pausedByUser: this.journal.paused, message: this.state.safeMode ? '兼容启动已暂停自动准备' : '准备已暂停，下载进度已保留' })
    else for (const issue of this.journal.issues) this.fail(issue)
  }
  private persist(): Promise<void> {
    const snapshot = structuredClone(this.journal)
    this.saving = this.saving.catch(() => {}).then(() => writeJsonAtomic(this.file, snapshot))
    return this.saving
  }
  get(): EnvironmentState { return structuredClone(this.state) }
  isBusy(): boolean { return this.task !== null }
  onChanged(listener: (state: EnvironmentState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private patch(patch: Partial<EnvironmentState>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(this.get()) }
  private runtimeChanged(info: RuntimeInfo): void {
    const capabilities = { ...this.state.capabilities, separation: info.status === 'ready' ? 'ready' as const : 'unavailable' as const, acceleration: info.status === 'ready' && info.selectedDevice !== 'cpu' ? 'ready' as const : 'unavailable' as const }
    const active = ['installing', 'downloadingModel', 'verifying', 'detecting'].includes(info.status)
    this.patch({ capabilities, ...(active && !this.journal.paused && !this.closing ? { phase: 'preparing' as const, message: info.status === 'verifying' ? '正在检查组件能否正常工作' : info.status === 'detecting' ? '正在检查可用功能' : '正在准备所需组件', progress: info.downloadTotalBytes ? Math.min(1, (info.downloadedBytes ?? 0) / info.downloadTotalBytes) : null, receivedBytes: info.downloadedBytes ?? 0, totalBytes: info.downloadTotalBytes ?? null } : {}) })
    if (!active && !this.task && !this.closing && !this.state.safeMode) this.settle()
  }
  private fail(issue: EnvironmentIssue): void {
    this.patch({ phase: issue.code === 'NETWORK_UNAVAILABLE' ? 'waitingNetwork' : 'needsAction', message: issue.message, progress: null, issues: [...this.state.issues.filter(item => item.capability !== issue.capability), issue] })
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
  async networkRestored(): Promise<void> {
    await this.loaded
    if (!this.state.issues.some(issue => issue.code === 'NETWORK_UNAVAILABLE') || this.journal.paused || this.closing) return
    // A new connectivity event permits one fresh bounded download round.
    const failedNetwork = this.journal.issues.filter(issue => issue.code === 'NETWORK_UNAVAILABLE').map(issue => `prepare:${issue.capability}`)
    this.journal.attempts = this.journal.attempts.filter(key => !failedNetwork.includes(key))
    await this.persist(); await this.startAutomatically()
  }
  async check(): Promise<EnvironmentState> {
    await this.loaded
    if (this.task) return this.task
    await this.waitForIdle(this.controller.signal)
    try {
      this.runtimeChanged(await this.runtime.detect())
      await this.media.ready()
      this.patch({ capabilities: { ...this.state.capabilities, media: await this.media.toolsReady() ? 'ready' : 'unavailable' } })
    } catch (error) { this.fail(environmentIssue(error)) }
    this.settle()
    return this.get()
  }
  prepare(): Promise<EnvironmentState> {
    if (this.task) return this.task
    const task = this.run().finally(() => { if (this.task === task) this.task = null })
    this.task = task; return task
  }
  private async run(): Promise<EnvironmentState> {
    await this.loaded
    if (this.closing || this.journal.paused) return this.get()
    this.controller = new AbortController()
    const signal = this.controller.signal
    try {
      this.patch({ phase: 'checking', message: '正在检查可用功能', issues: [], progress: null })
      await this.waitForIdle(signal)
      await this.component('media', async () => {
        await this.media.ready()
        if (!await this.media.toolsReady()) {
          await this.media.repair(signal)
          if (!await this.media.toolsReady()) throw new Error('FFMPEG_MISSING')
        }
      }, signal)
      await this.component('recording', () => this.runtime.verifyNativePrerequisites(signal), signal)
      const systemIssue = this.state.issues.find(issue => issue.capability === 'recording' && ['AUTHORIZATION_REQUIRED', 'RESTART_REQUIRED', 'SYSTEM_RUNTIME_FAILED'].includes(issue.code))
      if (systemIssue) this.fail({ ...systemIssue, capability: 'separation' })
      else await this.component('separation', async () => {
        const existing = await this.runtime.detect()
        signal.throwIfAborted()
        if (existing.status !== 'ready' || this.forceRepair) {
          const installed = await this.runtime.repair(this.forceCpu)
          signal.throwIfAborted()
          if (installed.status !== 'ready' || installed.error) throw new Error(installed.error ?? 'COMPONENT_PREPARATION_FAILED')
        }
      }, signal)
      this.settle()
    } catch (error) {
      if (signal.aborted || this.journal.paused || this.closing) return this.get()
      this.fail(environmentIssue(error))
    } finally {
      this.forceRepair = false
      this.forceCpu = false
      this.journal.pending = undefined
      await this.persist().catch(error => { if (!this.closing && !this.journal.paused) this.fail(environmentIssue(error)) })
    }
    return this.get()
  }
  private settle(): void {
    if (this.journal.paused) { this.patch({ phase: 'paused', message: '准备已暂停，下载进度已保留', progress: null }); return }
    if (this.state.issues.length) { this.fail(this.state.issues.find(issue => issue.code !== 'NETWORK_UNAVAILABLE') ?? this.state.issues[0]!); return }
    const ready = ['media', 'recording', 'separation'].every(key => this.state.capabilities[key as EnvironmentCapability] === 'ready')
    if (ready) this.patch({ phase: 'ready', message: '已就绪', progress: 1 })
    else this.patch({ phase: 'needsAction', message: '部分组件尚未就绪，可以继续准备。', progress: null })
  }
  private async component(capability: EnvironmentCapability, work: () => Promise<void>, signal: AbortSignal): Promise<void> {
    await this.waitForIdle(signal)
    const attempt = `prepare:${capability}`
    if (this.journal.attempts.includes(attempt)) {
      this.fail(this.journal.issues.find(issue => issue.capability === capability) ?? environmentIssue('AUTOMATIC_REPAIR_EXHAUSTED', capability)); return
    }
    try {
      this.journal.pending = capability; await this.persist()
      await work(); signal.throwIfAborted()
      this.journal.issues = this.journal.issues.filter(issue => issue.capability !== capability)
      this.patch({ capabilities: { ...this.state.capabilities, [capability]: 'ready' }, issues: this.state.issues.filter(issue => issue.capability !== capability) })
    } catch (error) {
      if (signal.aborted) throw error
      const issue = environmentIssue(error, capability)
      this.journal.attempts.push(attempt)
      this.journal.issues = [...this.journal.issues.filter(item => item.capability !== capability), issue]
      this.patch({ capabilities: { ...this.state.capabilities, [capability]: capability === 'separation' && this.runtime.getInfo().status === 'ready' ? 'ready' : 'unavailable' } })
      this.fail(issue); this.logger.warn('environment preparation stopped', { capability, code: issue.code })
    } finally {
      this.journal.pending = undefined
      this.journal.events = [...(this.journal.events ?? []), { at: new Date().toISOString(), capability, result: signal.aborted ? 'interrupted' : this.state.issues.find(issue => issue.capability === capability)?.code ?? 'ready' }].slice(-60)
      this.journal.downloads = [...(this.journal.downloads ?? []), ...this.runtime.downloadDiagnostics(), ...this.media.downloadDiagnostics()].slice(-300)
      await this.persist()
    }
  }
  async pause(): Promise<EnvironmentState> {
    await this.loaded; this.journal.paused = true
    this.controller.abort(); this.runtime.cancelInstall()
    this.patch({ phase: 'paused', pausedByUser: true, message: '准备已暂停，下载进度已保留', progress: null })
    await this.persist(); await this.task; return this.get()
  }
  async resume(): Promise<EnvironmentState> {
    await this.loaded; await this.task
    this.journal.paused = false; this.journal.attempts = []; this.journal.issues = []
    this.patch({ pausedByUser: false }); await this.persist(); return this.prepare()
  }
  async repair(): Promise<EnvironmentState> { await this.task; this.forceRepair = true; return this.resume() }
  reportAudioFailure(error: unknown): void { this.patch({ capabilities: { ...this.state.capabilities, recording: 'unavailable' } }); this.fail(environmentIssue(error, 'recording')) }
  async suspend(): Promise<void> { this.controller.abort(); this.runtime.cancelInstall(); await this.task }
  deferForLiveAudio(): void {
    if (!this.task || this.deferring || this.journal.paused) return
    this.deferring = this.suspend().then(() => this.startAutomatically()).finally(() => { this.deferring = null })
    void this.deferring.catch(error => this.logger.warn('background preparation deferred', error))
  }
  async configurationChanged(rootsChanged: boolean): Promise<void> {
    await this.loaded
    if (this.journal.paused || this.state.safeMode || this.closing) return
    // Stop the round using the old proxy/paths before reading the saved settings.
    await this.suspend()
    const retry = this.journal.issues.filter(issue => issue.capability === 'separation' || issue.action === 'network'
      || issue.code === 'TRUST_CHECK_FAILED' || (rootsChanged && issue.action === 'storage')).map(issue => `prepare:${issue.capability}`)
    this.journal.attempts = this.journal.attempts.filter(attempt => !retry.includes(attempt))
    await this.persist()
    await this.startAutomatically()
  }
  async exportDiagnostics(destination: string): Promise<void> {
    await this.logger.flush()
    const runtime = this.runtime.getInfo()
    await writeFile(destination, redactDiagnostics({ schema: 1, applicationVersion: this.version, platform: process.platform, arch: process.arch, os: os.release(), environment: this.get(), runtime, recovery: this.journal, downloads: this.runtime.downloadDiagnostics() }, [this.paths.localRoot, this.paths.dataRoot, runtime.runtimePath, runtime.modelPath]), 'utf8')
  }
  async shutdown(): Promise<void> { this.closing = true; this.controller.abort(); this.runtime.cancelInstall(); await this.task; await this.saving; this.unsubscribe() }
}

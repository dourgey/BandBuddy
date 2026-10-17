import { existsSync } from 'node:fs'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { RecordingDeviceInfo, RecordingAudioSettings } from '@shared/domain.js'
import type { Logger } from './logger.js'
import type { AppPaths } from './paths.js'
import { spawnSafe } from './process.js'
import { DiagnosticError, errorEvidence } from './diagnostic-errors.js'
import { diagnostics } from './diagnostics.js'
import type { EnvironmentCheck, EnvironmentIssue } from '@shared/environment.js'
import { AudioPluginService } from './audio-plugins.js'
import type { PreparedEffects } from '@shared/arsenal.js'
import type { NativeAudioState } from '@shared/native-audio.js'

export interface AudioHostStartResult {
  inputSampleRate?: number
  sampleRate: number
  bufferFrames: number
  latencyMs: number
  splitDevices: boolean
  streamingBacking?: boolean
  backingBufferFrames?: number
}

export interface AudioHostStopResult {
  outputSampleRate?: number
  pluginFaults?: import('@shared/audio-plugins.js').PluginFaults | null
  diagnostics?: import('@shared/audio-plugins.js').AudioDiagnostics
  frames: number
  sampleRate: number
  channels: number
  xruns: number
  durationMs: number
  outputFrames?: number
  correctionOutputFrames?: number
  clockCorrectionRatio?: number
  inputStartOutputFrames?: number
  outputTransportStartNs?: number
  inputCaptureStartNs?: number
  outputTransportEndNs?: number
}

export interface AudioHostMeterEvent {
  diagnostics?: import('@shared/audio-plugins.js').AudioDiagnostics
  clock?: import('@shared/audio-plugins.js').ClockDiagnostics
  plugin?: import('@shared/audio-plugins.js').PluginDiagnostics | null
  pcmUnderruns?: number
  timeline?: NativeAudioState | null
  tunerActive?: boolean
  tunerHz?: number
  dspLoad?: number
  dspLatencyMs?: number
  outputPeak?: number
  peak: number[]
  rms: number[]
  clipped: boolean
  sourcePositionMs: number
  countInRemaining: number
  recording: boolean
  paused: boolean
  captureFrames?: number
  xruns: number
}

export type AudioHostEvent =
  | { event: 'opened'; data: AudioHostStartResult }
  | { event: 'meter'; data: AudioHostMeterEvent }
  | { event: 'finished'; data: AudioHostStopResult }
  | { event: 'crashed'; data: { error: string; evidence?: unknown } }
  | { event: 'error'; data: { error: string; evidence?: unknown; capture: AudioHostStopResult | null } }

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface RpcMessage {
  id?: number
  ok?: boolean
  result?: unknown
  error?: string
  evidence?: unknown
  event?: AudioHostEvent['event']
  data?: unknown
}

export class AudioHostClient {
  readonly plugins: AudioPluginService
  private liveSession = false
  private outputOnly = false
  private testSession = false
  private sessionRate = 48000
  private timelineGraph: Record<string, unknown> | null = null
  private timelineState: NativeAudioState | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  private nativeCapabilities: Promise<void> | null = null
  private sequence = 0
  private readonly pending = new Map<number, PendingRequest>()
  private readonly listeners = new Set<(event: AudioHostEvent) => void>()
  private expectedExit = false
  private deviceSnapshot: RecordingDeviceInfo[] = []
  private probeResults: Array<{ backend: string; error?: unknown; count?: number; warnings?: string[] }> = []
  private stderrEvidence: string[] = []

  constructor(private readonly paths: AppPaths, private readonly logger: Logger, private readonly probeBackend = '') {
    this.plugins = new AudioPluginService(paths, () => this.liveSession)
  }

  onEvent(listener: (event: AudioHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async devices(): Promise<RecordingDeviceInfo[]> {
    // Driver enumeration must not block or terminate a live recording process.
    const backends = process.platform === 'win32' ? ['wasapi', 'asio'] : ['coreaudio']
    const results = await Promise.allSettled(backends.map(async backend => {
      const probe = new AudioHostClient(this.paths, this.logger, backend)
      try { const devices = await probe.request<RecordingDeviceInfo[]>('devices', { backend }, 15_000); return { devices, warnings: probe.stderrEvidence } }
      finally { await probe.shutdown() }
    }))
    const devices: RecordingDeviceInfo[] = []
    this.probeResults = []
    for (const [index, result] of results.entries()) {
      const backend = backends[index]!
      if (result.status === 'fulfilled') { devices.push(...result.value.devices); this.probeResults.push({ backend, count: result.value.devices.length, warnings: result.value.warnings }) }
      else { this.probeResults.push({ backend, error: errorEvidence(result.reason) }); this.logger.warn('audio device probe failed', { backend, error: errorEvidence(result.reason) }) }
      diagnostics.record({ component: 'audio-device', stage: `enumerate:${backend}`, result: result.status, details: this.probeResults.at(-1) })
    }
    if (results.every(result => result.status === 'rejected')) throw new DiagnosticError('AUDIO_DRIVER_PROBE_FAILED', '所有音频后端探测失败', { backends: this.probeResults })
    this.deviceSnapshot = [...new Map(devices.map(device => [device.id, device])).values()]
    return this.deviceSnapshot
  }

  async inspect(settings: RecordingAudioSettings, signal: AbortSignal): Promise<{ checks: EnvironmentCheck[]; issues: EnvironmentIssue[] }> {
    signal.throwIfAborted()
    const issues: EnvironmentIssue[] = []
    let devices: RecordingDeviceInfo[] = []
    try { devices = await this.devices() } catch { /* Individual backend evidence is retained below. */ }
    signal.throwIfAborted()
    const backend = settings.backend === 'auto' ? process.platform === 'darwin' ? 'coreaudio' : 'wasapi-shared' : settings.backend
    const selectedProbe = backend.startsWith('wasapi') ? 'wasapi' : backend
    const checks: EnvironmentCheck[] = this.probeResults.map(result => ({ id: `audio-enumerate:${result.backend}`, component: 'audio-device', stage: `${result.backend} 设备枚举`, level: 'inventory', status: result.error ? 'failed' : 'passed', checkedAt: new Date().toISOString(), detail: result.error ? '后端探测未通过' : `${result.count} 个设备` }))
    for (const result of this.probeResults.filter(result => result.error)) issues.push(diagnostics.report(new DiagnosticError('AUDIO_DRIVER_PROBE_FAILED', `${result.backend} 后端探测失败`, { backend: result.backend }, result.error), 'recording', { component: 'audio-device', stage: `${result.backend} 设备枚举`, severity: result.backend === selectedProbe ? 'error' : 'warning' }))
    const input = devices.find(device => device.backend === backend && device.inputChannels > 0 && (settings.inputDeviceId ? device.id === settings.inputDeviceId : device.defaultInput))
    const output = devices.find(device => device.backend === backend && device.outputChannels > 0 && (settings.outputDeviceId ? device.id === settings.outputDeviceId : device.defaultOutput))
    let code: string | null = !input ? settings.inputDeviceId ? 'SELECTED_INPUT_DEVICE_MISSING' : 'NO_AUDIO_INPUT_DEVICE' : !output ? settings.outputDeviceId ? 'SELECTED_OUTPUT_DEVICE_MISSING' : 'NO_AUDIO_OUTPUT_DEVICE' : null
    if (input && output) {
      const independent = backend.startsWith('wasapi') || input.id !== output.id
      const rates = independent ? output.sampleRates : input.sampleRates.filter(rate => output.sampleRates.includes(rate))
      if (input.sampleRates.length && output.sampleRates.length && (!rates.length || settings.sampleRate && !rates.includes(settings.sampleRate))) code = 'SELECTED_SAMPLE_RATE_UNAVAILABLE'
      if (settings.inputChannels.some(channel => channel < 0 || channel >= input.inputChannels)) code = 'INPUT_CHANNEL_UNAVAILABLE'
    }
    if (code && !issues.some(issue => issue.severity === 'error')) issues.push(diagnostics.report(new DiagnosticError(code, code, { backend, input: input?.name ?? '未找到', output: output?.name ?? '未找到', sampleRate: settings.sampleRate, channels: settings.inputChannels }), 'recording', { component: 'audio-device', stage: '所选设备配置' }))
    checks.push({ id: 'audio-device', component: 'audio-device', stage: '所选设备配置', level: 'inventory', status: issues.some(issue => issue.severity === 'error') ? 'failed' : 'passed', checkedAt: new Date().toISOString(), detail: '仅验证枚举与配置，实际设备流将在用户开始测试时验证' })
    return { checks, issues }
  }

  async topologyChanged(settings: RecordingAudioSettings): Promise<boolean> {
    const previous = this.deviceSnapshot
    const current = await this.devices()
    const backend = settings.backend === 'auto' ? process.platform === 'darwin' ? 'coreaudio' : 'wasapi-shared' : settings.backend
    const selected = (devices: RecordingDeviceInfo[], direction: 'input' | 'output'): string | undefined => {
      const id = direction === 'input' ? settings.inputDeviceId : settings.outputDeviceId
      return devices.find(device => device.backend === backend && (direction === 'input' ? device.inputChannels : device.outputChannels) > 0
        && (id ? device.id === id : direction === 'input' ? device.defaultInput : device.defaultOutput))?.id
    }
    return ['input', 'output'].some(direction => selected(previous, direction as 'input' | 'output') !== selected(current, direction as 'input' | 'output'))
  }

  async prepareOutputDevice(deviceName: string | null): Promise<boolean> {
    if (process.platform !== 'darwin') return false
    return await this.request<boolean>('prepareOutputDevice', { deviceName }, 15_000)
  }

  async start(params: Record<string, unknown>): Promise<AudioHostStartResult> {
    const result = await this.startWithPlugins('start', params)
    for (const listener of this.listeners) listener({ event: 'opened', data: result })
    return result
  }

  async startTest(params: Record<string, unknown>): Promise<AudioHostStartResult> {
    const result = await this.startWithPlugins('startTest', params)
    for (const listener of this.listeners) listener({ event: 'opened', data: result })
    return result
  }

  async stop(): Promise<AudioHostStopResult | null> {
    try { return await this.request<AudioHostStopResult | null>('stop', {}, 15_000) }
    finally { this.liveSession = false; await this.plugins.stop() }
  }

  async stopTest(): Promise<AudioHostStopResult | null> {
    try { return await this.request<AudioHostStopResult | null>('stopTest', {}, 15_000) }
    finally { this.liveSession = false; await this.plugins.stop() }
  }

  private async startWithPlugins(method: 'start' | 'startTest', params: Record<string, unknown>): Promise<AudioHostStartResult> {
    if ((params.effects as PreparedEffects | undefined)?.pluginGraph) await this.requireNativeCapabilities()
    const worker = await this.plugins.prepare(params.effects as PreparedEffects | undefined, Number(params.sampleRate) || 48000)
    try {
      const result = await this.request<AudioHostStartResult>(method, { ...params, ...(worker ? { pluginMapping: worker.mapping } : {}) }, 30_000)
      this.liveSession = true; this.testSession = method === 'startTest'; this.outputOnly = params.outputOnly === true; this.sessionRate = result.sampleRate; await this.plugins.commit(worker)
      if (method === 'startTest' && !this.outputOnly && this.timelineGraph && this.timelineGraph.sampleRate === result.sampleRate) {
        await this.request('timeline', { action: 'load', graph: { ...this.timelineGraph, positionMs: this.timelineState?.positionMs ?? this.timelineGraph.positionMs } })
        if (this.timelineState?.playing) await this.request('timeline', { action: 'play' })
      }
      return result
    } catch (error) { await worker?.stop(); throw error }
  }
  async setEffects(params: Record<string, unknown>): Promise<void> {
    if (!params.prepared) { await this.request('effects', params, 30000); return }
    if ((params.prepared as PreparedEffects).pluginGraph) await this.requireNativeCapabilities()
    const worker = await this.plugins.prepare(params.prepared as PreparedEffects, this.sessionRate)
    try { await this.request('effects', { ...params, pluginMapping: worker?.mapping ?? null }, 30000); await this.plugins.commit(worker) }
    catch (error) { await worker?.stop(); throw error }
  }
  async arsenalQuick(params: Record<string, unknown>): Promise<{ pluginFaults?: import('@shared/audio-plugins.js').PluginFaults | null; recording: boolean; looping: boolean; durationMs: number; sampleRate: number; channels: number }> { return this.request('arsenalQuick', params, 30000) }
  async arsenalPcm(params: Record<string, unknown>): Promise<boolean> { return this.request('arsenalPcm', params, 5000) }
  activeSampleRate(): number | null { return this.liveSession ? this.sessionRate : null }
  isPlaybackOnly(): boolean { return this.liveSession && this.outputOnly }
  isTestSession(): boolean { return this.liveSession && this.testSession }
  clearTimeline(): void { this.timelineGraph = null; this.timelineState = null }
  async timeline(params: Record<string, unknown>): Promise<NativeAudioState | null> {
    await this.requireNativeCapabilities()
    const result = await this.request<NativeAudioState | null>('timeline', params, 30000)
    if (params.action === 'load') this.timelineGraph = params.graph as Record<string, unknown>
    else if (params.action === 'unload') { this.timelineGraph = null; this.timelineState = null }
    else if (params.action === 'update' && this.timelineGraph) {
      const state = params.state as Record<string, unknown>
      const tracks = this.timelineGraph.tracks as Array<Record<string, unknown>>
      const gains = state.tracks as Array<Record<string, unknown>>
      this.timelineGraph = { ...this.timelineGraph, ...state, tracks: tracks.map(t => ({ ...t, ...gains.find(g => g.id === t.id) })) }
    }
    this.timelineState = result; return result
  }

  async pause(): Promise<boolean> {
    return await this.request<boolean>('pause', {}, 5_000)
  }

  async resume(): Promise<boolean> {
    return await this.request<boolean>('resume', {}, 5_000)
  }

  async cancel(): Promise<AudioHostStopResult | null> {
    try { return await this.request<AudioHostStopResult | null>('cancel', {}, 15_000) }
    finally { this.liveSession = false; await this.plugins.stop() }
  }

  async shutdown(): Promise<void> {
    const child = this.child
    if (!child || child.killed) { await this.plugins.stop(); return }
    this.expectedExit = true
    // Core acknowledges shutdown only after its callbacks and mappings close.
    // Windows cannot remove the worker's session directory while it is mapped.
    try { await this.request('shutdown', {}, 5_000) } catch { child.kill() }
    finally { this.liveSession = false; await this.plugins.stop() }
  }

  private requireNativeCapabilities(): Promise<void> {
    this.ensureStarted()
    return this.nativeCapabilities ??= this.request<{ protocol: number; pluginIpc: number; nativeTimeline: boolean; outputProtection: boolean }>('capabilities', {}).then(capabilities => {
      if (capabilities?.protocol !== 2 || capabilities.pluginIpc !== 1 || !capabilities.nativeTimeline || !capabilities.outputProtection) {
        throw new DiagnosticError('AUDIO_HOST_PROTOCOL_MISMATCH', '原生音频组件版本不匹配，请重新安装完整版本', { capabilities })
      }
    })
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child
    const executable = this.paths.audioHostExecutable()
    if (!existsSync(executable)) throw new Error(`AUDIO_HOST_MISSING:${executable}`)
    this.expectedExit = false
    this.nativeCapabilities = null
    const child = spawnSafe(executable, this.probeBackend ? ['--probe-backend', this.probeBackend] : [])
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => this.receive(line))
    child.stderr.on('data', (chunk: string) => { this.stderrEvidence = [...this.stderrEvidence, chunk.slice(-2000)].slice(-12); this.logger.warn('audio host stderr', chunk.slice(-1200)) })
    child.once('error', (error) => this.failAll(error))
    child.once('exit', (code, signal) => {
      lines.close()
      if (this.child !== child) return
      this.child = null
      this.nativeCapabilities = null
      this.liveSession = false
      void this.plugins.stop()
      const error = new DiagnosticError('AUDIO_HOST_EXITED', `AUDIO_HOST_EXITED:${code ?? signal ?? 'unknown'}`, { exitCode: code, signal, backend: this.probeBackend })
      this.failAll(error)
      if (!this.expectedExit) {
        this.logger.error('audio host exited unexpectedly', { code, signal })
        for (const listener of this.listeners) listener({ event: 'crashed', data: { error: error.message, evidence: errorEvidence(error) } })
      }
    })
    return child
  }

  private async request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    const child = this.ensureStarted()
    const id = ++this.sequence
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        if (method === 'devices') this.expectedExit = true
        if (['devices', 'start', 'startTest', 'stop', 'stopTest'].includes(method)) child.kill()
        reject(new DiagnosticError('AUDIO_HOST_TIMEOUT', `AUDIO_HOST_TIMEOUT:${method}`, { method, timeoutMs, backend: this.probeBackend, sampleRate: params.sampleRate, inputDeviceId: params.inputDeviceId, outputDeviceId: params.outputDeviceId }))
      }, timeoutMs)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private receive(line: string): void {
    let message: RpcMessage
    try { message = JSON.parse(line) as RpcMessage } catch {
      this.logger.warn('audio host emitted invalid JSON', line.slice(0, 500))
      return
    }
    if (message.event) {
      if (message.event === 'meter' && (message.data as AudioHostMeterEvent)?.timeline) this.timelineState = (message.data as AudioHostMeterEvent).timeline!
      if (['finished', 'error', 'crashed'].includes(message.event)) { this.liveSession = false; void this.plugins.stop() }
      for (const listener of this.listeners) listener({ event: message.event, data: message.data } as AudioHostEvent)
      return
    }
    if (typeof message.id !== 'number') return
    const request = this.pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer)
    this.pending.delete(message.id)
    if (message.ok) request.resolve(message.result)
    else request.reject(new DiagnosticError((message.error ?? 'AUDIO_HOST_ERROR').split(':')[0]!, message.error || 'AUDIO_HOST_ERROR', { evidence: message.evidence, backend: this.probeBackend, devices: this.deviceSnapshot.map(device => ({ name: device.name, backend: device.backend })) }))
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
}

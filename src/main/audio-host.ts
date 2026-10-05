import { existsSync } from 'node:fs'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { RecordingDeviceInfo, RecordingAudioSettings } from '@shared/domain.js'
import type { Logger } from './logger.js'
import type { AppPaths } from './paths.js'
import { spawnSafe } from './process.js'

export interface AudioHostStartResult {
  sampleRate: number
  bufferFrames: number
  latencyMs: number
  splitDevices: boolean
  streamingBacking?: boolean
  backingBufferFrames?: number
}

export interface AudioHostStopResult {
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
  | { event: 'meter'; data: AudioHostMeterEvent }
  | { event: 'finished'; data: AudioHostStopResult }
  | { event: 'crashed'; data: { error: string } }
  | { event: 'error'; data: { error: string; capture: AudioHostStopResult | null } }

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
  event?: AudioHostEvent['event']
  data?: unknown
}

export class AudioHostClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private sequence = 0
  private readonly pending = new Map<number, PendingRequest>()
  private readonly listeners = new Set<(event: AudioHostEvent) => void>()
  private expectedExit = false
  private deviceSnapshot: RecordingDeviceInfo[] = []

  constructor(private readonly paths: AppPaths, private readonly logger: Logger, private readonly probeBackend = '') {}

  onEvent(listener: (event: AudioHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async devices(): Promise<RecordingDeviceInfo[]> {
    // Driver enumeration must not block or terminate a live recording process.
    const backends = process.platform === 'win32' ? ['wasapi', 'asio'] : ['coreaudio']
    const results = await Promise.allSettled(backends.map(async backend => {
      const probe = new AudioHostClient(this.paths, this.logger, backend)
      try { return await probe.request<RecordingDeviceInfo[]>('devices', { backend }, 15_000) }
      finally { await probe.shutdown() }
    }))
    const devices: RecordingDeviceInfo[] = []
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') devices.push(...result.value)
      else this.logger.warn('audio device probe failed', { backend: backends[index], error: String(result.reason) })
    }
    if (results.every(result => result.status === 'rejected')) throw new Error('AUDIO_DRIVER_PROBE_FAILED')
    this.deviceSnapshot = [...new Map(devices.map(device => [device.id, device])).values()]
    return this.deviceSnapshot
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
    return await this.request<AudioHostStartResult>('start', params, 30_000)
  }

  async startTest(params: Record<string, unknown>): Promise<AudioHostStartResult> {
    return await this.request<AudioHostStartResult>('startTest', params, 30_000)
  }

  async stop(): Promise<AudioHostStopResult | null> {
    return await this.request<AudioHostStopResult | null>('stop', {}, 15_000)
  }

  async stopTest(): Promise<AudioHostStopResult | null> {
    return await this.request<AudioHostStopResult | null>('stopTest', {}, 15_000)
  }

  async setEffects(params: Record<string, unknown>): Promise<void> { await this.request('effects', params, 30000) }
  async arsenalQuick(params: Record<string, unknown>): Promise<{ recording: boolean; looping: boolean; durationMs: number; sampleRate: number; channels: number }> { return this.request('arsenalQuick', params, 30000) }
  async arsenalPcm(params: Record<string, unknown>): Promise<boolean> { return this.request('arsenalPcm', params, 5000) }

  async pause(): Promise<boolean> {
    return await this.request<boolean>('pause', {}, 5_000)
  }

  async resume(): Promise<boolean> {
    return await this.request<boolean>('resume', {}, 5_000)
  }

  async cancel(): Promise<AudioHostStopResult | null> {
    return await this.request<AudioHostStopResult | null>('cancel', {}, 15_000)
  }

  async shutdown(): Promise<void> {
    const child = this.child
    if (!child || child.killed) return
    this.expectedExit = true
    try { await this.request('shutdown', {}, 2_000) } catch { child.kill() }
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child
    const executable = this.paths.audioHostExecutable()
    if (!existsSync(executable)) throw new Error(`AUDIO_HOST_MISSING:${executable}`)
    this.expectedExit = false
    const child = spawnSafe(executable, this.probeBackend ? ['--probe-backend', this.probeBackend] : [])
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => this.receive(line))
    child.stderr.on('data', (chunk: string) => this.logger.warn('audio host stderr', chunk.slice(-1200)))
    child.once('error', (error) => this.failAll(error))
    child.once('exit', (code, signal) => {
      lines.close()
      if (this.child === child) this.child = null
      const error = new Error(`AUDIO_HOST_EXITED:${code ?? signal ?? 'unknown'}`)
      this.failAll(error)
      if (!this.expectedExit) {
        this.logger.error('audio host exited unexpectedly', { code, signal })
        for (const listener of this.listeners) listener({ event: 'crashed', data: { error: error.message } })
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
        if (method === 'devices') { this.expectedExit = true; child.kill() }
        reject(new Error(`AUDIO_HOST_TIMEOUT:${method}`))
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
      for (const listener of this.listeners) listener({ event: message.event, data: message.data } as AudioHostEvent)
      return
    }
    if (typeof message.id !== 'number') return
    const request = this.pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer)
    this.pending.delete(message.id)
    if (message.ok) request.resolve(message.result)
    else request.reject(new Error(message.error || 'AUDIO_HOST_ERROR'))
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
}

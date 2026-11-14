import { app, shell } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { DEFAULT_REALTIME_CONFIG, realtimeConfigSchema, realtimeMixSchema, realtimeMetricsSchema, realtimePassed,
  type RealtimeState, type RealtimeConfig, type RealtimeCapabilities, type RealtimeDevice } from '@shared/realtime-separation.js'
import type { AppPaths } from './paths.js'
import type { RuntimeManager } from './runtime.js'
import type { BandBuddyDatabase } from './database.js'
import { runProcess, spawnSafe } from './process.js'

export class RealtimeSeparationService {
  private snapshot: RealtimeState = { phase: 'idle', config: { ...DEFAULT_REALTIME_CONFIG }, eligible: false, message: '请配置音频来源并运行性能测试', progress: 0, metrics: null, lastTest: null }
  private grant: string | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  private controller: AbortController | null = null
  private session: Promise<void> | null = null
  private topology = ''
  private shuttingDown = false
  constructor(private paths: AppPaths, private db: BandBuddyDatabase, private runtime: RuntimeManager,
    private changed: (state: RealtimeState) => void, private audioBusy: () => boolean,
    private jobsBusy: () => boolean, private releaseJobs: () => void) {
    db.sqlite.exec('CREATE TABLE IF NOT EXISTS realtime_separation_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)')
    try {
      const row = db.sqlite.prepare('SELECT value FROM realtime_separation_settings WHERE id=1').get() as { value: string } | undefined
      if (row) {
        const value = JSON.parse(row.value)
        this.snapshot.config = realtimeConfigSchema.parse(value.config)
        if (value.lastTest) this.snapshot.lastTest = { at: String(value.lastTest.at), config: realtimeConfigSchema.parse(value.lastTest.config), metrics: realtimeMetricsSchema.parse(value.lastTest.metrics) }
      }
    } catch { /* Invalid saved configuration returns to the initial setup. */ }
    runtime.onChange(() => {
      if (this.grant && this.grant !== this.fingerprint()) void this.invalidate('计算环境已变化，请重新测试')
    })
  }
  get active(): boolean { return this.session !== null }
  state(): RealtimeState { return structuredClone(this.snapshot) }
  private update(patch: Partial<RealtimeState>): void { this.snapshot = { ...this.snapshot, ...patch }; this.changed(this.state()) }
  private save(): void {
    this.db.sqlite.prepare('INSERT INTO realtime_separation_settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(JSON.stringify({ config: this.snapshot.config, lastTest: this.snapshot.lastTest }))
  }
  private native(): string {
    return path.join(path.dirname(this.paths.audioHostExecutable()), process.platform === 'win32' ? 'bandbuddy-realtime-audio.dll' : 'libbandbuddy-realtime-audio.dylib')
  }
  private script(): string { return path.join(path.dirname(this.runtime.workerScript()), 'realtime_worker.py') }
  private environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1', OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4', OPENBLAS_NUM_THREADS: '4' }
    delete env.PYTHONHOME; delete env.PYTHONPATH
    return env
  }
  private backend(): string { return this.snapshot.config.backend === 'auto' ? this.runtime.getInfo().selectedDevice : this.snapshot.config.backend }
  private fingerprint(): string {
    const { stems: _stems, mode: _mode, ...config } = this.snapshot.config
    const files = [this.runtime.pythonExecutable(), this.script(), this.native(), path.join(this.db.getSettings().modelRoot, 'bandbuddy-stems-v2.0.1', '5c90dfd2-34c22ccb.th')]
    return createHash('sha256').update(JSON.stringify([config, this.backend(), this.topology, this.runtime.getInfo().torchVersion,
      files.map(file => { try { const s = statSync(file); return [file, s.size, s.mtimeMs] } catch { return [file, 'missing'] } })])).digest('hex')
  }
  async capabilities(): Promise<RealtimeCapabilities> {
    const supported = process.platform === 'win32' || process.platform === 'darwin'
    const ready = supported && this.runtime.getInfo().status === 'ready' && existsSync(this.native())
    const result: RealtimeCapabilities = { supported, platform: process.platform, ready, device: this.backend(), devices: [] }
    if (!ready) return { ...result, error: '请先在设置中准备分轨运行环境，并确认原生音频组件已安装' }
    try {
      const probe = await runProcess(this.runtime.pythonExecutable(), [this.script(), '--native', this.native(), '--devices'], { env: this.environment(), signal: this.controller?.signal, timeoutMs: 15000, maxOutputChars: 64000 })
      if (probe.code !== 0) throw new Error('音频设备查询失败')
      const event = probe.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(value => value.type === 'devices')
      if (!event || !Array.isArray(event.devices)) throw new Error('音频设备查询没有返回结果')
      result.devices = event.devices as RealtimeDevice[]
      const topology = JSON.stringify(result.devices)
      if (this.topology && topology !== this.topology) await this.invalidate('音频设备已变化，请重新测试')
      this.topology = topology
      if (this.grant && this.grant !== this.fingerprint()) await this.invalidate('分轨运行配置已变化，请重新测试')
    } catch (error) { result.error = String(error); result.ready = false; await this.invalidate('音频设备不可用，请重新测试') }
    return result
  }
  configure(input: unknown): RealtimeState {
    if (this.active) throw new Error('请先停止当前测试或播放')
    const config = realtimeConfigSchema.parse(input)
    this.snapshot.config = config
    if (this.grant !== this.fingerprint()) this.grant = null
    this.save(); this.update({ eligible: !!this.grant, phase: 'idle', message: this.grant ? '当前配置已通过测试' : '请运行当前配置的性能测试' })
    return this.state()
  }
  mix(input: unknown): RealtimeState {
    const mix = realtimeMixSchema.parse(input)
    this.snapshot.config = { ...this.snapshot.config, ...mix }
    this.child?.stdin.write(JSON.stringify({ op: 'mix', ...mix }) + '\n')
    this.save(); this.update({}); return this.state()
  }
  async begin(test: boolean): Promise<RealtimeState> {
    if (this.shuttingDown || this.active) throw new Error('实时音频会话已在运行')
    if (this.audioBusy()) throw new Error('请先停止录音、音频测试或乐器监听')
    if (!this.snapshot.config.source || !this.snapshot.config.output || this.snapshot.config.source === this.snapshot.config.output) throw new Error('请选择不同的音频来源和输出设备')
    if (!test && (!this.grant || this.grant !== this.fingerprint())) { this.grant = null; this.update({ eligible: false }); throw new Error('请先通过当前配置的性能测试') }
    const controller = new AbortController()
    this.controller = controller
    if (test) this.grant = null
    this.update({ phase: 'waiting', eligible: false, progress: 0, metrics: null, message: '正在等待后台任务并检查音频设备' })
    this.session = this.execute(test, controller).catch(error => {
      this.grant = null
      if (!controller.signal.aborted) this.update({ phase: 'failed', eligible: false, message: String(error instanceof Error ? error.message : error) })
    }).finally(() => {
      this.child = null; this.controller = null; this.session = null
      if (this.snapshot.phase !== 'failed') this.update({ phase: 'idle', eligible: !!this.grant })
      this.releaseJobs()
    })
    return this.state()
  }
  private async execute(test: boolean, controller: AbortController): Promise<void> {
    const signal = controller.signal
    while (this.jobsBusy()) { signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 100)) }
    signal.throwIfAborted()
    const caps = await this.capabilities()
    signal.throwIfAborted()
    if (!caps.ready || caps.error) throw new Error(caps.error ?? '实时分轨组件未就绪')
    const config = this.snapshot.config
    if (!caps.devices.some(d => d.id === config.source && d.input) || !caps.devices.some(d => d.id === config.output && d.output)) throw new Error('所选音频设备已断开')
    if (this.audioBusy()) throw new Error('录音或乐器监听正在使用音频设备')
    const fingerprint = this.fingerprint()
    if (!test && this.grant !== fingerprint) throw new Error('设备配置变化，请重新测试')
    const args = [this.script(), '--native', this.native(), '--model-root', this.db.getSettings().modelRoot, '--device', this.backend(),
      '--config', JSON.stringify({ ...config, excludePids: app.getAppMetrics().map(metric => metric.pid) }), ...(test ? ['--test'] : [])]
    this.update({ phase: 'warming', message: '正在加载分轨模型' })
    const child = spawnSafe(this.runtime.pythonExecutable(), args, { signal, env: this.environment() })
    this.child = child
    child.stdin.on('error', () => {})
    let stderr = '', failure: string | null = null, resultReceived = false, lastEvent = Date.now()
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-6000) })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      try {
        const event = JSON.parse(line); lastEvent = Date.now()
        if (signal.aborted || this.snapshot.phase === 'stopping') return
        if (event.type === 'phase' && ['warming', 'testing', 'starting', 'running'].includes(event.phase)) this.update({ phase: event.phase, message: String(event.message) })
        if (event.type === 'metrics') this.update({ metrics: realtimeMetricsSchema.parse(event.metrics), progress: Math.min(1, Math.max(0, Number(event.progress) || 0)) })
        if (event.type === 'error') failure = String(event.error)
        if (event.type === 'result' && test) {
          const metrics = realtimeMetricsSchema.parse(event.result)
          resultReceived = true
          const passed = realtimePassed(config, metrics) && fingerprint === this.fingerprint()
          const hop = config.profile === 'smooth' ? 120 : 60
          const reasons = [
            !metrics.signalVerified && '测试音来源未验证', metrics.clockErrors > 0 && '音频时间戳异常',
            metrics.inputDrops + metrics.overflows > 0 && '音频缓冲丢包', metrics.underruns > 0 && '输出出现欠载',
            metrics.p99Ms > hop * .8 && '处理余量不足', metrics.maxMs > hop && '单块处理超过时限',
            (metrics.latencyMs <= 0 || metrics.latencyMs > (config.profile === 'smooth' ? 1000 : 300)) && '设备链路延迟不达标'
          ].filter(Boolean).join('、')
          this.grant = passed ? fingerprint : null
          this.update({ metrics, lastTest: { at: new Date().toISOString(), config: { ...config }, metrics }, progress: 1,
            message: passed ? '性能测试通过，可以开始实时分轨' : `测试未通过，${reasons || '配置已变化'}。请调整后重试。` })
          this.save()
        }
      } catch { failure = '实时音频进程返回了无效状态'; controller.abort() }
    })
    const watchdog = setInterval(() => {
      if (Date.now() - lastEvent > (this.snapshot.phase === 'warming' ? 120000 : 15000)) { failure = '实时音频进程响应超时，请重新测试'; controller.abort() }
    }, 1000)
    const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) }).finally(() => { clearInterval(watchdog); lines.close() })
    if (failure) { this.grant = null; this.update({ phase: 'failed', eligible: false, message: failure }); return }
    if (signal.aborted || this.snapshot.phase === 'stopping') return
    if (code !== 0 || (test && !resultReceived) || !test) throw new Error(stderr || '实时音频进程意外退出，请重新测试')
  }
  async stop(): Promise<RealtimeState> {
    if (!this.session) return this.state()
    const pending = this.session
    this.update({ phase: 'stopping', message: '正在停止并释放音频设备' })
    if (this.child) this.child.stdin.write('{"op":"stop"}\n')
    else this.controller?.abort()
    const timer = setTimeout(() => this.controller?.abort(), 4000)
    await pending.finally(() => clearTimeout(timer))
    this.update({ message: this.grant ? '已停止，当前配置已通过性能测试' : '已停止，请运行性能测试' })
    return this.state()
  }
  async invalidate(message: string): Promise<void> {
    this.grant = null
    // During setup, invalidation must not await its own session promise.
    this.controller?.abort()
    this.update({ eligible: false, message })
  }
  async shutdown(): Promise<void> { this.shuttingDown = true; await this.stop() }
  async openSetup(target: string): Promise<void> {
    const urls: Record<string, string> = { driver: 'https://vb-audio.com/Cable/', macDriver: 'https://existential.audio/blackhole/',
      routing: process.platform === 'win32' ? 'ms-settings:apps-volume' : 'x-apple.systempreferences:com.apple.Sound-Settings.extension',
      permission: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture' }
    if (!urls[target]) throw new Error('不支持的设置入口')
    await shell.openExternal(urls[target])
  }
}

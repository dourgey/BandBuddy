import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { net } from 'electron'
import type { ComputeDevice, GpuInfo, RuntimeInfo } from '@shared/domain.js'
import type { BandBuddyDatabase } from './database.js'
import type { Logger } from './logger.js'
import { isManagedPath, type AppPaths } from './paths.js'
import { runProcess, spawnSafe } from './process.js'
import { selectComputeDevice } from './runtime-device.js'
import { PYTHON_RUNTIME_REQUIREMENTS, PYTHON_RUNTIME_VERSIONS } from './runtime-dependencies.js'

export const RUNTIME_VERSIONS = {
  uv: '0.11.29',
  python: '3.12',
  ...PYTHON_RUNTIME_VERSIONS,
  modelRevision: 'htdemucs_6s:5c90dfd2-34c22ccb'
} as const

const UV_ZIP_SHA256 = 'a047d55651bc3e0ca24595b25ec4cfcb10f9dca9fb56514e661269b37d4fae68'
const UV_EXE_SHA256 = '6d40479cd1d0d5db7fc0fe68ad703fc8acbd84bba50d864bb97461f6af9d9561'
const UV_DOWNLOAD = `https://releases.astral.sh/github/uv/releases/download/${RUNTIME_VERSIONS.uv}/uv-x86_64-pc-windows-msvc.zip`

type RuntimeListener = (info: RuntimeInfo) => void

interface WorkerMessage {
  type?: string
  stage?: string
  progress?: number
  message?: string
  [key: string]: unknown
}

export class RuntimeManager {
  private listeners = new Set<RuntimeListener>()
  private installation: AbortController | null = null
  private info: RuntimeInfo

  constructor(
    private readonly paths: AppPaths,
    private readonly database: BandBuddyDatabase,
    private readonly logger: Logger
  ) {
    const settings = database.getSettings()
    this.info = {
      status: 'missing',
      stage: '尚未检测',
      progress: null,
      device: settings.preferredDevice,
      selectedDevice: 'cpu',
      gpu: null,
      pythonVersion: null,
      torchVersion: null,
      cudaVersion: null,
      demucsVersion: null,
      modelReady: false,
      modelRevision: RUNTIME_VERSIONS.modelRevision,
      runtimePath: settings.runtimeRoot,
      modelPath: settings.modelRoot,
      error: null
    }
  }

  getInfo(): RuntimeInfo {
    return { ...this.info }
  }

  onChange(listener: RuntimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(patch: Partial<RuntimeInfo>): void {
    this.info = { ...this.info, ...patch }
    for (const listener of this.listeners) listener(this.getInfo())
  }

  private environment(): NodeJS.ProcessEnv {
    const settings = this.database.getSettings()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UV_CACHE_DIR: path.join(this.paths.cacheRoot, 'uv'),
      UV_PYTHON_INSTALL_DIR: path.join(settings.runtimeRoot, 'managed-python'),
      UV_PYTHON_NO_REGISTRY: '1',
      UV_NO_PROJECT: '1',
      TORCH_HOME: path.join(settings.modelRoot, '.torch-cache'),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONNOUSERSITE: '1'
    }
    const packagedBin = this.paths.packagedResource('bin')
    const developmentBin = path.join(process.cwd(), 'resources', 'bin')
    const toolBin = existsSync(path.join(packagedBin, 'ffmpeg.exe')) ? packagedBin : developmentBin
    env.PATH = `${toolBin}${path.delimiter}${env.PATH ?? ''}`
    const network = settings.network
    if (network.proxyMode === 'manual' && network.proxyUrl) {
      env.HTTPS_PROXY = network.proxyUrl
      env.HTTP_PROXY = network.proxyUrl
    } else if (network.proxyMode === 'none') {
      delete env.HTTPS_PROXY
      delete env.HTTP_PROXY
      delete env.ALL_PROXY
    }
    return env
  }

  pythonExecutable(): string {
    const settings = this.database.getSettings()
    return process.platform === 'win32'
      ? path.join(settings.runtimeRoot, 'env', 'Scripts', 'python.exe')
      : path.join(settings.runtimeRoot, 'env', 'bin', 'python')
  }

  workerScript(): string {
    const packaged = this.paths.packagedResource('worker', 'worker.py')
    return existsSync(packaged) ? packaged : path.join(process.cwd(), 'python', 'worker', 'worker.py')
  }

  private async detectNvidia(): Promise<GpuInfo | null> {
    try {
      const result = await runProcess('nvidia-smi.exe', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'])
      if (result.code !== 0 || !result.stdout.trim()) return null
      const [name = '', driverVersion = '', memory = '0'] = result.stdout.trim().split(/\r?\n/)[0]!.split(',').map((part) => part.trim())
      return { name, driverVersion, memoryMb: Number(memory) || 0 }
    } catch {
      return null
    }
  }

  async detect(): Promise<RuntimeInfo> {
    if (this.installation) return this.getInfo()
    const settings = this.database.getSettings()
    this.update({
      status: 'detecting', stage: '检测显卡与私有运行环境', progress: null, error: null,
      device: settings.preferredDevice, runtimePath: settings.runtimeRoot, modelPath: settings.modelRoot
    })
    const gpu = process.platform === 'win32' ? await this.detectNvidia() : null
    let selectedDevice = selectComputeDevice(settings.preferredDevice, process.platform, { nvidiaDetected: gpu !== null })

    const python = this.pythonExecutable()
    if (!existsSync(python) || !existsSync(this.workerScript())) {
      const stage = gpu
        ? '检测到 NVIDIA，可安装 CUDA 环境'
        : process.platform === 'darwin'
          ? '将优先使用 Apple MPS，不可用时自动使用 CPU'
          : '未检测到 NVIDIA GPU，将自动使用 CPU'
      this.update({ status: 'missing', stage, gpu, selectedDevice, progress: null })
      return this.getInfo()
    }

    try {
      const probe = await this.runWorker(['probe', '--model-root', settings.modelRoot], undefined, 90_000)
      if (probe.code !== 0) throw new Error(probe.error ?? '运行环境自检失败')
      const data = probe.result
      selectedDevice = selectComputeDevice(settings.preferredDevice, process.platform, {
        nvidiaDetected: gpu !== null,
        cudaAvailable: Boolean(data.cudaAvailable),
        mpsAvailable: Boolean(data.mpsAvailable)
      })
      this.update({
        status: data.modelReady ? 'ready' : 'missing',
        stage: data.modelReady ? `环境就绪 · ${selectedDevice.toUpperCase()}` : '运行环境已安装，模型尚未就绪',
        progress: data.modelReady ? 1 : null,
        gpu,
        selectedDevice,
        pythonVersion: String(data.pythonVersion ?? ''),
        torchVersion: String(data.torchVersion ?? ''),
        cudaVersion: data.cudaVersion ? String(data.cudaVersion) : null,
        demucsVersion: String(data.demucsVersion ?? ''),
        modelReady: Boolean(data.modelReady),
        error: null
      })
    } catch (error) {
      this.logger.warn('runtime detection failed', error)
      this.update({ status: 'failed', stage: '运行环境损坏，可尝试修复', progress: null, gpu, selectedDevice, error: String(error) })
    }
    return this.getInfo()
  }

  async install(): Promise<RuntimeInfo> {
    if (this.installation) return this.getInfo()
    const controller = new AbortController()
    this.installation = controller
    const settings = this.database.getSettings()
    mkdirSync(settings.runtimeRoot, { recursive: true })
    mkdirSync(settings.modelRoot, { recursive: true })
    try {
      this.update({ status: 'installing', stage: '准备安装工具', progress: 0.02, error: null })
      const uv = await this.ensureUv(controller.signal)
      const env = this.environment()
      const run = async (args: string[], stage: string, progress: number): Promise<void> => {
        this.update({ status: 'installing', stage, progress })
        const result = await runProcess(uv, args, {
          env,
          signal: controller.signal,
          onStderrLine: (line) => {
            if (/download|install|resolve/i.test(line)) this.update({ stage: `${stage} · ${line.slice(0, 100)}` })
            this.logger.info('uv', line)
          }
        })
        if (controller.signal.aborted) throw new Error('INSTALL_CANCELLED')
        if (result.code !== 0) throw new Error(`UV_FAILED:${result.stderr.slice(-1200)}`)
      }

      await run(['python', 'install', RUNTIME_VERSIONS.python, '--python-preference', 'only-managed'], '安装私有 CPython 3.12', 0.12)
      await run([
        'venv', path.join(settings.runtimeRoot, 'env'), '--python', RUNTIME_VERSIONS.python,
        '--python-preference', 'only-managed', '--clear', '--no-project'
      ], '创建 BandBuddy 私有环境', 0.2)

      const installArgs = ['pip', 'install', '--python', this.pythonExecutable(), '--torch-backend', 'auto']
      if (settings.network.pythonIndexUrl) installArgs.push('--default-index', settings.network.pythonIndexUrl)
      if (settings.network.pytorchIndexUrl) installArgs.push('--index', settings.network.pytorchIndexUrl)
      installArgs.push(...PYTHON_RUNTIME_REQUIREMENTS)
      await run(installArgs, '安装 PyTorch 与 Demucs（下载可续传）', 0.32)

      this.update({ status: 'downloadingModel', stage: '下载并校验分轨模型', progress: 0.78 })
      const model = await this.runWorker([
        'ensure-model', '--model-root', settings.modelRoot
      ], controller.signal, 0, (message) => {
        if (typeof message.progress === 'number') this.update({ progress: 0.78 + message.progress * 0.14 })
        if (message.message) this.update({ stage: message.message })
      })
      if (model.code !== 0) throw new Error(model.error ?? 'MODEL_INSTALL_FAILED')

      this.update({ status: 'verifying', stage: '执行 Torch 与短推理自检', progress: 0.94 })
      const detected = await this.detectAfterInstall(controller.signal)
      this.database.unblockRuntimeJobs()
      this.update({ ...detected, status: 'ready', stage: `环境就绪 · ${detected.selectedDevice.toUpperCase()}`, progress: 1, modelReady: true, error: null })
      return this.getInfo()
    } catch (error) {
      if (controller.signal.aborted || String(error).includes('INSTALL_CANCELLED')) {
        this.update({ status: 'missing', stage: '安装已取消，可继续安装', progress: null, error: null })
      } else {
        this.logger.error('runtime installation failed', error)
        this.update({ status: 'failed', stage: '安装失败', progress: null, error: String(error) })
      }
      return this.getInfo()
    } finally {
      if (this.installation === controller) this.installation = null
    }
  }

  private async detectAfterInstall(signal: AbortSignal): Promise<Partial<RuntimeInfo> & { selectedDevice: 'cuda' | 'mps' | 'cpu' }> {
    const settings = this.database.getSettings()
    const gpu = process.platform === 'win32' ? await this.detectNvidia() : null
    const probe = await this.runWorker(['probe', '--model-root', settings.modelRoot, '--self-test'], signal, 180_000)
    if (probe.code !== 0) throw new Error(probe.error ?? 'SELF_TEST_FAILED')
    const data = probe.result
    const selectedDevice = selectComputeDevice(settings.preferredDevice, process.platform, {
      nvidiaDetected: gpu !== null,
      cudaAvailable: Boolean(data.cudaAvailable),
      mpsAvailable: Boolean(data.mpsAvailable)
    })
    return {
      selectedDevice,
      gpu,
      pythonVersion: String(data.pythonVersion ?? ''),
      torchVersion: String(data.torchVersion ?? ''),
      cudaVersion: data.cudaVersion ? String(data.cudaVersion) : null,
      demucsVersion: String(data.demucsVersion ?? ''),
      modelReady: Boolean(data.modelReady)
    }
  }

  cancelInstall(): void {
    this.installation?.abort()
  }

  async repair(): Promise<RuntimeInfo> {
    await this.removeEnvironment(false)
    return await this.install()
  }

  async removeEnvironment(includeModels = false): Promise<void> {
    this.cancelInstall()
    const settings = this.database.getSettings()
    const unifiedStorage = this.usesUnifiedStorage(settings)
    const legacyManagedPath = isManagedPath(this.paths.localRoot, settings.runtimeRoot)
      && path.resolve(settings.runtimeRoot) !== path.resolve(this.paths.localRoot)
    if (!unifiedStorage && !legacyManagedPath) throw new Error('UNSAFE_RUNTIME_PATH')
    if (unifiedStorage) {
      await Promise.all([
        rm(path.join(settings.runtimeRoot, 'env'), { recursive: true, force: true }),
        rm(path.join(settings.runtimeRoot, 'managed-python'), { recursive: true, force: true })
      ])
    } else {
      await rm(settings.runtimeRoot, { recursive: true, force: true })
    }
    if (includeModels) await this.clearModelCache()
    this.update({
      status: 'missing', stage: '运行环境已卸载', progress: null, pythonVersion: null, torchVersion: null,
      cudaVersion: null, demucsVersion: null, modelReady: false, error: null
    })
  }

  async clearModelCache(): Promise<void> {
    const settings = this.database.getSettings()
    const root = settings.modelRoot
    const legacyManagedPath = isManagedPath(this.paths.localRoot, root)
      && path.resolve(root) !== path.resolve(this.paths.localRoot)
    if (!this.usesUnifiedStorage(settings) && !legacyManagedPath) throw new Error('UNSAFE_MODEL_PATH')
    await rm(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    this.update({ status: 'missing', stage: '模型缓存已清理', progress: null, modelReady: false })
  }

  private usesUnifiedStorage(settings: { libraryRoot: string; runtimeRoot: string; modelRoot: string }): boolean {
    const runtimeRoot = path.resolve(settings.runtimeRoot)
    const dataRoot = path.dirname(runtimeRoot)
    return path.basename(runtimeRoot).toLowerCase() === 'envs'
      && path.resolve(settings.libraryRoot) === path.join(dataRoot, 'music')
      && path.resolve(settings.modelRoot) === path.join(runtimeRoot, 'models')
  }

  private async ensureUv(signal: AbortSignal): Promise<string> {
    const packaged = this.paths.packagedResource('bin', 'uv.exe')
    if (existsSync(packaged)) {
      if (await this.fileSha256(packaged) !== UV_EXE_SHA256) throw new Error('UV_HASH_MISMATCH')
      return packaged
    }
    const destinationRoot = path.join(this.paths.toolsRoot, 'uv')
    const destination = path.join(destinationRoot, 'uv.exe')
    if (existsSync(destination)) {
      if (await this.fileSha256(destination) === UV_EXE_SHA256) return destination
      await rm(destination, { force: true })
    }
    mkdirSync(destinationRoot, { recursive: true })
    const archive = path.join(this.paths.downloadRoot, `uv-${RUNTIME_VERSIONS.uv}-windows-x64.zip`)
    const temporary = `${archive}.part`
    this.update({ status: 'installing', stage: `下载 uv ${RUNTIME_VERSIONS.uv}`, progress: 0.04 })
    const response = await net.fetch(UV_DOWNLOAD, { signal })
    if (!response.ok) throw new Error(`UV_DOWNLOAD_HTTP_${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    await writeFile(temporary, bytes)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== UV_ZIP_SHA256) {
      await rm(temporary, { force: true })
      throw new Error('UV_HASH_MISMATCH')
    }
    await rename(temporary, archive)
    const zip = new AdmZip(archive)
    const entry = zip.getEntries().find((candidate) => candidate.entryName.endsWith('/uv.exe') || candidate.entryName === 'uv.exe')
    if (!entry) throw new Error('UV_ARCHIVE_INVALID')
    zip.extractEntryTo(entry, destinationRoot, false, true)
    if (!existsSync(destination)) {
      const extracted = path.join(destinationRoot, path.basename(entry.entryName))
      if (existsSync(extracted) && extracted !== destination) await rename(extracted, destination)
    }
    if (!existsSync(destination)) throw new Error('UV_EXTRACT_FAILED')
    if (await this.fileSha256(destination) !== UV_EXE_SHA256) throw new Error('UV_HASH_MISMATCH')
    return destination
  }

  private async fileSha256(filePath: string): Promise<string> {
    return createHash('sha256').update(await readFile(filePath)).digest('hex')
  }

  async runWorker(
    args: string[],
    signal?: AbortSignal,
    timeoutMs = 0,
    onMessage?: (message: WorkerMessage) => void
  ): Promise<{ code: number; result: Record<string, unknown>; error: string | null }> {
    const python = this.pythonExecutable()
    if (!existsSync(python)) return { code: -1, result: {}, error: 'PYTHON_MISSING' }
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort()
    signal?.addEventListener('abort', forwardAbort, { once: true })
    let timer: NodeJS.Timeout | undefined
    if (timeoutMs > 0) timer = setTimeout(() => controller.abort(), timeoutMs)
    let lastResult: Record<string, unknown> = {}
    let structuredError: string | null = null
    try {
      const result = await runProcess(python, [this.workerScript(), ...args], {
        env: this.environment(),
        signal: controller.signal,
        onStdoutLine: (line) => {
          try {
            const message = JSON.parse(line) as WorkerMessage
            onMessage?.(message)
            if (message.type === 'result') lastResult = message as Record<string, unknown>
            if (message.type === 'error') structuredError = String(message.message ?? message.code ?? 'WORKER_ERROR')
          } catch {
            this.logger.info('worker stdout', line)
          }
        },
        onStderrLine: (line) => this.logger.info('worker stderr', line)
      })
      return { code: result.code, result: lastResult, error: structuredError ?? (result.code === 0 ? null : result.stderr.slice(-1200)) }
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }

  spawnWorker(args: string[], signal: AbortSignal, onMessage: (message: WorkerMessage) => void): ReturnType<typeof spawnSafe> {
    const child = spawnSafe(this.pythonExecutable(), [this.workerScript(), ...args], { env: this.environment(), signal })
    let pending = ''
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        try { onMessage(JSON.parse(line) as WorkerMessage) }
        catch { this.logger.info('worker stdout', line) }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => this.logger.info('worker stderr', chunk.toString('utf8')))
    return child
  }
}

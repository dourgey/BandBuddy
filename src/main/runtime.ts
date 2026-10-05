import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { availableParallelism } from 'node:os'
import { app } from 'electron'
import type { ComputeDevice, GpuInfo, RuntimeInfo } from '@shared/domain.js'
import { matchRuntimeSourcePreset, RUNTIME_SOURCE_PRESETS, resolvePytorchSourceUrl, selectPytorchBackend } from '@shared/runtime-sources.js'
import type { BandBuddyDatabase } from './database.js'
import type { Logger } from './logger.js'
import { isManagedPath, type AppPaths } from './paths.js'
import { runProcess, spawnSafe } from './process.js'
import { redactNetworkCredentials } from './runtime-proxy.js'
import { selectComputeDevice } from './runtime-device.js'
import {
  PYTHON_RUNTIME_VERSIONS,
  pythonRuntimeRequirements,
  selectOnnxRuntimeVariant
} from './runtime-dependencies.js'
import { currentToolTarget, toolFile } from './platform-tools.js'
import { isTrustedMacBundle } from './macos-bundle-integrity.js'
import { RuntimeNetwork, proxyEnvironment } from './runtime-network.js'
import { systemHelper } from './system-helper.js'
import { loadRuntimeProfiles, chooseRuntimeProfile, extractInterpreter, assertProfileSystem, type RuntimeProfile } from './runtime-catalog.js'
import { modelCatalog, prepareModels, modelsValid } from './model-catalog.js'
import { checkEnvironmentStorage, remainingDownloadBytes } from './environment-storage.js'
import { downloadBatch, type DownloadProgress } from './artifact-download.js'
import { activeEnvironment, activateEnvironment, createEnvironment } from './runtime-environments.js'
import { intelSphnRequirement, validateIntelRuntimeLock } from './runtime-wheel-manifest.js'
import { isTrustedWindowsTool } from './windows-tool-integrity.js'
import {
  detectWindowsVcRuntime,
  isTrustedMicrosoftSignature,
  isWindowsNativeRuntimeError,
  parseAuthenticodeInfo
} from './windows-prerequisites.js'

const TOOL_TARGET = currentToolTarget()
const UV_FILE = toolFile(TOOL_TARGET, 'uv')
const UV_SOURCE = TOOL_TARGET.sources[UV_FILE.source]!
const FFMPEG_FILE = toolFile(TOOL_TARGET, 'ffmpeg')

export const RUNTIME_VERSIONS = {
  uv: UV_SOURCE.version,
  python: '3.12',
  ...PYTHON_RUNTIME_VERSIONS,
  modelRevision: 'bandbuddy-stems:v2.0.1'
} as const

const UV_ARCHIVE_SHA256 = UV_SOURCE.sha256
const UV_BINARY_SHA256 = UV_FILE.sha256
const UV_DOWNLOAD = UV_SOURCE.url
const VC_RUNTIME_INSTALLER = 'vc_redist.x64.exe'

function tarFile(bytes: Buffer, entrySuffix: string, fallbackEntry?: string): Buffer | null {
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((value) => value === 0)) break
    const text = (start: number, length: number): string => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join('/')
    const size = Number.parseInt(text(124, 12).trim(), 8) || 0
    const type = text(156, 1)
    const dataStart = offset + 512
    if ((type === '' || type === '0') && (name.endsWith(entrySuffix) || name === fallbackEntry)) {
      return bytes.subarray(dataStart, dataStart + size)
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return null
}

type RuntimeListener = (info: RuntimeInfo) => void

interface WorkerMessage {
  type?: string
  stage?: string
  progress?: number
  message?: string
  [key: string]: unknown
}

export class RuntimeManager {
  private preparationGate: (signal: AbortSignal) => Promise<void> = async signal => { signal.throwIfAborted() }
  setPreparationGate(gate: (signal: AbortSignal) => Promise<void>): void { this.preparationGate = gate }
  async verifyNativePrerequisites(signal: AbortSignal): Promise<void> {
    const previous = this.getInfo()
    try {
      await this.ensureWindowsPrerequisites(signal)
      const host = this.paths.audioHostExecutable()
      if (!existsSync(host)) throw new Error('AUDIO_HOST_MISSING')
      const result = await runProcess(host, ['--self-test'], { signal, timeoutMs: 30_000 })
      if (result.code !== 0) throw new Error(`AUDIO_HOST_SELF_TEST_FAILED:${result.code}`)
    } finally { this.update({ ...previous, windowsVcRuntimeVersion: this.info.windowsVcRuntimeVersion }) }
  }
  downloadDiagnostics(): ReturnType<RuntimeNetwork['diagnostics']> { return this.network.diagnostics() }
  private dependenciesReady = false
  private faultRecovery?: (cpu: boolean) => Promise<boolean>
  setFaultRecovery(handler: (cpu: boolean) => Promise<boolean>): void { this.faultRecovery = handler }
  async recoverWorker(cpu: boolean): Promise<boolean> { return this.faultRecovery ? this.faultRecovery(cpu) : false }
  private listeners = new Set<RuntimeListener>()
  private installation: AbortController | null = null
  private installationTask: Promise<RuntimeInfo> | null = null
  private detectionTask: Promise<RuntimeInfo> | null = null
  private detectionController: AbortController | null = null
  private readonly network = new RuntimeNetwork()
  private info: RuntimeInfo
  private detection: Promise<RuntimeInfo> | null = null
  private detectedConfiguration: string | null = null

  private configurationKey(): string {
    const { runtimeRoot, modelRoot, preferredDevice } = this.database.getSettings()
    return JSON.stringify([runtimeRoot, modelRoot, preferredDevice])
  }

  ensureDetected(): Promise<RuntimeInfo> {
    if (this.detection) return this.detection
    return this.detectedConfiguration === this.configurationKey()
      ? Promise.resolve(this.getInfo())
      : this.detect()
  }

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
      windowsVcRuntimeVersion: null,
      pythonVersion: null,
      torchVersion: null,
      cudaVersion: null,
      modelReady: false,
      runtimePath: settings.runtimeRoot,
      modelPath: settings.modelRoot,
      error: null
    }
  }

  getInfo(): RuntimeInfo {
    return { ...this.info }
  }

  isInstalling(): boolean { return this.installationTask !== null || this.installation !== null }

  async shutdown(): Promise<void> {
    this.cancelInstall()
    await Promise.allSettled([this.installationTask, this.detectionTask])
    this.network.close()
  }

  onChange(listener: RuntimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(patch: Partial<RuntimeInfo>): void {
    if (patch.error) patch = { ...patch, error: redactNetworkCredentials(patch.error) }
    if (patch.stage) patch = { ...patch, stage: redactNetworkCredentials(patch.stage) }
    this.info = { ...this.info, ...patch }
    for (const listener of this.listeners) listener(this.getInfo())
  }

  private environment(): NodeJS.ProcessEnv {
    const settings = this.database.getSettings()
    const network = settings.network
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UV_CACHE_DIR: path.join(this.paths.cacheRoot, 'uv'),
      UV_PYTHON_INSTALL_DIR: path.join(settings.runtimeRoot, 'managed-python'),
      UV_PYTHON_NO_REGISTRY: '1',
      UV_NO_PROJECT: '1',
      UV_REQUEST_TIMEOUT: '120',
      TORCH_HOME: path.join(settings.modelRoot, '.torch-cache'),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONNOUSERSITE: '1'
    }
    const packagedBin = this.paths.packagedResource('bin')
    const developmentBin = path.join(process.cwd(), 'resources', 'bin')
    const toolBin = existsSync(path.join(packagedBin, FFMPEG_FILE.output)) ? packagedBin : developmentBin
    env.PATH = `${toolBin}${path.delimiter}${env.PATH ?? ''}`
    if (network.pythonInstallMirror) env.UV_PYTHON_INSTALL_MIRROR = network.pythonInstallMirror
    else delete env.UV_PYTHON_INSTALL_MIRROR
    // Keep one CPU available for playback/UI; avoid overlapping BLAS thread pools.
    const threads = String(Math.max(1, Math.min(8, availableParallelism() - 1)))
    for (const key of ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS', 'BANDBUDDY_CPU_THREADS']) env[key] = threads
    delete env.PYTHONHOME
    delete env.PYTHONPATH
    return proxyEnvironment(env, network)
  }

  pythonExecutable(): string {
    const settings = this.database.getSettings()
    return this.pythonIn(activeEnvironment(settings.runtimeRoot))
  }

  private pythonIn(directory: string): string {
    return process.platform === 'win32'
      ? path.join(directory, 'Scripts', 'python.exe')
      : path.join(directory, 'bin', 'python')
  }

  workerScript(): string {
    const packaged = this.paths.packagedResource('worker', 'worker.py')
    return existsSync(packaged) ? packaged : path.join(process.cwd(), 'python', 'worker', 'worker.py')
  }

  private async detectNvidia(): Promise<GpuInfo | null> {
    try {
      const result = await runProcess(process.platform === 'win32' ? path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe') : 'nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'], { timeoutMs: 8_000 })
      if (result.code !== 0 || !result.stdout.trim()) return null
      const [name = '', driverVersion = '', memory = '0'] = result.stdout.trim().split(/\r?\n/)[0]!.split(',').map((part) => part.trim())
      return { name, driverVersion, memoryMb: Number(memory) || 0 }
    } catch {
      return null
    }
  }

  private async detectGpuCompatibility(): Promise<{ driverVersion: string; computeCapability: string } | null> {
    if (process.platform !== 'win32') return null
    const executable = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe')
    try {
      const result = await runProcess(executable, ['--query-gpu=driver_version,compute_cap', '--format=csv,noheader,nounits'], { timeoutMs: 8_000 })
      const [driverVersion, computeCapability] = result.stdout.trim().split(/\r?\n/)[0]!.split(',').map(value => value.trim())
      return result.code === 0 && driverVersion && computeCapability ? { driverVersion, computeCapability } : null
    } catch { return null }
  }

  private async detectCudaVersion(): Promise<string | null> {
    if (process.platform !== 'win32') return null
    try {
      const result = await runProcess(process.platform === 'win32' ? path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe') : 'nvidia-smi', [], { timeoutMs: 8_000 })
      if (result.code !== 0) return null
      return /CUDA(?: UMD)? Version:\s*(\d+\.\d+)/i.exec(result.stdout)?.[1] ?? null
    } catch {
      return null
    }
  }

  detect(): Promise<RuntimeInfo> {
    if (this.installation) return Promise.resolve(this.getInfo())
    if (!this.detection) {
      const key = this.configurationKey()
      this.detection = this.detectNow().then(info => {
        this.detectedConfiguration = key
        return info
      }).finally(() => { this.detection = null })
    }
    return this.detection
  }

  private async detectNow(): Promise<RuntimeInfo> {
    if (this.installation) return this.getInfo()
    if (this.detectionTask) return this.detectionTask
    const controller = new AbortController()
    this.detectionController = controller
    const previous = this.getInfo()
    const task = this.preparationGate(controller.signal).then(() => this.performDetection(controller.signal)).catch(error => {
      if (!controller.signal.aborted) throw error
      this.update(previous)
      return this.getInfo()
    })
    this.detectionTask = task
    try { return await task } finally {
      if (this.detectionTask === task) this.detectionTask = null
      if (this.detectionController === controller) this.detectionController = null
    }
  }

  private async performDetection(signal: AbortSignal): Promise<RuntimeInfo> {
    signal.throwIfAborted()
    this.dependenciesReady = false
    const settings = this.database.getSettings()
    this.update({
      status: 'detecting', stage: '检测显卡与私有运行环境', progress: null, error: null,
      device: settings.preferredDevice, runtimePath: settings.runtimeRoot, modelPath: settings.modelRoot
    })
    const [gpu, vcRuntime] = process.platform === 'win32'
      ? await Promise.all([this.detectNvidia(), detectWindowsVcRuntime(runProcess)])
      : [null, null]
    signal.throwIfAborted()
    let selectedDevice = selectComputeDevice(settings.preferredDevice, process.platform, { nvidiaDetected: gpu !== null })

    if (vcRuntime && !vcRuntime.supported) {
      const installed = vcRuntime.installed && vcRuntime.version ? `（当前 ${vcRuntime.version}）` : ''
      this.update({
        status: 'missing',
        stage: `缺少新版 Microsoft Visual C++ x64 运行库${installed}，安装环境时将自动补齐`,
        progress: null,
        gpu,
        selectedDevice,
        windowsVcRuntimeVersion: vcRuntime.version,
        error: null
      })
      return this.getInfo()
    }

    const python = this.pythonExecutable()
    if (!existsSync(python) || !existsSync(this.workerScript())) {
      const stage = gpu
        ? '检测到 NVIDIA，可安装 CUDA 环境'
        : process.platform === 'darwin' && process.arch === 'arm64'
          ? '将优先使用 Apple MPS，不可用时自动使用 CPU'
          : '未检测到 NVIDIA GPU，将自动使用 CPU'
      this.update({ status: 'missing', stage, gpu, selectedDevice, progress: null })
      return this.getInfo()
    }

    try {
      const probe = await this.runWorker(['probe', '--model-root', settings.modelRoot, '--quick'], signal, 90_000)
      signal.throwIfAborted()
      if (probe.code !== 0) throw new Error(probe.error ?? '运行环境自检失败')
      const data = probe.result
      selectedDevice = selectComputeDevice(settings.preferredDevice, process.platform, {
        nvidiaDetected: gpu !== null,
        cudaAvailable: Boolean(data.cudaAvailable),
        mpsAvailable: Boolean(data.mpsAvailable)
      })
      const ready = Boolean(data.modelReady && data.dependenciesReady)
      this.dependenciesReady = Boolean(data.dependenciesReady)
      this.update({
        status: ready ? 'ready' : 'missing',
        stage: ready ? `环境就绪 · ${selectedDevice.toUpperCase()}` : '分轨组件或资源需要修复',
        progress: ready ? 1 : null,
        gpu,
        selectedDevice,
        windowsVcRuntimeVersion: vcRuntime?.version ?? null,
        pythonVersion: String(data.pythonVersion ?? ''),
        torchVersion: String(data.torchVersion ?? ''),
        cudaVersion: data.cudaVersion ? String(data.cudaVersion) : null,
        modelReady: Boolean(data.modelReady),
        error: null
      })
    } catch (error) {
      signal.throwIfAborted()
      this.logger.warn('runtime detection failed', error)
      this.update({
        status: 'failed', stage: '运行环境损坏，可尝试修复', progress: null, gpu, selectedDevice,
        error: isWindowsNativeRuntimeError(error) ? 'WINDOWS_NATIVE_RUNTIME_FAILED' : String(error)
      })
    }
    return this.getInfo()
  }

  async install(forceCpu = false): Promise<RuntimeInfo> {
    if (this.installationTask) return this.installationTask
    const task = this.performInstall(forceCpu)
    this.installationTask = task
    try { return await task } finally { if (this.installationTask === task) this.installationTask = null }
  }

  private async performInstall(forceCpu = false): Promise<RuntimeInfo> {
    if (this.installation) return this.getInfo()
    const controller = new AbortController()
    this.installation = controller
    const settings = this.database.getSettings()
    let candidate: string | null = null
    const candidates: string[] = []
    let rebuildCpu: (() => Promise<void>) | null = null
    let activated = false
    let previousInfo = this.getInfo()
    try {
      await this.detectionTask
      previousInfo = this.getInfo()
      controller.signal.throwIfAborted()
      if (!(process.platform === 'darwin' && process.arch === 'x64')) {
        const profiles = await loadRuntimeProfiles(process.resourcesPath ?? '')
        assertProfileSystem(profiles.find(profile => profile.backend === 'cpu')!)
      }
      mkdirSync(settings.runtimeRoot, { recursive: true })
      mkdirSync(settings.modelRoot, { recursive: true })
      candidate = await createEnvironment(settings.runtimeRoot)
      candidates.push(candidate)
      this.update({ status: 'installing', stage: '检查系统运行库', progress: 0.01, error: null })
      await this.preparationGate(controller.signal)
      await this.ensureWindowsPrerequisites(controller.signal)
      this.update({ status: 'installing', stage: '准备安装工具', progress: 0.08, error: null })
      const uv = await this.ensureUv(controller.signal)
      if (process.platform === 'darwin' && process.arch === 'x64') {
      let env = await this.network.environment(this.environment(), settings.network, settings.network.pythonInstallMirror || 'https://github.com/astral-sh/python-build-standalone')
      const run = async (args: string[], stage: string, progress: number): Promise<void> => {
        this.update({ status: 'installing', stage, progress })
        const result = await runProcess(uv, args, {
          env,
          timeoutMs: 30 * 60_000,
          signal: controller.signal,
          onStderrLine: (line) => {
            if (/download|install|resolve/i.test(line)) this.update({ stage: `${stage} · ${redactNetworkCredentials(line).slice(0, 100)}` })
            this.logger.info('uv', line)
          }
        })
        if (controller.signal.aborted) throw new Error('INSTALL_CANCELLED')
        if (result.code !== 0) throw new Error(`UV_FAILED:${redactNetworkCredentials(result.stderr).slice(-1200)}`)
      }

      const fallbackNetwork = matchRuntimeSourcePreset(settings.network) === 'china'
        ? { ...settings.network, ...RUNTIME_SOURCE_PRESETS.official } : null
      try {
        await run(['python', 'install', RUNTIME_VERSIONS.python, '--python-preference', 'only-managed'], '安装私有 CPython 3.12', 0.12)
      } catch (error) {
        if (!fallbackNetwork || controller.signal.aborted) throw error
        this.update({ stage: '当前镜像不可用，正在尝试官方 Python 源' })
        delete env.UV_PYTHON_INSTALL_MIRROR
        env = await this.network.environment(env, fallbackNetwork, 'https://github.com/astral-sh/python-build-standalone')
        await run(['python', 'install', RUNTIME_VERSIONS.python, '--python-preference', 'only-managed'], '安装私有 CPython 3.12', 0.12)
      }
      await run([
        'venv', candidate, '--python', RUNTIME_VERSIONS.python,
        '--python-preference', 'only-managed', '--no-project'
      ], '创建 BandBuddy 私有环境', 0.2)

      // Intel releases supply a complete wheel lock; established platforms retain pure Python sdists.
      const binaryPackages = process.platform === 'darwin' && process.arch === 'x64'
        ? ':all:' : 'torch,torchaudio,numpy,scipy,sphn,soundfile,onnxruntime,onnxruntime-gpu,numba,llvmlite'
      const installArgs = ['pip', 'install', '--python', this.pythonIn(candidate), '--only-binary', binaryPackages]
      const cudaVersion = await this.detectCudaVersion()
      const backend = selectPytorchBackend(process.platform, cudaVersion, settings.preferredDevice)
      if (settings.network.pythonIndexUrl) installArgs.push('--default-index', settings.network.pythonIndexUrl)
      if (settings.network.pytorchIndexUrl.includes('{backend}')) {
        installArgs.push('--find-links', resolvePytorchSourceUrl(settings.network.pytorchIndexUrl, backend))
        this.logger.info('selected mirrored PyTorch backend', { backend, cudaVersion })
      } else if (settings.network.pytorchIndexUrl) {
        installArgs.push('--index', settings.network.pytorchIndexUrl)
      } else {
        installArgs.push('--torch-backend', backend)
      }
      const onnxVariant = selectOnnxRuntimeVariant(process.platform, backend)
      const requirements = [...pythonRuntimeRequirements(PYTHON_RUNTIME_VERSIONS, onnxVariant)]
      let packageArguments = requirements
      if (process.platform === 'darwin' && process.arch === 'x64') {
        const sphn = await intelSphnRequirement(app.isPackaged ? this.paths.packagedResource('runtime-wheels.json') : path.join(process.cwd(), 'resources/runtime-wheels.json'))
        const lock = app.isPackaged ? this.paths.packagedResource('runtime-locks', 'macos-x64.lock') : path.join(process.cwd(), 'python/runtime/macos-x64.lock')
        await validateIntelRuntimeLock(lock, sphn)
        packageArguments = ['--require-hashes', '--requirements', lock]
      }
      installArgs.push(...packageArguments)
      this.logger.info('selected ONNX Runtime package', { onnxVariant, backend, cudaVersion })
      env = await this.network.environment(env, settings.network, settings.network.pythonIndexUrl || 'https://pypi.org/simple')
      try { await run(installArgs, '安装本地分轨组件（下载可续传）', 0.32) }
      catch (error) {
          const mirrorRejected = Boolean(settings.network.pythonIndexUrl) && /403|404|forbidden|not found|no solution found|unsatisfiable/i.test(String(error))
          if ((!fallbackNetwork && !mirrorRejected) || controller.signal.aborted) throw error
          env = await this.network.environment(env, fallbackNetwork ?? settings.network, 'https://pypi.org/simple')
        await run(['pip', 'install', '--python', this.pythonIn(candidate), '--only-binary', binaryPackages, '--default-index', 'https://pypi.org/simple', '--torch-backend', backend, ...packageArguments], '镜像暂不可用，正在从官方源安装分轨组件', 0.32)
      }

      this.update({ status: 'downloadingModel', stage: '下载并校验分轨资源', progress: 0.78 })
      const modelArgs = ['ensure-model', '--model-root', settings.modelRoot]
      const model = await this.runWorker(modelArgs, controller.signal, 0, (message) => {
        if (typeof message.progress === 'number') this.update({ progress: 0.78 + message.progress * 0.14 })
        if (message.message) this.update({ stage: message.message })
      }, candidate)
      if (model.code !== 0) throw new Error(model.error ?? 'MODEL_INSTALL_FAILED')

      } else {
      const profiles = await loadRuntimeProfiles(process.resourcesPath ?? '')
      const gpu = await this.detectGpuCompatibility()
      let profile = chooseRuntimeProfile(profiles, forceCpu ? 'cpu' : settings.preferredDevice, gpu)
      assertProfileSystem(profile)
      const models = await modelCatalog(process.resourcesPath ?? '')
      let total = [profile.python, ...profile.wheels, ...models.files].reduce((sum, file) => sum + (file.size ?? 0), 0)
      const received = new Map<string, number>()
      let lastUpdate = 0
      const progress = (value: DownloadProgress): void => {
        received.set(value.id, value.received)
        if (Date.now() - lastUpdate < 150 && value.received !== value.total) return
        lastUpdate = Date.now()
        const bytes = [...received.values()].reduce((sum, size) => sum + size, 0)
        this.update({ downloadedBytes: bytes, downloadTotalBytes: total, progress: Math.min(0.89, bytes / total * 0.8 + 0.08) })
      }
      const prepare = async (selected: RuntimeProfile): Promise<void> => {
        const archive = path.join(this.paths.downloadRoot, selected.python.sha256 + '.tar.gz')
        const wheelRoot = path.join(this.paths.downloadRoot, 'wheels', selected.id)
        const downloads = await Promise.all([remainingDownloadBytes(selected.python, archive), ...selected.wheels.map(file => remainingDownloadBytes(file, path.join(wheelRoot, file.filename)))])
        const modelBytes = await Promise.all(models.files.map(file => remainingDownloadBytes(file, path.join(settings.modelRoot, models.directory, file.filename))))
        await checkEnvironmentStorage([
          { directory: this.paths.downloadRoot, bytes: downloads.reduce((sum, bytes) => sum + bytes, 0) },
          { directory: path.join(this.paths.cacheRoot, 'uv'), bytes: selected.wheels.reduce((sum, file) => sum + (file.expandedSize ?? 0), 0) },
          { directory: settings.runtimeRoot, bytes: [selected.python, ...selected.wheels].reduce((sum, file) => sum + (file.expandedSize ?? 0), 0) },
          { directory: settings.modelRoot, bytes: modelBytes.reduce((sum, bytes) => sum + bytes, 0) }
        ])
        this.update({ status: 'installing', stage: '下载并校验所需组件', progress: null })
        await this.network.download(selected.python, archive, settings.network, controller.signal, progress)
        await downloadBatch(selected.wheels, controller.signal, (file, signal) => this.network.download(file, path.join(wheelRoot, file.filename), settings.network, signal, progress))
        await this.preparationGate(controller.signal)
        let python = await extractInterpreter(archive, settings.runtimeRoot, selected.python, controller.signal)
        const baseProbe = await runProcess(python, ['-I', '-c', 'import encodings, ssl, socket; print("ready")'], { signal: controller.signal, timeoutMs: 30_000 }).catch(() => ({ code: -1 }))
        if (baseProbe.code !== 0) {
          controller.signal.throwIfAborted()
          python = await extractInterpreter(archive, settings.runtimeRoot, selected.python, controller.signal, true)
        }
        const env = { ...this.environment(), UV_PYTHON_DOWNLOADS: 'never', UV_NO_CONFIG: '1', UV_OFFLINE: '1' }
        const run = async (args: string[]): Promise<void> => {
          const result = await runProcess(uv, args, { env, signal: controller.signal, timeoutMs: 30 * 60_000 })
          controller.signal.throwIfAborted()
          if (result.code !== 0) throw new Error(`UV_FAILED:${redactNetworkCredentials(result.stderr).slice(-1200)}`)
        }
        await run(['venv', candidate!, '--python', python, '--no-python-downloads', '--no-project', '--clear'])
        const lock = path.join(candidate!, 'requirements.lock')
        await writeFile(lock, selected.wheels.map(file => `${file.id}==${file.version} --hash=sha256:${file.sha256}`).join('\n') + '\n')
        this.update({ status: 'installing', stage: '安装已验证的组件', progress: null })
        await run(['pip', 'sync', '--python', this.pythonIn(candidate!), '--no-index', '--find-links', wheelRoot, '--only-binary', ':all:', '--require-hashes', '--no-config', lock])
        await writeFile(path.join(candidate!, 'runtime-profile.json'), JSON.stringify({ id: selected.id, pythonHash: selected.python.sha256 }))
      }
      await prepare(profile)
      this.update({ status: 'downloadingModel', stage: '下载并校验分轨资源', progress: null })
      await prepareModels(models, settings.modelRoot, this.network, settings.network, controller.signal, progress)
      await this.preparationGate(controller.signal)
      // A GPU wheel can fail before the worker emits any JSON; use a separate CPU candidate.
      const importProbe = await this.runWorker(['probe', '--model-root', settings.modelRoot, '--quick'], controller.signal, 90_000, undefined, candidate)
      if (profile.backend !== 'cpu') rebuildCpu = async () => {
        profile = profiles.find(item => item.backend === 'cpu')!
        total = [profile.python, ...profile.wheels, ...models.files].reduce((sum, file) => sum + (file.size ?? 0), 0)
        received.clear()
        for (const file of models.files) received.set(file.id, file.size ?? 0)
        candidate = await createEnvironment(settings.runtimeRoot)
        candidates.push(candidate)
        this.update({ stage: '正在准备兼容处理组件', downloadedBytes: [...received.values()].reduce((sum, size) => sum + size, 0), downloadTotalBytes: total, progress: null })
        await prepare(profile)
      }
      if (importProbe.code !== 0 || !importProbe.result.dependenciesReady) {
        if (!rebuildCpu) throw new Error(importProbe.error ?? 'SELF_TEST_FAILED')
        await rebuildCpu(); rebuildCpu = null
      }

      }
      this.update({ status: 'verifying', stage: '执行 Torch 与短推理自检', progress: 0.94 })
      await this.preparationGate(controller.signal)
      let detected: Awaited<ReturnType<RuntimeManager['detectAfterInstall']>>
      try { detected = await this.detectAfterInstall(controller.signal, candidate) }
      catch (error) {
        controller.signal.throwIfAborted()
        if (!rebuildCpu) throw error
        this.logger.warn('accelerated candidate failed its operation test; validating a separate CPU candidate', error)
        await rebuildCpu(); rebuildCpu = null
        await this.preparationGate(controller.signal)
        detected = await this.detectAfterInstall(controller.signal, candidate)
      }
      controller.signal.throwIfAborted()
      await this.preparationGate(controller.signal)
      await activateEnvironment(settings.runtimeRoot, candidate)
      activated = true
      this.database.unblockRuntimeJobs()
      this.update({ ...detected, status: 'ready', stage: `环境就绪 · ${detected.selectedDevice.toUpperCase()}`, progress: 1, modelReady: true, error: null })
      return this.getInfo()
    } catch (error) {
      if (previousInfo.status === 'ready' && existsSync(this.pythonExecutable())) {
        this.update({ ...previousInfo, stage: controller.signal.aborted ? '安装已取消，继续使用原有环境' : '更新未完成，已保留原有可用环境', error: controller.signal.aborted ? null : String(error) })
      } else if (controller.signal.aborted || String(error).includes('INSTALL_CANCELLED')) {
        this.update({ status: 'missing', stage: '安装已取消，可继续安装', progress: null, error: null })
      } else {
        this.logger.error('runtime installation failed', error)
        this.update({
          status: 'failed', stage: '安装失败', progress: null,
          error: isWindowsNativeRuntimeError(error) ? 'WINDOWS_NATIVE_RUNTIME_FAILED' : String(error)
        })
      }
      return this.getInfo()
    } finally {
      for (const directory of candidates) if (!activated || directory !== candidate) await rm(directory, { recursive: true, force: true }).catch(error => this.logger.warn('incomplete environment cleanup failed', error))
      this.network.close()
      if (this.installation === controller) this.installation = null
    }
  }

  private async detectAfterInstall(signal: AbortSignal, candidate: string): Promise<Partial<RuntimeInfo> & { selectedDevice: 'cuda' | 'mps' | 'cpu' }> {
    const settings = this.database.getSettings()
    const [gpu, vcRuntime] = process.platform === 'win32'
      ? await Promise.all([this.detectNvidia(), detectWindowsVcRuntime(runProcess)])
      : [null, null]
    const probe = await this.runWorker(['probe', '--model-root', settings.modelRoot, '--self-test', '--device', process.platform === 'darwin' && process.arch === 'x64' ? 'cpu' : settings.preferredDevice], signal, 600_000, undefined, candidate)
    if (probe.code !== 0) throw new Error(probe.error ?? 'SELF_TEST_FAILED')
    const data = probe.result
    if (!data.modelReady || !data.dependenciesReady || !(data.selfTest as { ok?: boolean } | undefined)?.ok) throw new Error('RUNTIME_SELF_TEST_INCOMPLETE')
    const selectedDevice = selectComputeDevice(settings.preferredDevice, process.platform, {
      nvidiaDetected: gpu !== null,
      cudaAvailable: Boolean(data.cudaAvailable),
      mpsAvailable: Boolean(data.mpsAvailable)
    })
    return {
      selectedDevice,
      gpu,
      windowsVcRuntimeVersion: vcRuntime?.version ?? null,
      pythonVersion: String(data.pythonVersion ?? ''),
      torchVersion: String(data.torchVersion ?? ''),
      cudaVersion: data.cudaVersion ? String(data.cudaVersion) : null,
      modelReady: Boolean(data.modelReady)
    }
  }

  cancelInstall(): void {
    this.installation?.abort()
    this.detectionController?.abort()
  }

  async repair(forceCpu = false): Promise<RuntimeInfo> {
    this.cancelInstall()
    await this.installationTask
    await this.detection
    await this.detect()
    if (forceCpu || !this.dependenciesReady) return this.install(forceCpu)
    const controller = new AbortController()
    this.installation = controller
    let needsRebuild = false
    try {
      await this.preparationGate(controller.signal)
      const settings = this.database.getSettings()
      const catalog = await modelCatalog(process.resourcesPath ?? '')
      if (!await modelsValid(catalog, settings.modelRoot)) {
        this.update({ status: 'downloadingModel', stage: '修复分轨资源', progress: null })
        const received = new Map<string, number>()
        const total = catalog.files.reduce((sum, file) => sum + (file.size ?? 0), 0)
        await prepareModels(catalog, settings.modelRoot, this.network, settings.network, controller.signal, progress => {
          received.set(progress.id, progress.received)
          this.update({ downloadedBytes: [...received.values()].reduce((a, b) => a + b, 0), downloadTotalBytes: total })
        })
      }
      await this.preparationGate(controller.signal)
      this.update({ status: 'verifying', stage: '验证原有环境', progress: null })
      try {
        const detected = await this.detectAfterInstall(controller.signal, activeEnvironment(settings.runtimeRoot))
        await this.preparationGate(controller.signal)
        this.update({ ...detected, status: 'ready', stage: '环境已修复', progress: 1, error: null })
      } catch (error) { controller.signal.throwIfAborted(); this.logger.warn('existing environment needs rebuilding', error); needsRebuild = true }
    } catch (error) {
      this.update({ status: 'missing', stage: controller.signal.aborted ? '准备已暂停' : '组件修复未完成', error: controller.signal.aborted ? null : String(error), progress: null })
    } finally { this.installation = null }
    return needsRebuild ? this.install() : this.getInfo()
  }

  async removeEnvironment(includeModels = false): Promise<void> {
    this.cancelInstall()
    await this.installationTask
    const settings = this.database.getSettings()
    const unifiedStorage = this.usesUnifiedStorage(settings)
    const legacyManagedPath = isManagedPath(this.paths.localRoot, settings.runtimeRoot)
      && path.resolve(settings.runtimeRoot) !== path.resolve(this.paths.localRoot)
    if (!unifiedStorage && !legacyManagedPath) throw new Error('UNSAFE_RUNTIME_PATH')
    if (unifiedStorage) {
      await Promise.all([
        rm(path.join(settings.runtimeRoot, 'env'), { recursive: true, force: true }),
        rm(path.join(settings.runtimeRoot, 'runtimes'), { recursive: true, force: true }),
        rm(path.join(settings.runtimeRoot, 'active-environment.json'), { force: true }),
        rm(path.join(settings.runtimeRoot, 'managed-python'), { recursive: true, force: true }),
        rm(path.join(settings.runtimeRoot, 'interpreters'), { recursive: true, force: true })
      ])
    } else {
      await rm(settings.runtimeRoot, { recursive: true, force: true })
    }
    if (includeModels) await this.clearModelCache()
    this.update({
      status: 'missing', stage: '运行环境已卸载', progress: null, pythonVersion: null, torchVersion: null,
      cudaVersion: null, modelReady: false, error: null
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
    this.update({ status: 'missing', stage: '分轨资源缓存已清理', progress: null, modelReady: false })
  }

  private usesUnifiedStorage(settings: { libraryRoot: string; runtimeRoot: string; modelRoot: string }): boolean {
    const runtimeRoot = path.resolve(settings.runtimeRoot)
    const dataRoot = path.dirname(runtimeRoot)
    return path.basename(runtimeRoot).toLowerCase() === 'envs'
      && path.resolve(settings.libraryRoot) === path.join(dataRoot, 'music')
      && path.resolve(settings.modelRoot) === path.join(runtimeRoot, 'models')
  }

  private async ensureWindowsPrerequisites(signal: AbortSignal): Promise<void> {
    if (process.platform !== 'win32') return
    const current = await detectWindowsVcRuntime(runProcess)
    let mode: '/install' | '/repair' = '/install'

    if (current.supported) {
      const audioHost = this.paths.audioHostExecutable()
      if (!existsSync(audioHost)) return
      const selfTest = await runProcess(audioHost, ['--self-test'], { signal, timeoutMs: 30_000 })
      if (selfTest.code === 0) {
        this.update({ windowsVcRuntimeVersion: current.version })
        this.logger.info('Windows native prerequisites ready', { vcRuntime: current.version })
        return
      }
      if (!isWindowsNativeRuntimeError(String(selfTest.code))) return
      mode = '/repair'
      this.logger.warn('Windows native prerequisite self-test failed', { vcRuntime: current.version, code: selfTest.code })
    }

    this.update({
      status: 'installing',
      stage: mode === '/repair' ? '修复 Microsoft Visual C++ x64 运行库（请确认系统授权）' : '安装 Microsoft Visual C++ x64 运行库（请确认系统授权）',
      progress: 0.03
    })
    const installer = await this.ensureVcRuntimeInstaller(signal)
    await this.preparationGate(signal)
    signal.throwIfAborted()
    const result = await systemHelper(['install-vc', installer, mode], 15 * 60_000)
    if (result.code === 1223) throw new Error('VC_RUNTIME_ELEVATION_CANCELLED')
    if (result.code === 3010 || result.code === 1641) throw new Error('VC_RUNTIME_RESTART_REQUIRED')
    if (result.code !== 0) throw new Error(`VC_RUNTIME_INSTALL_FAILED:${result.code}`)

    const installed = await detectWindowsVcRuntime(runProcess)
    if (!installed.supported) throw new Error(`VC_RUNTIME_INSTALL_FAILED:${result.code}`)

    const selfTest = await runProcess(this.paths.audioHostExecutable(), ['--self-test'], { signal, timeoutMs: 30_000 })
    if (selfTest.code !== 0) {
      throw new Error(`VC_RUNTIME_SELF_TEST_FAILED:${selfTest.code}`)
    }
    this.update({ windowsVcRuntimeVersion: installed.version })
    this.logger.info('Windows native prerequisites installed', { vcRuntime: installed.version, installerCode: result.code })
  }

  private async ensureVcRuntimeInstaller(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const bundled = this.paths.packagedResource('prerequisites', VC_RUNTIME_INSTALLER)
    const development = path.join(process.cwd(), 'resources', 'prerequisites', VC_RUNTIME_INSTALLER)
    for (const candidate of [bundled, development]) if (existsSync(candidate) && await this.hasTrustedMicrosoftSignature(candidate)) return candidate
    throw new Error('APPLICATION_COMPONENT_MISSING:Microsoft VC installer')
  }

  private async hasTrustedMicrosoftSignature(filePath: string): Promise<boolean> {
    const result = await systemHelper(['signature', filePath])
    return result.code === 0 && isTrustedMicrosoftSignature(parseAuthenticodeInfo(result.stdout))
  }

  private async ensureUv(signal: AbortSignal): Promise<string> {
    const packaged = this.paths.packagedResource('bin', UV_FILE.output)
    if (existsSync(packaged)) {
      const actualSha256 = await this.fileSha256(packaged)
      if (actualSha256 === UV_BINARY_SHA256) return packaged
      if (isTrustedMacBundle(this.paths.packagedResource())) return packaged
      if (await isTrustedWindowsTool(packaged)) return packaged
      // Distribution signing changes the binary bytes. Never execute an
      // unverified bundled tool: use the pinned, verified cache/download below.
      this.logger.warn('packaged uv checksum differs; using verified standalone uv', {
        expectedSha256: UV_BINARY_SHA256, actualSha256
      })
    }
    const destinationRoot = path.join(this.paths.toolsRoot, 'uv')
    const destination = path.join(destinationRoot, UV_FILE.output)
    if (existsSync(destination)) {
      if (await this.fileSha256(destination) === UV_BINARY_SHA256) return destination
      await rm(destination, { force: true })
    }
    mkdirSync(destinationRoot, { recursive: true })
    const archive = path.join(this.paths.downloadRoot, UV_SOURCE.archive)
    const temporary = `${archive}.part`
    this.update({ status: 'installing', stage: `下载 uv ${RUNTIME_VERSIONS.uv}`, progress: 0.04 })
    const alternate = UV_DOWNLOAD.startsWith('https://github.com/astral-sh/')
      ? UV_DOWNLOAD.replace('https://github.com/', 'https://releases.astral.sh/github/')
      : UV_DOWNLOAD.replace('https://releases.astral.sh/github/', 'https://github.com/')
    try {
      await this.network.download({ id: 'uv', filename: UV_SOURCE.archive, sha256: UV_ARCHIVE_SHA256, urls: [UV_DOWNLOAD, alternate] }, archive, this.database.getSettings().network, signal)
    } catch (error) {
      if (String(error).includes('ARTIFACT_HASH_MISMATCH')) throw new Error('UV_HASH_MISMATCH')
      throw error
    }
    let binary: Buffer | null = null
    if (UV_SOURCE.format === 'zip') {
      const zip = new AdmZip(archive)
      const entry = zip.getEntries().find((candidate) => candidate.entryName.endsWith(UV_FILE.entrySuffix ?? '') || candidate.entryName === UV_FILE.fallbackEntry)
      if (entry && !entry.isDirectory) binary = entry.getData()
    } else if (UV_SOURCE.format === 'tar.gz') {
      binary = tarFile(gunzipSync(await readFile(archive)), UV_FILE.entrySuffix ?? '', UV_FILE.fallbackEntry)
    }
    if (!binary) throw new Error('UV_ARCHIVE_INVALID')
    await writeFile(destination, binary)
    if (process.platform !== 'win32') await chmod(destination, 0o755)
    if (!existsSync(destination)) throw new Error('UV_EXTRACT_FAILED')
    if (await this.fileSha256(destination) !== UV_BINARY_SHA256) {
      await rm(destination, { force: true })
      throw new Error('UV_HASH_MISMATCH')
    }
    return destination
  }

  private async fileSha256(filePath: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(filePath)) hash.update(chunk)
    return hash.digest('hex')
  }

  async runWorker(
    args: string[],
    signal?: AbortSignal,
    timeoutMs = 0,
    onMessage?: (message: WorkerMessage) => void,
    environmentDirectory?: string
  ): Promise<{ code: number; result: Record<string, unknown>; error: string | null }> {
    signal?.throwIfAborted()
    const python = environmentDirectory ? this.pythonIn(environmentDirectory) : this.pythonExecutable()
    if (!existsSync(python)) return { code: -1, result: {}, error: 'PYTHON_MISSING' }
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort()
    signal?.addEventListener('abort', forwardAbort, { once: true })
    let timer: NodeJS.Timeout | undefined
    if (timeoutMs > 0) timer = setTimeout(() => controller.abort(), timeoutMs)
    let lastResult: Record<string, unknown> = {}
    let structuredError: string | null = null
    try {
      const env = args[0] === 'ensure-model'
        ? await this.network.environment(this.environment(), this.database.getSettings().network, 'https://modelscope.cn/') : this.environment()
      const result = await runProcess(python, [this.workerScript(), ...args], {
        env,
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
      return { code: result.code, result: lastResult, error: structuredError ?? (result.code === 0 ? null : result.stderr.slice(-1200) || `PROCESS_EXIT:${result.code}`) }
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }

  spawnWorker(args: string[], signal: AbortSignal, onMessage: (message: WorkerMessage) => void): ReturnType<typeof spawnSafe> {
    const child = spawnSafe(this.pythonExecutable(), [this.workerScript(), ...args], { env: this.environment(), signal })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let pending = ''
    child.stdout.on('data', (chunk: string) => {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = (lines.pop() ?? '').slice(-2 * 1024 * 1024)
      for (const line of lines) {
        try { onMessage(JSON.parse(line) as WorkerMessage) }
        catch { this.logger.info('worker stdout', line) }
      }
    })
    child.stdout.on('end', () => {
      if (!pending) return
      try { onMessage(JSON.parse(pending) as WorkerMessage) } catch { this.logger.info('worker stdout', pending) }
    })
    child.stderr.on('data', (chunk: string) => this.logger.info('worker stderr', chunk))
    return child
  }
}

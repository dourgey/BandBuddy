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
import { activeEnvironment, activateEnvironment, createEnvironment } from './runtime-environments.js'
import { intelSphnRequirement, validateIntelRuntimeLock } from './runtime-wheel-manifest.js'
import { isTrustedWindowsTool } from './windows-tool-integrity.js'
import {
  VC_RUNTIME_DOWNLOAD_URL,
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
const PREREQUISITE_PATH_ENV = 'BANDBUDDY_PREREQUISITE_PATH'
const PREREQUISITE_MODE_ENV = 'BANDBUDDY_PREREQUISITE_MODE'
const AUTHENTICODE_SCRIPT = `$signature=Get-AuthenticodeSignature -LiteralPath $env:${PREREQUISITE_PATH_ENV}; $subject=if($null -eq $signature.SignerCertificate){''}else{$signature.SignerCertificate.Subject}; [Console]::Out.Write((@{status=$signature.Status.ToString();subject=$subject}|ConvertTo-Json -Compress))`
const ELEVATED_INSTALL_SCRIPT = `$ErrorActionPreference='Stop'; try {$process=Start-Process -FilePath $env:${PREREQUISITE_PATH_ENV} -ArgumentList @($env:${PREREQUISITE_MODE_ENV},'/quiet','/norestart') -Verb RunAs -Wait -PassThru; exit $process.ExitCode} catch {[Console]::Error.Write($_.Exception.Message); if($_.Exception.NativeErrorCode -eq 1223){exit 1223}; exit 1}`

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
  private listeners = new Set<RuntimeListener>()
  private installation: AbortController | null = null
  private installationTask: Promise<RuntimeInfo> | null = null
  private detectionTask: Promise<RuntimeInfo> | null = null
  private readonly network = new RuntimeNetwork()
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
      const result = await runProcess('nvidia-smi.exe', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'], { timeoutMs: 8_000 })
      if (result.code !== 0 || !result.stdout.trim()) return null
      const [name = '', driverVersion = '', memory = '0'] = result.stdout.trim().split(/\r?\n/)[0]!.split(',').map((part) => part.trim())
      return { name, driverVersion, memoryMb: Number(memory) || 0 }
    } catch {
      return null
    }
  }

  private async detectCudaVersion(): Promise<string | null> {
    if (process.platform !== 'win32') return null
    try {
      const result = await runProcess('nvidia-smi.exe', [], { timeoutMs: 8_000 })
      if (result.code !== 0) return null
      return /CUDA(?: UMD)? Version:\s*(\d+\.\d+)/i.exec(result.stdout)?.[1] ?? null
    } catch {
      return null
    }
  }

  async detect(): Promise<RuntimeInfo> {
    if (this.installation) return this.getInfo()
    if (this.detectionTask) return this.detectionTask
    const task = this.performDetection()
    this.detectionTask = task
    try { return await task } finally { if (this.detectionTask === task) this.detectionTask = null }
  }

  private async performDetection(): Promise<RuntimeInfo> {
    const settings = this.database.getSettings()
    this.update({
      status: 'detecting', stage: '检测显卡与私有运行环境', progress: null, error: null,
      device: settings.preferredDevice, runtimePath: settings.runtimeRoot, modelPath: settings.modelRoot
    })
    const [gpu, vcRuntime] = process.platform === 'win32'
      ? await Promise.all([this.detectNvidia(), detectWindowsVcRuntime(runProcess)])
      : [null, null]
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
      const probe = await this.runWorker(['probe', '--model-root', settings.modelRoot, '--quick'], undefined, 90_000)
      if (probe.code !== 0) throw new Error(probe.error ?? '运行环境自检失败')
      const data = probe.result
      selectedDevice = selectComputeDevice(settings.preferredDevice, process.platform, {
        nvidiaDetected: gpu !== null,
        cudaAvailable: Boolean(data.cudaAvailable),
        mpsAvailable: Boolean(data.mpsAvailable)
      })
      const ready = Boolean(data.modelReady && data.dependenciesReady)
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
      this.logger.warn('runtime detection failed', error)
      this.update({
        status: 'failed', stage: '运行环境损坏，可尝试修复', progress: null, gpu, selectedDevice,
        error: isWindowsNativeRuntimeError(error) ? 'WINDOWS_NATIVE_RUNTIME_FAILED' : String(error)
      })
    }
    return this.getInfo()
  }

  async install(): Promise<RuntimeInfo> {
    if (this.installationTask) return this.installationTask
    const task = this.performInstall()
    this.installationTask = task
    try { return await task } finally { if (this.installationTask === task) this.installationTask = null }
  }

  private async performInstall(): Promise<RuntimeInfo> {
    if (this.installation) return this.getInfo()
    const controller = new AbortController()
    this.installation = controller
    const settings = this.database.getSettings()
    let candidate: string | null = null
    let activated = false
    let previousInfo = this.getInfo()
    try {
      await this.detectionTask
      previousInfo = this.getInfo()
      controller.signal.throwIfAborted()
      mkdirSync(settings.runtimeRoot, { recursive: true })
      mkdirSync(settings.modelRoot, { recursive: true })
      candidate = await createEnvironment(settings.runtimeRoot)
      this.update({ status: 'installing', stage: '检查系统运行库', progress: 0.01, error: null })
      await this.ensureWindowsPrerequisites(controller.signal)
      this.update({ status: 'installing', stage: '准备安装工具', progress: 0.08, error: null })
      const uv = await this.ensureUv(controller.signal)
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
        if (!fallbackNetwork || controller.signal.aborted) throw error
        env = await this.network.environment(env, fallbackNetwork, 'https://pypi.org/simple')
        await run(['pip', 'install', '--python', this.pythonIn(candidate), '--only-binary', binaryPackages, '--default-index', 'https://pypi.org/simple', '--torch-backend', backend, ...packageArguments], '镜像暂不可用，正在从官方源安装分轨组件', 0.32)
      }

      this.update({ status: 'downloadingModel', stage: '下载并校验分轨资源', progress: 0.78 })
      const modelArgs = ['ensure-model', '--model-root', settings.modelRoot]
      const model = await this.runWorker(modelArgs, controller.signal, 0, (message) => {
        if (typeof message.progress === 'number') this.update({ progress: 0.78 + message.progress * 0.14 })
        if (message.message) this.update({ stage: message.message })
      }, candidate)
      if (model.code !== 0) throw new Error(model.error ?? 'MODEL_INSTALL_FAILED')

      this.update({ status: 'verifying', stage: '执行 Torch 与短推理自检', progress: 0.94 })
      const detected = await this.detectAfterInstall(controller.signal, candidate)
      controller.signal.throwIfAborted()
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
      if (candidate && !activated) await rm(candidate, { recursive: true, force: true }).catch(error => this.logger.warn('incomplete environment cleanup failed', error))
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
  }

  async repair(): Promise<RuntimeInfo> {
    this.cancelInstall()
    await this.installationTask
    return await this.install()
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
        rm(path.join(settings.runtimeRoot, 'managed-python'), { recursive: true, force: true })
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
      if (!existsSync(audioHost)) throw new Error('AUDIO_HOST_MISSING')
      const selfTest = await runProcess(audioHost, ['--self-test'], { signal, timeoutMs: 30_000 })
      if (selfTest.code === 0) {
        this.update({ windowsVcRuntimeVersion: current.version })
        this.logger.info('Windows native prerequisites ready', { vcRuntime: current.version })
        return
      }
      mode = '/repair'
      this.logger.warn('Windows native prerequisite self-test failed', { vcRuntime: current.version, code: selfTest.code })
    }

    this.update({
      status: 'installing',
      stage: mode === '/repair' ? '修复 Microsoft Visual C++ x64 运行库（请确认系统授权）' : '安装 Microsoft Visual C++ x64 运行库（请确认系统授权）',
      progress: 0.03
    })
    const installer = await this.ensureVcRuntimeInstaller(signal)
    const result = await runProcess('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-Command', ELEVATED_INSTALL_SCRIPT
    ], { env: { ...process.env, [PREREQUISITE_PATH_ENV]: installer, [PREREQUISITE_MODE_ENV]: mode } })
    if (result.code === 1223) throw new Error('VC_RUNTIME_ELEVATION_CANCELLED')

    const installed = await detectWindowsVcRuntime(runProcess)
    if (!installed.supported) throw new Error(`VC_RUNTIME_INSTALL_FAILED:${result.code}`)

    const selfTest = await runProcess(this.paths.audioHostExecutable(), ['--self-test'], { signal, timeoutMs: 30_000 })
    if (selfTest.code !== 0) {
      if (result.code === 3010 || result.code === 1641) throw new Error('VC_RUNTIME_RESTART_REQUIRED')
      throw new Error(`VC_RUNTIME_SELF_TEST_FAILED:${selfTest.code}`)
    }
    this.update({ windowsVcRuntimeVersion: installed.version })
    this.logger.info('Windows native prerequisites installed', { vcRuntime: installed.version, installerCode: result.code })
  }

  private async ensureVcRuntimeInstaller(signal: AbortSignal): Promise<string> {
    const root = path.join(this.paths.downloadRoot, 'prerequisites')
    const destination = path.join(root, VC_RUNTIME_INSTALLER)
    mkdirSync(root, { recursive: true })
    if (existsSync(destination) && await this.hasTrustedMicrosoftSignature(destination)) return destination
    if (existsSync(destination)) await rm(destination, { force: true })

    const temporary = `${destination}.part`
    await rm(temporary, { force: true })
    this.update({ status: 'installing', stage: '从微软下载 Visual C++ x64 运行库', progress: 0.02 })
    try {
      await writeFile(temporary, await this.network.bytes([VC_RUNTIME_DOWNLOAD_URL], this.database.getSettings().network, signal))
      if (!await this.hasTrustedMicrosoftSignature(temporary)) throw new Error('VC_RUNTIME_SIGNATURE_INVALID')
      await rename(temporary, destination)
      return destination
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  private async hasTrustedMicrosoftSignature(filePath: string): Promise<boolean> {
    const result = await runProcess('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-Command', AUTHENTICODE_SCRIPT
    ], { env: { ...process.env, [PREREQUISITE_PATH_ENV]: filePath }, timeoutMs: 30_000 })
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
    const bytes = await this.network.bytes([UV_DOWNLOAD, alternate], this.database.getSettings().network, signal)
    await writeFile(temporary, bytes)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== UV_ARCHIVE_SHA256) {
      await rm(temporary, { force: true })
      throw new Error('UV_HASH_MISMATCH')
    }
    await rename(temporary, archive)
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
      return { code: result.code, result: lastResult, error: structuredError ?? (result.code === 0 ? null : result.stderr.slice(-1200)) }
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

import { app, dialog, safeStorage } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'
import { MUSCRIPTOR_REVISION, type ScoreModel, type ScoreRuntime } from '@shared/scores.js'
import type { AppPaths } from './paths.js'
import type { BandBuddyDatabase } from './database.js'
import { RuntimeManager, RUNTIME_VERSIONS } from './runtime.js'
import { RuntimeNetwork } from './runtime-network.js'
import { ArtifactDownloader, artifactValid, fileDigest, writeJsonAtomic, type Artifact } from './artifact-download.js'
import { runProcess, processFailure } from './process.js'
import { chooseRuntimeProfile, loadRuntimeProfiles } from './runtime-catalog.js'

interface ModelManifest { revision: string; size: number; sha256: string; config: Record<string, number> }
const FONT_SHA = '5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3'
const LICENSE_ACCEPTANCE = `CC-BY-NC-4.0:${MUSCRIPTOR_REVISION}`
export class ScoreRuntimeManager {
  private network = new RuntimeNetwork()
  private controller: AbortController | null = null
  private task: Promise<void> | null = null
  private state = { busy: false, stage: '首次使用需准备转谱组件与模型', progress: null as number | null, error: null as string | null }
  constructor(private paths: AppPaths, private db: BandBuddyDatabase, private runtime: RuntimeManager, private changed: () => void) {}
  get root(): string { return path.join(this.db.getSettings().runtimeRoot, 'scores') }
  get modelRoot(): string { return path.join(this.db.getSettings().modelRoot, 'muscriptor') }
  get fontPath(): string { return path.join(this.modelRoot, 'MuseScore_General.sf3') }
  resource(...parts: string[]): string { return app.isPackaged ? this.paths.packagedResource(...parts) : path.resolve('resources', ...parts) }
  private config(key: string): string | undefined { return (this.db.sqlite.prepare('SELECT value FROM score_config WHERE key = ?').get(key) as { value: string } | undefined)?.value }
  private setConfig(key: string, value: string): void { this.db.sqlite.prepare('INSERT INTO score_config(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value) }
  private manifests(): Record<ScoreModel, ModelManifest> { return JSON.parse(readFileSync(this.resource('score-runtime', 'models.json'), 'utf8')) }
  weights(model: ScoreModel): string { return path.join(this.modelRoot, model, 'model.safetensors') }
  python(): string {
    // Data migration retains old Python environments because venvs contain absolute paths.
    const saved = this.config('environment-root')
    const roots = [this.root, ...(saved && path.isAbsolute(saved) && path.basename(saved) === 'scores' ? [saved] : [])]
    for (const root of roots) try {
      const { directory, lockFile, lockHash } = JSON.parse(readFileSync(path.join(root, 'active.json'), 'utf8')) as { directory: string; lockFile: string; lockHash: string }
      if (!/^env-[0-9a-f-]{36}$/.test(directory)) throw new Error('INVALID_SCORE_ENVIRONMENT')
      if (!/^(win32-x64-cu1(?:28|30)|win32-x64-cpu|darwin-(?:arm64|x64)-cpu)\.lock$/.test(lockFile) || createHash('sha256').update(readFileSync(this.resource('score-runtime', lockFile))).digest('hex') !== lockHash) throw new Error('SCORE_ENVIRONMENT_UPDATE_REQUIRED')
      const python = path.join(root, directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      if (existsSync(python)) return python
    } catch { /* Try the preserved pre-migration environment. */ }
    return path.join(this.root, 'missing-python')
  }
  get(): ScoreRuntime {
    const manifests = this.manifests()
    const models = Object.fromEntries((['small', 'medium', 'large'] as const).map(model => {
      try {
        const marker = JSON.parse(readFileSync(path.join(this.modelRoot, model, 'verified.json'), 'utf8'))
        const stat = statSync(this.weights(model))
        return [model, marker.sha256 === manifests[model].sha256 && stat.size === manifests[model].size && stat.mtimeMs === marker.mtimeMs]
      } catch { return [model, false] }
    })) as Record<ScoreModel, boolean>
    const ready = existsSync(this.python()), soundfont = existsSync(this.fontPath)
    const stage = !this.state.busy && !this.state.error && ready && soundfont && Object.values(models).some(Boolean)
      ? '转谱组件已就绪 · 可离线使用' : this.state.stage
    return { ...this.state, stage, ready, models, device: this.runtime.getInfo().selectedDevice,
      soundfont, accepted: this.config('license') === LICENSE_ACCEPTANCE, hasToken: Boolean(this.config('hf-token')) }
  }
  private update(stage: string, progress: number | null): void { this.state.stage = stage; this.state.progress = progress; this.changed() }
  async prepare(input: { acceptLicense: boolean; token?: string; model: ScoreModel; importLocal?: boolean }): Promise<ScoreRuntime> {
    if (this.state.busy) throw new Error('转谱组件正在准备中')
    if (!input.acceptLicense && !this.get().accepted) throw new Error('请先阅读并接受模型的非商业许可及访问条件')
    if (input.acceptLicense) this.setConfig('license', LICENSE_ACCEPTANCE)
    if (input.token !== undefined && input.token.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储不可用，无法安全保存 Token')
      this.setConfig('hf-token', safeStorage.encryptString(input.token.trim()).toString('base64'))
    }
    let imported: string | undefined
    if (input.importLocal) {
      const selected = await dialog.showOpenDialog({ title: `导入 ${input.model} 模型目录`, properties: ['openDirectory'] })
      if (selected.canceled || !selected.filePaths[0]) return this.get()
      imported = path.join(selected.filePaths[0], 'model.safetensors')
      if (!existsSync(imported)) throw new Error('目录中没有 model.safetensors')
    }
    if (this.state.busy) throw new Error('另一项转谱组件准备正在进行，请稍后重试')
    this.controller = new AbortController()
    this.state = { busy: true, stage: '检查转谱组件', progress: 0, error: null }
    const signal = this.controller.signal
    this.task = this.install(input.model, imported, signal).catch(error => {
      this.state.error = signal.aborted ? null : String(error).replace(/hf_[A-Za-z0-9]+/g, '<redacted>')
      this.update(signal.aborted ? '准备已取消，已下载内容可继续使用' : '准备失败，可重试', null)
    }).finally(() => { this.controller = null; this.state.busy = false; this.changed() })
    this.changed()
    return this.get()
  }
  cancel(): void { this.controller?.abort() }
  async shutdown(): Promise<void> { this.cancel(); await this.task; this.network.close() }
  async environment(): Promise<NodeJS.ProcessEnv> {
    const settings = this.db.getSettings()
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1',
      UV_CACHE_DIR: path.join(this.paths.cacheRoot, 'uv'), UV_PYTHON_INSTALL_DIR: path.join(this.root, 'python'),
      ...(settings.network.pythonInstallMirror ? { UV_PYTHON_INSTALL_MIRROR: settings.network.pythonInstallMirror } : {}),
      BANDBUDDY_CPU_THREADS: String(Math.max(1, Math.min(8, availableParallelism() - 1))) }
    delete env.PYTHONPATH; delete env.PYTHONHOME
    return this.network.environment(env, settings.network)
  }
  private async install(model: ScoreModel, imported: string | undefined, signal: AbortSignal): Promise<void> {
    await mkdir(this.root, { recursive: true }); await mkdir(this.modelRoot, { recursive: true })
    const network = this.db.getSettings().network
    const manifest = this.manifests()[model]
    const target = this.weights(model)
    await mkdir(path.dirname(target), { recursive: true })
    // Fetch gated files before spending time installing a runtime; never bypass access approval.
    this.update('校验／下载转谱模型', .05)
    const artifact: Artifact = { id: `muscriptor-${model}`, filename: 'model.safetensors', sha256: manifest.sha256, size: manifest.size,
      urls: [`https://huggingface.co/MuScriptor/muscriptor-${model}/resolve/${manifest.revision}/model.safetensors`] }
    if (imported) {
      if (await fileDigest(imported) !== manifest.sha256) throw new Error('模型与所选版本不匹配，或文件校验失败')
      signal.throwIfAborted()
      const temporary = `${target}.${randomUUID()}.part`
      try { await copyFile(imported, temporary); signal.throwIfAborted(); await rename(temporary, target) }
      finally { await rm(temporary, { force: true }) }
    } else if (!await artifactValid(target, artifact)) {
      const encrypted = this.config('hf-token')
      const token = encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : ''
      const downloader = new ArtifactDownloader(async (url, options) => {
        const headers = new Headers(options.headers)
        if (token && new URL(url).hostname === 'huggingface.co') headers.set('Authorization', `Bearer ${token}`)
        const response = await this.network.fetch(url, network, { ...options, headers })
        if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new Error('HF_AUTH_REQUIRED:请在 Hugging Face 接受该模型的访问条件，并填写有读取权限的 Token；也可导入已下载模型。') }
        return response
      })
      await downloader.download(artifact, target, signal, p => this.update('下载转谱模型', .05 + .5 * p.received / manifest.size))
    }
    await writeJsonAtomic(path.join(path.dirname(target), 'config.json'), manifest.config)
    await writeJsonAtomic(path.join(path.dirname(target), 'verified.json'), { sha256: manifest.sha256, mtimeMs: statSync(target).mtimeMs })
    const probeEnv = await this.environment()
    const probe = existsSync(this.python()) ? await runProcess(this.python(), ['-c', 'import torch, mido, safetensors, soundfile, beat_this, huggingface_hub, psutil'], { env: probeEnv, signal, timeoutMs: 90_000 }) : null
    if (!probe || probe.code !== 0) {
      this.update('安装独立转谱运行环境', .58)
      await this.runtime.verifyNativePrerequisites(signal)
      const uv = await this.runtime.ensureUv(signal), env = await this.environment()
      const directory = `env-${randomUUID()}`, candidate = path.join(this.root, directory)
      const python = path.join(candidate, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      const run = async (args: string[]): Promise<void> => {
        const result = await runProcess(uv, args, { env, signal, timeoutMs: 40 * 60_000, stage: 'score-environment', maxOutputChars: 16000 })
        if (result.code !== 0) throw processFailure(result, 'SCORE_RUNTIME_INSTALL_FAILED')
      }
      const base = this.runtime.pythonExecutable()
      try {
      await run(['venv', candidate, '--python', existsSync(base) ? base : RUNTIME_VERSIONS.python, '--python-preference', 'only-managed', '--no-project'])
      const backend = process.platform === 'win32' ? chooseRuntimeProfile(await loadRuntimeProfiles(process.resourcesPath ?? ''), this.db.getSettings().preferredDevice, await this.runtime.detectGpuCompatibility()).backend : 'cpu'
      const requirements = this.resource('score-runtime', `${process.platform}-${process.arch}-${backend}.lock`)
      await run(['pip', 'sync', '--python', python, '--only-binary', ':all:', '--require-hashes', '--torch-backend', backend, '--default-index', network.pythonIndexUrl || 'https://pypi.org/simple', requirements])
      const check = await runProcess(python, ['-c', 'import torch, mido, safetensors, soundfile, beat_this, huggingface_hub, psutil; print(torch.__version__)'], { env, signal, timeoutMs: 90_000 })
      if (check.code !== 0) throw new Error('转谱环境验证失败，请重试')
      await writeJsonAtomic(path.join(this.root, 'active.json'), { directory, lockFile: path.basename(requirements), lockHash: await fileDigest(requirements) })
      this.setConfig('environment-root', this.root)
      } catch (error) {
        await rm(candidate, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    }
    this.update('准备播放音色与节拍模型', .9)
    await this.network.download({ id: 'score-soundfont', filename: 'MuseScore_General.sf3', sha256: FONT_SHA,
      urls: ['https://huggingface.co/MuScriptor/assets/resolve/main/MuseScore_General.sf3'] }, this.fontPath, network, signal)
    await this.beatCheckpoint(signal)
    this.state.error = null; this.update('转谱组件已就绪 · 可离线使用', 1)
  }
  async beatCheckpoint(signal: AbortSignal): Promise<string> {
    const manifest = JSON.parse(await readFile(this.resource('beat-this', 'manifest.json'), 'utf8')) as { model: Artifact }
    const target = path.join(this.db.getSettings().modelRoot, 'beat-this', manifest.model.filename)
    await mkdir(path.dirname(target), { recursive: true })
    return this.network.download(manifest.model, target, this.db.getSettings().network, signal)
  }
  async validate(model: ScoreModel): Promise<void> {
    if (!this.get().ready) throw new Error('SCORE_RUNTIME_MISSING:请先准备转谱组件')
    const m = this.manifests()[model]
    if (!await artifactValid(this.weights(model), m)) throw new Error('SCORE_MODEL_MISSING:请下载或导入所选模型')
  }
}

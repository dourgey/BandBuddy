import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { PluginCatalog, PluginDefinition, PluginParameter, PluginRuntimeState } from '@shared/audio-plugins.js'
import type { PreparedEffects } from '@shared/arsenal.js'
import type { AppPaths } from './paths.js'
import { spawnSafe } from './process.js'

export function defaultPluginDirectories(platform = process.platform): string[] {
  return platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA ?? homedir(), 'Programs', 'Common', 'VST3'), path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Common Files', 'VST3')]
    : [path.join(homedir(), 'Library/Audio/Plug-Ins/VST3'), '/Library/Audio/Plug-Ins/VST3']
}
async function digest(file: string): Promise<string> {
  const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex')
}
async function fingerprint(file: string): Promise<string> {
  const info = await stat(file)
  if (info.isFile()) return digest(file)
  const target = process.platform === 'win32' ? path.join(file, 'Contents', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-win`) : path.join(file, 'Contents/MacOS')
  const hash = createHash('sha256')
  for (const entry of (await readdir(target)).sort()) { hash.update(entry); hash.update(await digest(path.join(target, entry))) }
  return hash.digest('hex')
}
async function atomicJson(file: string, data: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(data, null, 2)); await rename(temporary, file)
}
async function discover(root: string, output: string[], depth = 0): Promise<void> {
  if (depth > 8 || output.length > 4096) return
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const file = path.join(root, entry.name)
    if (entry.name.toLowerCase().endsWith('.vst3')) output.push(file)
    else if (entry.isDirectory()) await discover(file, output, depth + 1)
  }
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export class PluginWorker {
  readonly mapping: string
  sourceGraph: PreparedEffects['pluginGraph']
  private child: ChildProcessWithoutNullStreams | null = null
  private sequence = 0
  private pending = new Map<number, Pending>()
  private failure: string | null = null
  private exited = false
  private readyResolve: ((value: unknown) => void) | undefined
  private readyReject: ((error: Error) => void) | undefined
  private readyTimer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly executable: string, readonly directory: string) { this.mapping = path.join(directory, 'audio.shm') }
  async start(graph: unknown, sampleRate: number): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const manifest = path.join(this.directory, 'session.json')
    await writeFile(manifest, JSON.stringify({ mapping: this.mapping, generation: Date.now(), graph, sampleRate }))
    const ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve; this.readyReject = reject
      this.readyTimer = setTimeout(() => { this.failure = '插件启动超时'; this.child?.kill(); reject(new Error(this.failure)) }, 30_000)
    })
    this.child = spawnSafe(this.executable, ['--worker', manifest])
    this.child.stdout.setEncoding('utf8'); this.child.stderr.setEncoding('utf8')
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      if (line.length > 2 * 1024 * 1024) { this.child?.kill(); return }
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.event === 'ready') {
        clearTimeout(this.readyTimer)
        if (message.data?.protocol !== 1) { this.readyReject?.(new Error('PLUGIN_PROTOCOL_MISMATCH')); this.child?.kill() }
        else this.readyResolve?.(message.data)
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.result); else pending.reject(new Error(message.error ?? 'PLUGIN_COMMAND_FAILED'))
    })
    let stderr = ''
    this.child.stderr.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-4000) })
    const fail = (error: Error): void => {
      this.failure = error.message; this.exited = true; clearTimeout(this.readyTimer); this.readyReject?.(error)
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) } this.pending.clear()
    }
    this.child.once('error', fail)
    this.child.once('exit', (code, signal) => { lines.close(); fail(new Error(`PLUGIN_WORKER_EXITED:${code ?? signal}:${stderr}`)) })
    try { await ready } catch (error) { await this.stop(); throw error }
  }
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.child || this.exited) throw new Error(this.failure ?? '插件处理进程未启动')
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.failure = `PLUGIN_WORKER_TIMEOUT:${method}`; this.child?.kill(); reject(new Error(this.failure)) }, 5000)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (!error) return; clearTimeout(timer); this.pending.delete(id); reject(error)
      })
    })
  }
  async status(): Promise<PluginRuntimeState> {
    if (this.exited) return { active: false, fault: true, error: this.failure, latencyFrames: 0, restarts: 0 }
    try { const status = await this.request<{ fault: number; error: string; latencyFrames: number }>('status'); return { active: true, fault: Boolean(status.fault), error: status.error || null, latencyFrames: status.latencyFrames, restarts: 0 } }
    catch (error) { return { active: false, fault: true, error: String(error), latencyFrames: 0, restarts: 0 } }
  }
  async stop(): Promise<void> {
    const child = this.child
    if (child && !this.exited) await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { child.kill() }, 1500)
      const finalTimeout = setTimeout(resolve, 3000)
      child.once('exit', () => { clearTimeout(timeout); clearTimeout(finalTimeout); resolve() }); child.stdin.end()
    })
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

export class AudioPluginService {
  private catalog: PluginCatalog | null = null
  private scanning: Promise<PluginCatalog> | null = null
  private current: PluginWorker | null = null
  private root: string
  private executable: string
  private watchdog: ReturnType<typeof setInterval> | undefined
  private checking = false
  private stopping: Promise<void> = Promise.resolve()
  constructor(private readonly paths: AppPaths, private readonly occupied: () => boolean = () => false) {
    this.root = path.join(paths.dataRoot ?? path.dirname(paths.audioHostExecutable()), 'audio-plugins')
    this.executable = path.join(path.dirname(paths.audioHostExecutable()), process.platform === 'win32' ? 'bandbuddy-plugin-host.exe' : 'bandbuddy-plugin-host')
  }
  async list(): Promise<PluginCatalog> {
    if (!this.catalog) {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      try { const stored = JSON.parse(await readFile(path.join(this.root, 'catalog.json'), 'utf8')) as PluginCatalog; if (stored.version !== 1) throw new Error(); this.catalog = stored }
      catch { this.catalog = { version: 1, plugins: [], directories: [], failures: [] } }
    }
    return structuredClone(this.catalog)
  }
  async addDirectory(directory: string): Promise<PluginCatalog> {
    const catalog = await this.list(); const resolved = path.resolve(directory)
    if (!catalog.directories.includes(resolved)) catalog.directories.push(resolved)
    await this.persist(catalog); return catalog
  }
  private async persist(catalog: PluginCatalog): Promise<void> {
    await atomicJson(path.join(this.root, 'catalog.json'), catalog); this.catalog = catalog
  }
  scan(retryFailed = false): Promise<PluginCatalog> {
    if (this.scanning) return this.scanning
    this.scanning = this.scanNow(retryFailed).finally(() => { this.scanning = null }); return this.scanning
  }
  private async scanNow(retryFailed: boolean): Promise<PluginCatalog> {
    if (this.current || this.occupied()) throw new Error('请先停止录音和监听，再扫描插件')
    if (!existsSync(this.executable)) throw new Error('PLUGIN_HOST_MISSING')
    const old = await this.list(), candidates: string[] = [], plugins: PluginDefinition[] = [], failures: PluginCatalog['failures'] = []
    for (const root of [...defaultPluginDirectories(), ...old.directories]) await discover(root, candidates)
    const units = process.platform === 'darwin' ? await this.scanOne('', '--list-au') : []
    for (const unit of units) candidates.push(unit.path)
    const candidateHash = async (candidate: string): Promise<string> => candidate.startsWith('au:')
      ? createHash('sha256').update(JSON.stringify(units.find(p => p.path === candidate))).digest('hex') : fingerprint(candidate)
    const marker = path.join(this.root, 'scanning.json')
    try { const interrupted = JSON.parse(await readFile(marker, 'utf8')); old.failures.push({ ...interrupted, reason: '上次扫描中断，已隔离', checkedAt: new Date().toISOString() }) } catch { /* no interrupted scan */ }
    for (const candidate of [...new Set(candidates)]) {
      if (this.current || this.occupied()) throw new Error('音频会话已开始，插件扫描已暂停；原目录已保留')
      let hash = ''
      try {
        hash = await candidateHash(candidate)
        const quarantined = old.failures.find(f => f.path === candidate && f.fingerprint === hash)
        if (quarantined && !retryFailed) { failures.push(quarantined); continue }
        const cached = old.plugins.filter(p => p.path === candidate && p.fingerprint === hash && p.architecture === process.arch)
        if (cached.length && !retryFailed) { plugins.push(...cached); continue }
        await atomicJson(marker, { path: candidate, fingerprint: hash })
        const found = await this.scanOne(candidate.startsWith('au:') ? candidate.slice(3) : candidate, candidate.startsWith('au:') ? '--scan-au' : '--scan')
        plugins.push(...found.map(p => ({ ...p, fingerprint: hash, architecture: process.arch })))
      } catch (error) { failures.push({ path: candidate, fingerprint: hash, reason: String(error), checkedAt: new Date().toISOString() }) }
      await rm(marker, { force: true })
    }
    const seen = new Set<string>()
    const catalog: PluginCatalog = { ...old, failures, plugins: plugins.filter(p => { const key = `${p.format}:${p.pluginId}`; if (seen.has(key)) return false; seen.add(key); return true }) }
    await this.persist(catalog); return catalog
  }
  private scanOne(candidate: string, operation = '--scan'): Promise<PluginDefinition[]> {
    return new Promise((resolve, reject) => {
      const child = spawnSafe(this.executable, [operation, ...(candidate ? [candidate] : [])]); let stdout = '', stderr = '', timedOut = false
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      const timer = setTimeout(() => { timedOut = true; child.kill() }, 20_000)
      child.stdout.on('data', bytes => { stdout += String(bytes); if (stdout.length > 4 * 1024 * 1024) child.kill() })
      child.stderr.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-4000) })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => {
        clearTimeout(timer)
        if (timedOut) { reject(new Error('PLUGIN_SCAN_TIMEOUT')); return }
        if (code !== 0) { reject(new Error(`PLUGIN_SCAN_FAILED:${code}:${stderr}`)); return }
        try { const line = stdout.trim().split(/\r?\n/).findLast(line => line.startsWith('[')); const result = JSON.parse(line ?? 'null'); if (!Array.isArray(result)) throw new Error('PLUGIN_SCAN_RESPONSE_INVALID'); resolve(result) } catch (error) { reject(error) }
      })
    })
  }
  async resolveGraph(prepared: PreparedEffects): Promise<unknown> {
    const graph = prepared.pluginGraph
    if (!graph) throw new Error('PLUGIN_GRAPH_MISSING')
    const catalog = await this.list()
    const units = graph.nodes.some(n => n.kind === 'plugin' && n.format === 'auv2') ? await this.scanOne('', '--list-au') : []
    const nodes = await Promise.all(graph.nodes.map(async node => {
      if (node.kind === 'builtin') return node
      const definition = catalog.plugins.find(p => p.format === node.format && p.pluginId === node.pluginId)
      if (!definition) throw new Error(`缺失插件：${node.name}；已保留节点与原状态`)
      if (definition.validation !== 'available') throw new Error(definition.failureReason ?? '插件不可用')
      const actual = definition.format === 'auv2' ? createHash('sha256').update(JSON.stringify(units.find(p => p.path === definition.path)) ?? '').digest('hex') : await fingerprint(definition.path)
      if (definition.fingerprint !== node.fingerprint || actual !== node.fingerprint) throw new Error(`插件版本已变化，请重新扫描并明确替换：${node.name}`)
      const statePath = node.stateHash ? path.join(this.root, 'states', `${node.stateHash}.bin`) : null
      if (statePath && (!existsSync(statePath) || await digest(statePath) !== node.stateHash)) throw new Error(`插件状态缺失或校验失败：${node.name}`)
      return { ...node, path: definition.path, statePath }
    }))
    return { ...graph, nodes }
  }
  async prepare(prepared: PreparedEffects | undefined, rate: number): Promise<PluginWorker | null> {
    if (!prepared?.pluginGraph) return null
    const sourceGraph = prepared.pluginGraph
    const nodes = await Promise.all(sourceGraph.nodes.map(async node => {
      if (node.kind !== 'plugin') return node
      const previous = this.current?.sourceGraph?.nodes.find(p => p.kind === 'plugin' && p.id === node.id)
      // Preserve live editor changes during unrelated chain edits. A new preset
      // hash is deliberate and must not be replaced with the old instance state.
      if (previous?.kind === 'plugin' && previous.pluginId === node.pluginId && previous.fingerprint === node.fingerprint && previous.stateHash === node.stateHash) {
        return { ...node, stateHash: await this.save(node.id) }
      }
      return node
    }))
    const graph = await this.resolveGraph({ ...prepared, pluginGraph: { ...sourceGraph, nodes } })
    const worker = new PluginWorker(this.executable, path.join(this.root, 'sessions', randomUUID()))
    worker.sourceGraph = sourceGraph
    await worker.start(graph, rate); return worker
  }
  async commit(worker: PluginWorker | null): Promise<void> {
    const old = this.current; this.current = worker
    clearInterval(this.watchdog)
    if (worker) this.watchdog = setInterval(() => {
      if (this.checking) return
      this.checking = true; void worker.status().finally(() => { this.checking = false })
    }, 2000)
    if (old && old !== worker) await old.stop()
  }
  async stop(): Promise<void> {
    clearInterval(this.watchdog)
    const current = this.current; this.current = null
    this.stopping = this.stopping.then(async () => { if (current) await current.stop() })
    await this.stopping
  }
  async editor(instanceId: string, open: boolean): Promise<void> { await this.requireWorker().request('editor', { instanceId, open }) }
  async parameters(instanceId: string): Promise<PluginParameter[]> { return this.requireWorker().request('parameters', { instanceId }) }
  async parameter(instanceId: string, parameterId: number, value: number): Promise<void> { await this.requireWorker().request('parameter', { instanceId, parameterId, value }) }
  async save(instanceId: string): Promise<string> {
    const root = path.join(this.root, 'states'); await mkdir(root, { recursive: true })
    const temporary = path.join(root, `${randomUUID()}.bin`)
    try { await this.requireWorker().request('save', { instanceId, path: temporary }); const hash = await digest(temporary); const destination = path.join(root, `${hash}.bin`); if (!existsSync(destination)) await rename(temporary, destination); return hash }
    finally { await rm(temporary, { force: true }) }
  }
  async status(): Promise<PluginRuntimeState> { return this.current ? this.current.status() : { active: false, fault: false, error: null, latencyFrames: 0, restarts: 0 } }
  private requireWorker(): PluginWorker { if (!this.current) throw new Error('请先开启效果监听'); return this.current }
  executablePath(): string { return this.executable }
  async exportStates(hashes: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {}; let total = 0
    for (const hash of new Set(hashes)) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('PLUGIN_STATE_HASH_INVALID')
      const file = path.join(this.root, 'states', `${hash}.bin`)
      const bytes = await readFile(file); total += bytes.length
      if (total > 128 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('PLUGIN_STATE_INVALID')
      result[hash] = bytes.toString('base64')
    }
    return result
  }
  async importStates(input: unknown): Promise<void> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('PLUGIN_STATES_INVALID')
    const states: Array<[string, Buffer]> = []; let total = 0
    for (const [hash, encoded] of Object.entries(input)) {
      if (!/^[a-f0-9]{64}$/.test(hash) || typeof encoded !== 'string') throw new Error('PLUGIN_STATE_INVALID')
      const bytes = Buffer.from(encoded, 'base64'); total += bytes.length
      if (bytes.length > 64 * 1024 * 1024 || total > 128 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('PLUGIN_STATE_INVALID')
      states.push([hash, bytes])
    }
    const root = path.join(this.root, 'states'); await mkdir(root, { recursive: true })
    for (const [hash, bytes] of states) {
      const target = path.join(root, `${hash}.bin`)
      if (existsSync(target)) continue
      const temporary = `${target}.${randomUUID()}.tmp`; await writeFile(temporary, bytes); await rename(temporary, target)
    }
  }
}

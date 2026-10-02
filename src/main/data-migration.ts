import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AppSettings } from '@shared/domain.js'
import { linkMigratedEnvironment } from './runtime-environments.js'

const inside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child)
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
interface Entry { relative: string; size: number; modified: number }
async function inventory(root: string, relative = ''): Promise<Entry[]> {
  const entries: Entry[] = []
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, item.name)
    if (item.isSymbolicLink()) throw new Error(`数据目录包含符号链接，请先恢复为实际文件：${name}`)
    if (item.isDirectory()) entries.push(...await inventory(root, name))
    else if (item.isFile()) {
      const stat = await lstat(path.join(root, name))
      entries.push({ relative: name, size: stat.size, modified: stat.mtimeMs })
    } else throw new Error(`数据目录包含不能迁移的特殊文件：${name}`)
  }
  return entries
}

/** Copy and verify first. Old roots remain intact, including absolute-path Python environments. */
export async function migrateDataRoots(previous: AppSettings, next: AppSettings, save: () => void): Promise<void> {
  const pairs = ([['libraryRoot', '曲库'], ['modelRoot', '模型']] as const)
    .filter(([key]) => path.resolve(previous[key]) !== path.resolve(next[key]))
  const runtimeChanged = path.resolve(previous.runtimeRoot) !== path.resolve(next.runtimeRoot)
  if (!pairs.length && !runtimeChanged) { save(); return }
  const stages: Array<{ stage: string; destination: string; installed: boolean; existed: boolean }> = []
  let createdRuntime = false
  let pointerWritten: string | null = null
  try {
    if (runtimeChanged) createdRuntime = !await exists(next.runtimeRoot)
    // Resolve parents to reject symlink aliases and recursive copies as well as lexical nesting.
    const plans = [] as Array<{ source: string; destination: string; entries: Entry[]; existed: boolean }>
    for (const [key, label] of pairs) {
      const source = await realpath(previous[key]).catch(() => { throw new Error(`${label}原目录不可访问，请连接原磁盘后重试；原配置和数据已保留。`) })
      const requested = path.resolve(next[key])
      await mkdir(path.dirname(requested), { recursive: true })
      const destination = path.join(await realpath(path.dirname(requested)), path.basename(requested))
      if (inside(source, destination) || inside(destination, source)) throw new Error(`${label}新旧目录不能相同或相互包含。`)
      const existed = await exists(destination)
      if (existed && ((await lstat(destination)).isSymbolicLink() || (await readdir(destination)).length)) throw new Error(`${label}目标目录不是空目录，请选择一个新的数据目录。`)
      const entries = await inventory(source)
      plans.push({ source, destination, entries, existed })
    }
    for (let i = 0; i < plans.length; i++) for (let j = i + 1; j < plans.length; j++) {
      if (inside(plans[i]!.destination, plans[j]!.destination) || inside(plans[j]!.destination, plans[i]!.destination)) throw new Error('曲库和模型目标目录不能相互包含。')
    }
    for (const plan of plans) for (const other of plans) {
      if (inside(other.source, plan.destination) || inside(plan.destination, other.source)) throw new Error('新数据目录不能与原曲库或模型目录相互包含。')
    }
    const volumes = new Map<string, { available: number; needed: number }>()
    for (const plan of plans) {
      const parent = path.dirname(plan.destination)
      const space = await statfs(parent)
      const key = String((await lstat(parent)).dev)
      const volume = volumes.get(key) ?? { available: space.bavail * space.bsize, needed: 0 }
      volume.needed += plan.entries.reduce((sum, entry) => sum + entry.size, 0)
      volumes.set(key, volume)
    }
    for (const volume of volumes.values()) if (volume.available < volume.needed + 16 * 1024 * 1024) throw new Error('目标磁盘空间不足，原配置和数据已保留。')
    if (runtimeChanged) {
      // Never replace another installation's environment pointer.
      if (await exists(next.runtimeRoot)) {
        const contents = await readdir(next.runtimeRoot)
        const modelName = path.dirname(path.resolve(next.modelRoot)) === path.resolve(next.runtimeRoot) ? path.basename(next.modelRoot) : null
        if (contents.some(name => name !== modelName)) throw new Error('运行环境目标目录已有其他文件，请选择新的数据目录。')
      } else { await mkdir(next.runtimeRoot, { recursive: true }) }
      const probe = path.join(next.runtimeRoot, `.write-test-${randomUUID()}`)
      await writeFile(probe, '', { flag: 'wx' }); await rm(probe)
    }
    for (const plan of plans) {
      const stage = path.join(path.dirname(plan.destination), `.bandbuddy-migrate-${randomUUID()}`)
      const entry = { stage, destination: plan.destination, installed: false, existed: plan.existed }
      stages.push(entry)
      await mkdir(stage)
      for (const file of plan.entries) {
        const from = path.join(plan.source, file.relative)
        const to = path.join(stage, file.relative)
        await mkdir(path.dirname(to), { recursive: true })
        await copyFile(from, to)
        const current = await lstat(from)
        if (current.size !== file.size || current.mtimeMs !== file.modified || await digest(from) !== await digest(to)) throw new Error(`文件校验失败，迁移已撤销：${file.relative}`)
      }
      if (plan.existed) await rmdir(plan.destination)
      await rename(stage, plan.destination)
      entry.installed = true
    }
    // Application mutations are paused by IPC. Also detect external additions,
    // removals or edits made while a long copy was in progress.
    for (const plan of plans) {
      const latest = await inventory(plan.source)
      const fingerprint = (entries: Entry[]): string => JSON.stringify([...entries].sort((a, b) => a.relative.localeCompare(b.relative)))
      if (fingerprint(latest) !== fingerprint(plan.entries)) throw new Error('原数据目录在迁移期间发生变化，请重试；原数据和配置已保留。')
    }
    if (runtimeChanged) pointerWritten = await linkMigratedEnvironment(previous.runtimeRoot, next.runtimeRoot)
    save()
  } catch (error) {
    for (const item of stages.reverse()) {
      await rm(item.installed ? item.destination : item.stage, { recursive: true, force: true }).catch(() => {})
      if (item.existed) await mkdir(item.destination, { recursive: true }).catch(() => {})
    }
    if (pointerWritten) {
      const pointer = path.join(next.runtimeRoot, 'active-environment.json')
      if (await readFile(pointer, 'utf8').catch(() => null) === pointerWritten) await rm(pointer, { force: true }).catch(() => {})
    }
    if (createdRuntime) await rmdir(next.runtimeRoot).catch(() => {})
    throw error
  }
}

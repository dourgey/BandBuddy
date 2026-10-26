import { opendir, stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import type { StorageUsage } from '@shared/storage.js'

export async function readStorageUsage(settings: { libraryRoot: string; runtimeRoot: string; modelRoot: string }): Promise<StorageUsage> {
  const roots = [settings.libraryRoot, settings.runtimeRoot, settings.modelRoot].map(p => path.resolve(p))
  const entries: StorageUsage['entries'] = []
  const seen = new Set<string>()
  for (const [index, root] of roots.entries()) {
    const entry = { label: ['歌曲与录音', '运行环境', '分轨模型'][index]!, path: root, bytes: 0, incomplete: false }
    const scan = async (directory: string): Promise<void> => {
      if (seen.has(directory)) return
      seen.add(directory)
      try {
        for await (const item of await opendir(directory)) {
          const file = path.join(directory, item.name)
          if (item.isSymbolicLink() || (file !== root && roots.includes(file))) continue
          if (item.isDirectory()) await scan(file)
          else if (item.isFile()) { try { entry.bytes += (await stat(file)).size } catch { entry.incomplete = true } }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') entry.incomplete = true }
    }
    await scan(root); entries.push(entry)
  }
  const disk = await statfs(roots[0]!).catch(() => null)
  return { entries, totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0), freeBytes: disk ? disk.bavail * disk.bsize : null }
}

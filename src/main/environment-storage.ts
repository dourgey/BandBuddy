import { randomUUID } from 'node:crypto'
import { mkdir, open, rm, stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import { artifactValid, type Artifact } from './artifact-download.js'

export async function remainingDownloadBytes(artifact: Artifact, destination: string): Promise<number> {
  if (await artifactValid(destination, artifact)) return 0
  // Only a matching partial belongs to this immutable artifact.
  const { readFile } = await import('node:fs/promises')
  const identity = JSON.stringify([artifact.sha256, artifact.size ?? null])
  const matches = await readFile(destination + '.part.json', 'utf8').catch(() => '') === identity
  const downloaded = matches ? await stat(destination + '.part').then(info => info.size).catch(() => 0) : 0
  if (artifact.size !== undefined && downloaded >= artifact.size) {
    return await artifactValid(destination + '.part', artifact) ? 0 : artifact.size
  }
  return Math.max(0, (artifact.size ?? 0) - downloaded)
}

/** Accounts for cache and extraction peaks on each actual destination volume. */
export async function checkEnvironmentStorage(requests: Array<{ directory: string; bytes: number }>, reserve = 1024 ** 3): Promise<void> {
  const volumes = new Map<number, { available: number; needed: number }>()
  for (const request of requests) {
    await mkdir(request.directory, { recursive: true })
    const probe = path.join(request.directory, `.bandbuddy-write-${randomUUID()}`)
    const handle = await open(probe, 'wx')
    try { await handle.writeFile('ok'); await handle.sync() } finally { await handle.close(); await rm(probe, { force: true }) }
    const [space, info] = await Promise.all([statfs(request.directory), stat(request.directory)])
    const volume = volumes.get(info.dev) ?? { available: space.bavail * space.bsize, needed: 0 }
    volume.needed += request.bytes; volumes.set(info.dev, volume)
  }
  for (const volume of volumes.values()) if (volume.available < volume.needed + reserve) throw new Error(`ENVIRONMENT_DISK_FULL:required=${volume.needed + reserve}:available=${volume.available}`)
}

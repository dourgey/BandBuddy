import path from 'node:path'

/** Only expose the drum manifest and FLAC files beneath the renderer's fixed sample directory. */
export function resolveDrumAsset(root: string, url: URL): string | null {
  if (url.hostname !== 'drum') return null
  let relative: string
  try { relative = decodeURIComponent(url.pathname).replace(/^\//, '') } catch { return null }
  if (relative !== 'manifest.json' && !/^0[1-6]-[\w-]+\/[\w-]+\.flac$/.test(relative)) return null
  const target = path.resolve(root, relative)
  if (!target.startsWith(path.resolve(root) + path.sep)) return null
  return target
}

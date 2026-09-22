/** Shared decoded peaks. Pending reads are cancelled when their last viewport leaves. */
const MAX_CACHE_BYTES = 8 * 1024 * 1024
const MAX_CACHE_ENTRIES = 32
const MAX_POINTS = 250_000
interface Entry { promise: Promise<Float32Array>; controller: AbortController; consumers: number; points?: Float32Array }
const cache = new Map<string, Entry>()

function prune(): void {
  let bytes = [...cache.values()].reduce((sum, item) => sum + (item.points?.byteLength ?? 0), 0)
  for (const [key, item] of cache) {
    if (bytes <= MAX_CACHE_BYTES && cache.size <= MAX_CACHE_ENTRIES) break
    if (!item.points || item.consumers > 0) continue
    bytes -= item.points.byteLength
    cache.delete(key)
  }
}

export function acquireWaveformPeaks(url: string): { promise: Promise<Float32Array>; release(): void } {
  let entry = cache.get(url)
  if (!entry) {
    const controller = new AbortController()
    const item: Entry = { controller, consumers: 0, promise: Promise.resolve(new Float32Array()) }
    item.promise = fetch(url, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`PEAKS_HTTP_${response.status}`)
      const data = await response.json() as { min?: unknown; max?: unknown }
      if (!Array.isArray(data.min) || !Array.isArray(data.max) || !data.max.length || data.min.length !== data.max.length) throw new Error('PEAKS_INVALID')
      const count = Math.min(MAX_POINTS, data.max.length)
      const points = new Float32Array(count)
      for (let index = 0; index < data.max.length; index++) {
        const min = data.min[index], max = data.max[index]
        if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max)) throw new Error('PEAKS_INVALID')
        const point = Math.abs(max) >= Math.abs(min) ? max / 32767 : min / 32767
        const bucket = Math.min(count - 1, Math.floor(index * count / data.max.length))
        if (Math.abs(point) > Math.abs(points[bucket]!)) points[bucket] = point
      }
      item.points = points
      prune()
      return points
    }).catch((error: unknown) => {
      if (cache.get(url) === item) cache.delete(url)
      throw error
    })
    cache.set(url, item)
    entry = item
  } else {
    cache.delete(url)
    cache.set(url, entry)
  }
  entry.consumers++
  let released = false
  return { promise: entry.promise, release: () => {
    if (released) return
    released = true
    entry.consumers--
    if (!entry.points && entry.consumers === 0) {
      entry.controller.abort()
      if (cache.get(url) === entry) cache.delete(url)
    }
    prune()
  } }
}

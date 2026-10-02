import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireWaveformPeaks } from '../src/renderer/src/waveform-peaks.js'
afterEach(() => vi.unstubAllGlobals())
describe('bounded shared peaks', () => {
  it('shares a request and cancels only after its last consumer leaves', async () => {
    let signal: AbortSignal | undefined
    const fetcher = vi.fn((_url: string, options: RequestInit) => {
      signal = options.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    })
    vi.stubGlobal('fetch', fetcher)
    const first = acquireWaveformPeaks('shared-cancel')
    const second = acquireWaveformPeaks('shared-cancel')
    const rejected = first.promise.catch((error) => error.name)
    first.release()
    expect(signal!.aborted).toBe(false)
    second.release()
    expect(signal!.aborted).toBe(true)
    expect(await rejected).toBe('AbortError')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('reuses completed peaks and evicts old released entries', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ min: [-200, -400], max: [100, 500] }) }))
    vi.stubGlobal('fetch', fetcher)
    const first = acquireWaveformPeaks('oldest')
    const data = await first.promise
    first.release()
    const reused = acquireWaveformPeaks('oldest')
    expect(await reused.promise).toBe(data)
    reused.release()
    expect(fetcher).toHaveBeenCalledOnce()
    for (let index = 0; index < 33; index++) {
      const lease = acquireWaveformPeaks(`evict-${index}`)
      await lease.promise
      lease.release()
    }
    const again = acquireWaveformPeaks('oldest')
    expect(await again.promise).not.toBe(data)
    again.release()
  })
  it('does not retain invalid peaks after a failed decode', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ min: [0], max: ['bad'] }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ min: [-1], max: [2] }) })
    vi.stubGlobal('fetch', fetcher)
    const failed = acquireWaveformPeaks('invalid')
    await expect(failed.promise).rejects.toThrow('PEAKS_INVALID')
    failed.release()
    const retry = acquireWaveformPeaks('invalid')
    await expect(retry.promise).resolves.toBeInstanceOf(Float32Array)
    retry.release()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { RuntimeInfo } from '@shared/domain.js'
import { RuntimeManager } from '../src/main/runtime.js'

vi.mock('electron', () => ({ net: {} }))

describe('on-demand runtime detection', () => {
  it('cancels a running background probe for live audio without declaring the old environment broken', async () => {
    const runtime = new RuntimeManager({} as never, { getSettings: () => ({ preferredDevice: 'auto', runtimeRoot: '/runtime', modelRoot: '/models' }) } as never, {} as never)
    const previous = runtime.getInfo()
    const probe = vi.spyOn(runtime as unknown as { performDetection(signal: AbortSignal): Promise<RuntimeInfo> }, 'performDetection').mockImplementation(signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    const detection = runtime.detect()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    runtime.cancelInstall()
    expect(await detection).toEqual(previous)
    probe.mockResolvedValue(previous)
    await runtime.detect()
    expect(probe).toHaveBeenCalledTimes(2)
  })
  it('does not probe on construction, coalesces requests, and detects changed configuration', async () => {
    const settings = { preferredDevice: 'auto', runtimeRoot: '/runtime', modelRoot: '/models' }
    const runtime = new RuntimeManager({} as never, { getSettings: () => settings } as never, {} as never)
    const probe = vi.spyOn(runtime as unknown as { detectNow(): Promise<RuntimeInfo> }, 'detectNow')
      .mockImplementation(async () => runtime.getInfo())
    expect(runtime.getInfo().stage).toBe('尚未检测')
    expect(probe).not.toHaveBeenCalled()
    await Promise.all([runtime.ensureDetected(), runtime.ensureDetected(), runtime.detect()])
    expect(probe).toHaveBeenCalledTimes(1)
    await runtime.ensureDetected()
    expect(probe).toHaveBeenCalledTimes(1)
    settings.modelRoot = '/different-models'
    await runtime.ensureDetected()
    expect(probe).toHaveBeenCalledTimes(2)
    await runtime.detect()
    expect(probe).toHaveBeenCalledTimes(3)
    let finish!: (info: RuntimeInfo) => void
    probe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const refresh = runtime.detect()
    expect(runtime.ensureDetected()).toBe(refresh)
    finish(runtime.getInfo())
    await refresh
  })
})

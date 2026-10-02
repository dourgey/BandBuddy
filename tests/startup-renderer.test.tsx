// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAppearance } from '@shared/appearance.js'
import type { BandBuddyApi } from '@shared/bridge.js'
import type { StartupState } from '@shared/startup.js'
import { startRenderer } from '../src/renderer/src/startup.js'

function state(phase: StartupState['phase'], theme: 'warm' | 'dark' | 'system' = 'dark'): StartupState {
  return { phase, appearance: normalizeAppearance({ theme }), message: phase }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function fixture(initial = state('preparing-database')) {
  const request = deferred<StartupState>()
  let listener: ((value: StartupState) => void) | undefined
  const unsubscribe = vi.fn()
  const api = {
    startup: {
      snapshot: () => initial, get: () => request.promise,
      onChanged: (callback: (value: StartupState) => void) => { listener = callback; return unsubscribe }, painted: vi.fn(async () => {})
    },
    window: { minimize: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  }
  return { api: api as unknown as BandBuddyApi, request, unsubscribe, broadcast: (value: StartupState) => listener!(value) }
}
let frames: FrameRequestCallback[]
beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  document.body.innerHTML = '<div id="root"><button data-startup-minimize>Minimize</button><button data-startup-close>Close</button><div id="startup-status"></div><p id="startup-detail">等待</p><pre id="startup-error" hidden></pre></div>'
})
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('first-paint startup shell', () => {
  it('keeps the shell interactive, acknowledges two painted frames, and mounts React only after service readiness', async () => {
    const test = fixture()
    const mount = vi.fn(async () => {})
    await startRenderer(test.api, mount)
    expect(mount).not.toHaveBeenCalled()
    expect(document.documentElement.dataset.theme).toBe('dark')
    document.querySelector<HTMLButtonElement>('[data-startup-minimize]')!.click()
    document.querySelector<HTMLButtonElement>('[data-startup-close]')!.click()
    expect(test.api.window.minimize).toHaveBeenCalledTimes(1)
    expect(test.api.window.close).toHaveBeenCalledTimes(1)
    frames.shift()!(0)
    expect(test.api.startup!.painted).not.toHaveBeenCalled()
    frames.shift()!(16)
    expect(test.api.startup!.painted).toHaveBeenCalledTimes(1)
    test.broadcast(state('initializing-services'))
    expect(mount).not.toHaveBeenCalled()
    test.broadcast(state('ready'))
    test.broadcast(state('ready'))
    await flush()
    expect(mount).toHaveBeenCalledTimes(1)
    expect(test.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale get response after a newer phase or theme broadcast', async () => {
    const test = fixture()
    const mount = vi.fn(async () => {})
    await startRenderer(test.api, mount)
    test.broadcast(state('initializing-services', 'warm'))
    test.request.resolve(state('preparing-database', 'dark'))
    await flush()
    expect(document.getElementById('startup-status')!.textContent).toBe('initializing-services')
    expect(document.documentElement.dataset.theme).toBe('warm')
    expect(mount).not.toHaveBeenCalled()
  })

  it('shows database failure details without mounting a falsely usable app', async () => {
    const test = fixture()
    const mount = vi.fn(async () => {})
    await startRenderer(test.api, mount)
    test.broadcast({ ...state('failed'), message: '曲库准备失败', error: 'SQLITE_CORRUPT' })
    expect(document.getElementById('startup-error')!.hidden).toBe(false)
    expect(document.getElementById('startup-error')!.textContent).toBe('SQLITE_CORRUPT')
    expect(document.getElementById('startup-detail')!.textContent).toContain('曲库尚未打开')
    expect(mount).not.toHaveBeenCalled()
  })

  it('reports mount failure and retains the close control', async () => {
    const test = fixture(state('ready'))
    await startRenderer(test.api, async () => { throw new Error('chunk unavailable') })
    await flush()
    expect(document.getElementById('startup-status')!.textContent).toContain('界面加载失败')
    expect(document.getElementById('startup-error')!.textContent).toBe('chunk unavailable')
    document.querySelector<HTMLButtonElement>('[data-startup-close]')!.click()
    expect(test.api.window.close).toHaveBeenCalledTimes(1)
  })

  it('supports existing preview bridges while showing a clear error when no bridge is available', async () => {
    const mount = vi.fn(async () => {})
    await startRenderer({ window: {} } as BandBuddyApi, mount)
    expect(mount).toHaveBeenCalledTimes(1)
    await startRenderer(undefined, mount)
    expect(document.getElementById('startup-status')!.textContent).toContain('无法连接桌面服务')
    expect(mount).toHaveBeenCalledTimes(1)
  })
})

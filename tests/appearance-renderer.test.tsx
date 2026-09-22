// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APPEARANCE, type Appearance } from '../packages/shared/src/appearance.js'

const dark: Appearance = { ...DEFAULT_APPEARANCE, theme: 'dark' }
const system: Appearance = { ...DEFAULT_APPEARANCE, theme: 'system', density: 'compact' }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
let prefersDark = false
let systemListeners: Set<() => void>
beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  prefersDark = false
  systemListeners = new Set()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ get matches() { return prefersDark }, addEventListener: (_event: string, listener: () => void) => systemListeners.add(listener), removeEventListener: (_event: string, listener: () => void) => systemListeners.delete(listener) })))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('renderer appearance lifecycle', () => {
  it('uses the authoritative desktop snapshot without waiting for another IPC response', async () => {
    vi.useFakeTimers()
    const appearance = await import('../src/renderer/src/appearance.js')
    const get = deferred<Appearance>()
    let broadcast!: (value: Appearance) => void
    await appearance.initializeAppearance({ get: () => get.promise, onChanged: callback => { broadcast = callback; return () => {} } }, dark)
    expect(document.documentElement.dataset.theme).toBe('dark')
    broadcast(system)
    get.resolve(DEFAULT_APPEARANCE)
    await get.promise
    expect(appearance.getAppearance()).toEqual(system)
  })
  it('paints the cached theme synchronously and releases startup after 350ms if IPC stalls', async () => {
    vi.useFakeTimers()
    localStorage.setItem('bandbuddy.appearance.v1', JSON.stringify(dark))
    const appearance = await import('../src/renderer/src/appearance.js')
    const get = deferred<Appearance>()
    let ready = false
    const initialized = appearance.initializeAppearance({ get: () => get.promise, onChanged: () => () => {} }).then(() => { ready = true })
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(appearance.getAppearance()).toEqual(dark)
    await vi.advanceTimersByTimeAsync(349)
    expect(ready).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await initialized
    expect(ready).toBe(true)
  })

  it('does not let an old startup read replace a newer cross-window broadcast, even when it matches the cache', async () => {
    const appearance = await import('../src/renderer/src/appearance.js')
    const get = deferred<Appearance>()
    let broadcast!: (value: Appearance) => void
    const initialized = appearance.initializeAppearance({ get: () => get.promise, onChanged: callback => { broadcast = callback; return () => {} } })
    broadcast(DEFAULT_APPEARANCE)
    get.resolve(dark)
    await initialized
    expect(appearance.getAppearance()).toEqual(DEFAULT_APPEARANCE)
    expect(document.documentElement.dataset.theme).toBe('warm')
  })

  it('rolls a failed optimistic save back without touching any audio or settings APIs', async () => {
    const appearance = await import('../src/renderer/src/appearance.js')
    appearance.applyAppearance(DEFAULT_APPEARANCE)
    const saved = deferred<Appearance>()
    const set = vi.fn(() => saved.promise)
    const forbidden = vi.fn((key: PropertyKey) => { throw new Error(`Unexpected service ${String(key)}`) })
    Object.defineProperty(window, 'bandbuddy', { configurable: true, value: new Proxy({ appearance: { set } }, { get: (target, key) => key === 'appearance' ? target.appearance : forbidden(key) }) })
    const saving = appearance.saveAppearance(dark)
    const rejected = expect(saving).rejects.toThrow('disk unavailable')
    expect(document.documentElement.dataset.theme).toBe('dark')
    saved.reject(new Error('disk unavailable'))
    await rejected
    expect(appearance.getAppearance()).toEqual(DEFAULT_APPEARANCE)
    expect(document.documentElement.dataset.theme).toBe('warm')
    expect(forbidden).not.toHaveBeenCalled()
    expect(set).toHaveBeenCalledExactlyOnceWith(dark)
  })

  it('keeps a newer broadcast when an earlier local save fails or returns late', async () => {
    const appearance = await import('../src/renderer/src/appearance.js')
    const pending = deferred<Appearance>()
    Object.defineProperty(window, 'bandbuddy', { configurable: true, value: { appearance: { set: () => pending.promise } } })
    const saving = appearance.saveAppearance(dark)
    const rejected = expect(saving).rejects.toThrow('cancelled save')
    appearance.applyAppearance(system)
    pending.reject(new Error('cancelled save'))
    await rejected
    expect(appearance.getAppearance()).toEqual(system)
    const response = deferred<Appearance>()
    Object.defineProperty(window, 'bandbuddy', { configurable: true, value: { appearance: { set: () => response.promise } } })
    const next = appearance.saveAppearance(dark)
    appearance.applyAppearance({ ...system, effects: 'reduced' })
    response.resolve(dark)
    await next
    expect(appearance.getAppearance()).toEqual({ ...system, effects: 'reduced' })
  })

  it('follows local OS changes only in system mode and replaces old subscriptions during reinitialization', async () => {
    const appearance = await import('../src/renderer/src/appearance.js')
    const unsubscribe = vi.fn()
    await appearance.initializeAppearance({ get: async () => system, onChanged: () => unsubscribe })
    expect(document.documentElement.dataset.theme).toBe('warm')
    prefersDark = true
    systemListeners.forEach(listener => listener())
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(appearance.getAppearance().theme).toBe('system')
    await appearance.initializeAppearance({ get: async () => DEFAULT_APPEARANCE, onChanged: () => () => {} })
    expect(systemListeners.size).toBe(1)
    expect(unsubscribe).toHaveBeenCalledOnce()
    systemListeners.forEach(listener => listener())
    expect(document.documentElement.dataset.theme).toBe('warm')
  })

  it('remains usable when browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    const appearance = await import('../src/renderer/src/appearance.js')
    await appearance.initializeAppearance()
    appearance.applyAppearance(dark)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

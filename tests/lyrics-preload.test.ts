import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/channels.js'
import type { DesktopLyricsRendererApi } from '@shared/bridge.js'

const mocks = vi.hoisted(() => ({
  api: null as DesktopLyricsRendererApi | null,
  listeners: new Map<string, (event: unknown, value: unknown) => void>()
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: DesktopLyricsRendererApi) => { mocks.api = api } },
  ipcRenderer: { on: (name: string, callback: (event: unknown, value: unknown) => void) => mocks.listeners.set(name, callback), removeListener: vi.fn() }
}))
const argv = [...process.argv]
beforeEach(() => {
  vi.resetModules()
  mocks.api = null
  mocks.listeners.clear()
  process.argv = [...argv, `--bandbuddy-appearance=${encodeURIComponent(JSON.stringify({ theme: 'warm' }))}`]
})
afterEach(() => { process.argv = argv })

describe('desktop lyrics appearance bridge', () => {
  it('retains broadcasts that arrive before the renderer subscribes and returns the latest value', async () => {
    await import('../src/preload/lyrics.js')
    const broadcast = mocks.listeners.get(IPC.eventAppearanceChanged)!
    broadcast({}, { theme: 'dark', density: 'compact', effects: 'reduced', extra: 'private' })
    expect(await mocks.api!.appearance.get()).toEqual({ schemaVersion: 1, theme: 'dark', density: 'compact', effects: 'reduced' })
    const listener = vi.fn()
    const unsubscribe = mocks.api!.appearance.onChanged(listener)
    broadcast({}, { theme: 'system' })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ schemaVersion: 1, theme: 'system', density: 'normal', effects: 'standard' })
    unsubscribe()
    broadcast({}, { theme: 'warm' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect((await mocks.api!.appearance.get()).theme).toBe('warm')
  })

  it('refreshes a reloaded preload even though startup arguments still hold the original theme', async () => {
    await import('../src/preload/lyrics.js')
    mocks.listeners.get(IPC.eventAppearanceChanged)!({}, { theme: 'dark' })
    vi.resetModules()
    mocks.listeners.clear()
    await import('../src/preload/lyrics.js')
    // Main resends its current preference on every did-finish-load.
    mocks.listeners.get(IPC.eventAppearanceChanged)!({}, { theme: 'dark' })
    expect((await mocks.api!.appearance.get()).theme).toBe('dark')
  })
})

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/channels.js'
import { normalizeAppearance } from '@shared/appearance.js'
import type { BandBuddyApi } from '@shared/bridge.js'
import type { StartupState } from '@shared/startup.js'

const mocks = vi.hoisted(() => ({
  api: null as BandBuddyApi | null,
  state: null as StartupState | null,
  listeners: new Map<string, (event: unknown, value: unknown) => void>(),
  invoke: vi.fn(async (_channel: string, ..._args: unknown[]) => []),
  sendSync: vi.fn(),
  removeListener: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: BandBuddyApi) => { mocks.api = api } },
  ipcRenderer: {
    sendSync: mocks.sendSync, invoke: mocks.invoke,
    on: (name: string, callback: (event: unknown, value: unknown) => void) => mocks.listeners.set(name, callback),
    removeListener: mocks.removeListener
  },
  webUtils: { getPathForFile: vi.fn() }
}))
function state(phase: StartupState['phase'], theme: 'warm' | 'dark' | 'system' = 'dark'): StartupState {
  return { phase, appearance: normalizeAppearance({ theme }), message: phase }
}
function broadcast(value: StartupState): void {
  mocks.state = value
  mocks.listeners.get(IPC.eventStartupChanged)!({}, value)
}
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.listeners.clear()
  mocks.api = null
  mocks.state = state('preparing-database')
  mocks.sendSync.mockImplementation(() => mocks.state)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  document.documentElement.removeAttribute('data-theme')
})

describe('startup-safe sandbox preload', () => {
  it('holds service IPC until ready while window actions and paint acknowledgement work immediately', async () => {
    await import('../src/preload/index.js')
    const library = mocks.api!.library.list()
    const settings = mocks.api!.settings.get()
    expect(mocks.invoke).not.toHaveBeenCalled()
    await mocks.api!.window.minimize()
    await mocks.api!.window.close()
    await mocks.api!.startup!.painted()
    expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual([IPC.windowMinimize, IPC.windowClose, IPC.startupPainted])
    broadcast(state('initializing-services'))
    await Promise.resolve()
    expect(mocks.invoke).toHaveBeenCalledTimes(3)
    broadcast(state('ready'))
    await Promise.all([library, settings])
    expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual([IPC.windowMinimize, IPC.windowClose, IPC.startupPainted, IPC.libraryList, IPC.settingsGet])
  })

  it('rejects queued and later requests after initialization fails without invoking absent handlers', async () => {
    await import('../src/preload/index.js')
    const result = mocks.api!.library.list().catch(error => error)
    broadcast({ ...state('failed'), error: 'database corrupt' })
    expect(await result).toMatchObject({ message: 'database corrupt' })
    await expect(mocks.api!.runtime.get()).rejects.toThrow('database corrupt')
    expect(mocks.invoke).not.toHaveBeenCalled()
    await mocks.api!.window.close()
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(IPC.windowClose)
  })

  it('colors the initial document from the live snapshot and refreshes it after reload', async () => {
    await import('../src/preload/index.js')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(mocks.sendSync).toHaveBeenCalledExactlyOnceWith(IPC.startupSnapshot)
    broadcast(state('initializing-services', 'warm'))
    expect(document.documentElement.dataset.theme).toBe('warm')
    mocks.state = state('ready', 'system')
    vi.resetModules()
    await import('../src/preload/index.js')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.themeMode).toBe('system')
    await mocks.api!.library.list()
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(IPC.libraryList, {})
  })

  it('retains the current startup state for late subscribers and forwards task payloads unchanged', async () => {
    await import('../src/preload/index.js')
    broadcast(state('ready'))
    expect(mocks.api!.startup!.snapshot().phase).toBe('ready')
    const startupChanged = vi.fn()
    const unsubscribe = mocks.api!.startup!.onChanged(startupChanged)
    broadcast(state('ready', 'warm'))
    unsubscribe()
    broadcast(state('ready', 'dark'))
    expect(startupChanged).toHaveBeenCalledTimes(1)
    const changed = vi.fn()
    mocks.api!.tasks.onChanged(changed)
    const job = { id: 'job-1', progress: 0.5 }
    mocks.listeners.get(IPC.eventTasksChanged)!({}, job)
    expect(changed).toHaveBeenCalledExactlyOnceWith(job)
  })
})

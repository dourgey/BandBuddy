import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { DEFAULT_APPEARANCE } from '../packages/shared/src/appearance.js'
import { IPC } from '../packages/shared/src/channels.js'
import { StartupCoordinator, readStartupAppearance } from '../src/main/startup.js'

type StartupEvent = IpcMainEvent & IpcMainInvokeEvent
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: StartupEvent) => unknown>(),
  listeners: new Map<string, (event: StartupEvent) => unknown>(),
  open: vi.fn(),
  prepare: vi.fn(),
  get: vi.fn(),
  close: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: StartupEvent) => unknown) => mocks.handlers.set(channel, handler),
    on: (channel: string, listener: (event: StartupEvent) => unknown) => mocks.listeners.set(channel, listener)
  }
}))
vi.mock('better-sqlite3', () => ({
  default: class {
    constructor(databasePath: string, options: unknown) { mocks.open(databasePath, options) }
    prepare = mocks.prepare
    close = mocks.close
  }
}))

beforeEach(() => {
  mocks.handlers.clear()
  mocks.listeners.clear()
  vi.resetAllMocks()
  mocks.prepare.mockReturnValue({ get: mocks.get })
})

function install() {
  let maximized = false
  const frame = { url: 'app://bandbuddy/index.html' }
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents: { mainFrame: frame, send: vi.fn() },
    minimize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(() => maximized),
    maximize: vi.fn(() => { maximized = true }),
    unmaximize: vi.fn(() => { maximized = false })
  }
  let current: typeof window | null = window
  const coordinator = new StartupCoordinator(
    { ...DEFAULT_APPEARANCE, theme: 'dark' },
    () => current as unknown as BrowserWindow | null,
    (url) => url === 'app://bandbuddy/index.html'
  )
  coordinator.register()
  const event = { sender: window.webContents, senderFrame: frame } as unknown as StartupEvent
  return {
    coordinator, event, window, frame,
    setWindow: (next: typeof window | null) => { current = next },
    invoke: (channel: string, input = event) => mocks.handlers.get(channel)!(input),
    snapshot: (input = event) => {
      mocks.listeners.get(IPC.startupSnapshot)!(input)
      return input.returnValue as unknown
    }
  }
}

describe('startup main-process coordination', () => {
  it('returns the in-memory initial appearance before database preparation and exposes early window controls', () => {
    const { coordinator, invoke, snapshot, window } = install()
    expect(snapshot()).toEqual({ phase: 'preparing-database', message: '正在准备曲库数据库…', appearance: { ...DEFAULT_APPEARANCE, theme: 'dark' } })
    expect(invoke(IPC.startupGet)).toBe(coordinator.snapshot())
    invoke(IPC.windowMinimize)
    invoke(IPC.windowClose)
    expect(window.minimize).toHaveBeenCalledOnce()
    expect(window.close).toHaveBeenCalledOnce()
    expect(invoke(IPC.windowIsMaximized)).toBe(false)
    expect(invoke(IPC.windowToggleMaximize)).toBe(true)
    expect(invoke(IPC.windowIsMaximized)).toBe(true)
    expect(invoke(IPC.windowToggleMaximize)).toBe(false)
    expect(window.maximize).toHaveBeenCalledOnce()
    expect(window.unmaximize).toHaveBeenCalledOnce()
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it.each(['other-webcontents', 'other-frame', 'untrusted-url', 'missing-window'])('rejects %s for startup requests and window controls, and returns null for sync snapshots', (kind) => {
    const harness = install()
    let event = harness.event
    if (kind === 'other-webcontents') event = { ...event, sender: {} } as StartupEvent
    if (kind === 'other-frame') event = { ...event, senderFrame: { ...harness.frame } } as StartupEvent
    if (kind === 'untrusted-url') harness.frame.url = 'https://untrusted.example/'
    if (kind === 'missing-window') harness.setWindow(null)
    expect(harness.snapshot(event)).toBeNull()
    for (const channel of [IPC.startupGet, IPC.startupPainted, IPC.windowMinimize, IPC.windowClose, IPC.windowToggleMaximize, IPC.windowIsMaximized]) {
      expect(() => harness.invoke(channel, event)).toThrow('UNTRUSTED_STARTUP_SENDER')
    }
    expect(harness.window.minimize).not.toHaveBeenCalled()
    expect(harness.window.close).not.toHaveBeenCalled()
    expect(harness.window.maximize).not.toHaveBeenCalled()
  })

  it.each(['visible-first', 'painted-first'])('requires both visible and trusted painted signals, in either order: %s', async (order) => {
    const { coordinator, invoke } = install()
    let completed = false
    void coordinator.firstPaint.then(() => { completed = true })
    if (order === 'visible-first') coordinator.markVisible()
    else invoke(IPC.startupPainted)
    await Promise.resolve()
    expect(completed).toBe(false)
    if (order === 'visible-first') invoke(IPC.startupPainted)
    else coordinator.markVisible()
    await coordinator.firstPaint
    expect(completed).toBe(true)
  })

  it('does not let an untrusted painted message release startup work', async () => {
    const { coordinator, invoke, event } = install()
    let completed = false
    void coordinator.firstPaint.then(() => { completed = true })
    coordinator.markVisible()
    expect(() => invoke(IPC.startupPainted, { ...event, sender: {} } as StartupEvent)).toThrow('UNTRUSTED_STARTUP_SENDER')
    await Promise.resolve()
    expect(completed).toBe(false)
    invoke(IPC.startupPainted)
    await coordinator.firstPaint
  })

  it('can release the paint wait during shutdown even if no window became visible', async () => {
    const { coordinator, setWindow } = install()
    setWindow(null)
    coordinator.cancelWait()
    await expect(coordinator.firstPaint).resolves.toBeUndefined()
    coordinator.cancelWait()
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('broadcasts state patches while preserving appearance and retains state without a live window', () => {
    const { coordinator, window, setWindow, snapshot } = install()
    coordinator.setState({ phase: 'initializing-services', message: '正在连接本地服务…' })
    expect(window.webContents.send).toHaveBeenLastCalledWith(IPC.eventStartupChanged, {
      phase: 'initializing-services', message: '正在连接本地服务…', appearance: { ...DEFAULT_APPEARANCE, theme: 'dark' }
    })
    expect(snapshot()).toBe(coordinator.snapshot())
    window.isDestroyed.mockReturnValue(true)
    coordinator.setState({ phase: 'failed', message: '无法准备曲库', error: 'DATABASE_ERROR' })
    expect(window.webContents.send).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({ phase: 'failed', error: 'DATABASE_ERROR' })
    setWindow(null)
    coordinator.setState({ phase: 'ready', message: '已准备好' })
    expect(window.webContents.send).toHaveBeenCalledOnce()
    expect(coordinator.snapshot().phase).toBe('ready')
  })
})

describe('startup appearance lookup', () => {
  it('uses a bounded read-only existing-file connection and closes it after reading a Chinese path', () => {
    mocks.get.mockReturnValue({ value_json: JSON.stringify({ appearance: { theme: 'dark', density: 'compact', effects: 'reduced' }, network: { proxyUrl: 'private' } }) })
    expect(readStartupAppearance('/用户/中文 空格/曲库.db')).toEqual({ schemaVersion: 1, theme: 'dark', density: 'compact', effects: 'reduced' })
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith('/用户/中文 空格/曲库.db', { readonly: true, fileMustExist: true, timeout: 50 })
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith("SELECT value_json FROM settings WHERE key = 'app'")
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('falls back to warm when the database is missing without creating or closing an unopened connection', () => {
    mocks.open.mockImplementationOnce(() => { throw new Error('SQLITE_CANTOPEN') })
    expect(readStartupAppearance('/缺少的曲库.db')).toEqual(DEFAULT_APPEARANCE)
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it.each([undefined, { value_json: '{坏 JSON' }, { value_json: 'null' }, { value_json: '{}' }, { value_json: '' }])('falls back to warm and closes the connection for absent or invalid settings: %j', (row) => {
    mocks.get.mockReturnValue(row)
    expect(readStartupAppearance('/曲库.db')).toEqual(DEFAULT_APPEARANCE)
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('closes a connection whose settings query fails and returns the default appearance', () => {
    mocks.prepare.mockImplementationOnce(() => { throw new Error('no such table: settings') })
    expect(readStartupAppearance('/旧曲库.db')).toEqual(DEFAULT_APPEARANCE)
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('repairs invalid appearance fields independently while preserving valid preferences', () => {
    mocks.get.mockReturnValue({ value_json: JSON.stringify({ appearance: { theme: 'system', density: 'bad-density', effects: 'reduced' } }) })
    expect(readStartupAppearance('/曲库.db')).toEqual({ schemaVersion: 1, theme: 'system', density: 'normal', effects: 'reduced' })
    expect(mocks.close).toHaveBeenCalledOnce()
  })
})

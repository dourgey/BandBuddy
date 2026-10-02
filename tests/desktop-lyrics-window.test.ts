import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/channels.js'
import { normalizeAppearance } from '@shared/appearance.js'
import { DesktopLyricsWindow } from '../src/main/desktop-lyrics.js'

const mocks = vi.hoisted(() => ({ windows: [] as any[], workArea: { x: -800, y: -500, width: 640, height: 360 } }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    loading = true
    visible = false
    destroyed = false
    bounds = { x: 0, y: 0, width: 900, height: 142 }
    finishLoad!: () => void
    webContents = Object.assign(new EventEmitter(), { send: vi.fn(), setWindowOpenHandler: vi.fn(), isLoading: () => this.loading, executeJavaScript: vi.fn(async () => true) })
    constructor(readonly options: unknown) { super(); mocks.windows.push(this) }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents() {}
    setMenuBarVisibility() {}
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    getBounds() { return this.bounds }
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds }
    showInactive() { this.visible = true }
    hide() { this.visible = false }
    destroy() { this.destroyed = true; this.emit('closed') }
    loadURL() { return new Promise<void>(resolve => { this.finishLoad = () => { this.loading = false; this.webContents.emit('did-finish-load'); resolve() } }) }
  }
  return { BrowserWindow: Window, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: mocks.workArea }), getDisplayMatching: () => ({ workArea: mocks.workArea }) } }
})
beforeEach(() => { mocks.windows.length = 0 })

describe('desktop lyrics loading and layout', () => {
  it('replays the latest authoritative appearance after load, reload, and before showing', async () => {
    let appearance = normalizeAppearance({ theme: 'warm' })
    const lyrics = new DesktopLyricsWindow({ preloadPath: 'preload', rendererUrl: 'file:///lyrics.html', logger: { capture: vi.fn() } as never, appearance: () => appearance })
    const showing = lyrics.setVisible(true)
    const window = mocks.windows[0]!
    appearance = normalizeAppearance({ theme: 'dark' })
    lyrics.setAppearance(appearance)
    window.finishLoad()
    await showing
    expect(window.webContents.send).toHaveBeenLastCalledWith(IPC.eventAppearanceChanged, appearance)
    window.loading = true
    appearance = normalizeAppearance({ theme: 'system', density: 'compact' })
    lyrics.setAppearance(appearance)
    window.webContents.send.mockClear()
    window.finishLoad()
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC.eventAppearanceChanged, appearance)
    await lyrics.setVisible(false)
    appearance = normalizeAppearance({ theme: 'warm', effects: 'reduced' })
    await lyrics.setVisible(true)
    expect(window.webContents.send).toHaveBeenLastCalledWith(IPC.eventAppearanceChanged, appearance)
    expect(window.options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false })
    lyrics.destroy()
  })

  it('keeps large multiline lyrics inside the active display work area', async () => {
    const lyrics = new DesktopLyricsWindow({ preloadPath: 'preload', rendererUrl: 'file:///lyrics.html', logger: { capture: vi.fn() } as never })
    lyrics.setFontSize(96)
    lyrics.update({ title: '标题', artist: '', currentLines: Array(12).fill('歌词'), nextLines: [], playing: true, progress: 0 })
    const showing = lyrics.setVisible(true)
    const window = mocks.windows[0]!
    window.finishLoad()
    await showing
    expect(window.bounds.height).toBe(mocks.workArea.height)
    expect(window.bounds.x).toBeGreaterThanOrEqual(mocks.workArea.x)
    expect(window.bounds.y).toBeGreaterThanOrEqual(mocks.workArea.y)
    expect(window.bounds.x + window.bounds.width).toBeLessThanOrEqual(mocks.workArea.x + mocks.workArea.width)
    expect(window.bounds.y + window.bounds.height).toBeLessThanOrEqual(mocks.workArea.y + mocks.workArea.height)
    lyrics.destroy()
  })
})

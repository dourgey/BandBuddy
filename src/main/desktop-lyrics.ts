import { BrowserWindow, screen } from 'electron'
import type { DesktopLyricsPayload } from '@shared/domain.js'
import { IPC } from '@shared/channels.js'

interface DesktopLyricsWindowOptions {
  preloadPath: string
  rendererUrl: string
}

export class DesktopLyricsWindow {
  private window: BrowserWindow | null = null
  private loadPromise: Promise<void> | null = null
  private latestPayload: DesktopLyricsPayload | null = null
  private shouldBeVisible = false

  constructor(private readonly options: DesktopLyricsWindowOptions) {}

  async setVisible(visible: boolean): Promise<void> {
    this.shouldBeVisible = visible
    if (!visible) {
      this.window?.hide()
      return
    }

    const window = this.ensureWindow()
    await this.loadPromise
    if (!this.shouldBeVisible || window.isDestroyed()) return
    this.position(window)
    if (this.latestPayload) window.webContents.send(IPC.eventDesktopLyricsUpdate, this.latestPayload)
    window.showInactive()
  }

  update(payload: DesktopLyricsPayload): void {
    this.latestPayload = payload
    const window = this.window
    if (!window || window.isDestroyed() || window.webContents.isLoading()) return
    window.webContents.send(IPC.eventDesktopLyricsUpdate, payload)
  }

  destroy(): void {
    this.shouldBeVisible = false
    this.window?.destroy()
    this.window = null
    this.loadPromise = null
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const window = new BrowserWindow({
      width: 900,
      height: 142,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: true,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        spellcheck: false
      }
    })
    this.window = window
    window.setAlwaysOnTop(true, 'floating')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.setIgnoreMouseEvents(true)
    window.setMenuBarVisibility(false)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== this.options.rendererUrl) event.preventDefault()
    })
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null
        this.loadPromise = null
      }
    })
    this.loadPromise = window.loadURL(this.options.rendererUrl).then(async () => {
      const preloadReady = await window.webContents.executeJavaScript(
        "typeof window.desktopLyrics === 'object' && typeof window.desktopLyrics.onUpdate === 'function'"
      ) as boolean
      if (!preloadReady) throw new Error('DESKTOP_LYRICS_PRELOAD_FAILED')
    })
    return window
  }

  private position(window: BrowserWindow): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const width = Math.min(1000, Math.max(620, Math.round(display.workArea.width * 0.72)))
    const height = 142
    window.setBounds({
      x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
      y: display.workArea.y + display.workArea.height - height - 28,
      width,
      height
    }, false)
  }
}

import { normalizeAppearance, type Appearance } from '@shared/appearance.js'
import { BrowserWindow, screen } from 'electron'
import type { DesktopLyricsPayload } from '@shared/domain.js'
import { IPC } from '@shared/channels.js'
import type { Logger } from './logger.js'

interface DesktopLyricsWindowOptions {
  preloadPath: string
  rendererUrl: string
  logger: Logger
  appearance?: () => Appearance
}

export class DesktopLyricsWindow {
  private window: BrowserWindow | null = null
  private loadPromise: Promise<void> | null = null
  private latestPayload: DesktopLyricsPayload | null = null
  private shouldBeVisible = false
  private fontSize = 24
  private latestAppearance = normalizeAppearance(null)

  setFontSize(size: number): void {
    this.fontSize = size
    if (this.window && !this.window.isDestroyed()) this.position(this.window)
    if (this.latestPayload) this.update(this.latestPayload)
  }

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
    this.sendAppearance(window)
    if (this.latestPayload) window.webContents.send(IPC.eventDesktopLyricsUpdate, this.latestPayload)
    window.showInactive()
  }

  update(payload: DesktopLyricsPayload): void {
    const layoutChanged = this.latestPayload?.fontSize !== this.fontSize
      || this.latestPayload?.currentLines.length !== payload.currentLines.length
    payload = { ...payload, fontSize: this.fontSize }
    this.latestPayload = payload
    const window = this.window
    if (!window || window.isDestroyed() || window.webContents.isLoading()) return
    if (layoutChanged) this.position(window)
    window.webContents.send(IPC.eventDesktopLyricsUpdate, payload)
  }

  setAppearance(appearance: Appearance): void {
    this.latestAppearance = normalizeAppearance(appearance)
    if (this.window && !this.window.isDestroyed() && !this.window.webContents.isLoading()) this.window.webContents.send(IPC.eventAppearanceChanged, this.latestAppearance)
  }

  private sendAppearance(window: BrowserWindow): void {
    this.latestAppearance = normalizeAppearance(this.options.appearance?.() ?? this.latestAppearance)
    window.webContents.send(IPC.eventAppearanceChanged, this.latestAppearance)
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
        additionalArguments: [`--bandbuddy-appearance=${encodeURIComponent(JSON.stringify(normalizeAppearance(this.options.appearance?.() ?? this.latestAppearance)))}`],
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
    window.webContents.on('did-finish-load', () => {
      if (this.window === window && !window.isDestroyed()) this.sendAppearance(window)
    })
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== this.options.rendererUrl) event.preventDefault()
    })
    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const logLevel = level >= 3 ? 'error' : level === 2 ? 'warn' : level === 0 ? 'debug' : 'info'
      this.options.logger.capture(logLevel, 'desktop lyrics console', { message, line, sourceId })
    })
    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      this.options.logger.capture('error', 'desktop lyrics preload failed', { preloadPath, error })
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      this.options.logger.capture('error', 'desktop lyrics process exited', details)
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
    }).catch((error) => {
      this.options.logger.capture('error', 'desktop lyrics failed to load', error)
      throw error
    })
    return window
  }

  private position(window: BrowserWindow): void {
    const display = window.isVisible() ? screen.getDisplayMatching(window.getBounds()) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const width = Math.min(display.workArea.width, 1000, Math.max(620, Math.round(display.workArea.width * 0.72)))
    const lines = Math.max(1, this.latestPayload?.currentLines.length ?? 1)
    const height = Math.min(display.workArea.height, Math.max(142, Math.ceil(66 + this.fontSize * (1.18 * lines + 0.6))))
    window.setBounds({
      x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
      y: Math.max(display.workArea.y, display.workArea.y + display.workArea.height - height - 28),
      width,
      height
    }, false)
  }
}

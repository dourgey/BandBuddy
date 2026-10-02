import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import Database from 'better-sqlite3'
import { normalizeAppearance, type Appearance } from '@shared/appearance.js'
import { IPC } from '@shared/channels.js'
import type { StartupState } from '@shared/startup.js'

/** A bounded readonly lookup never creates, migrates or repairs an old database. */
export function readStartupAppearance(databasePath: string): Appearance {
  let connection: Database.Database | undefined
  try {
    connection = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 50 })
    const row = connection.prepare("SELECT value_json FROM settings WHERE key = 'app'").get() as { value_json?: string } | undefined
    return normalizeAppearance(row?.value_json ? JSON.parse(row.value_json).appearance : undefined)
  } catch { return normalizeAppearance(null) }
  finally { try { connection?.close() } catch { /* An optional theme lookup cannot prevent the startup shell. */ } }
}

export class StartupCoordinator {
  private state: StartupState
  private visible = false
  private painted = false
  private resolvePaint!: () => void
  readonly firstPaint = new Promise<void>(resolve => { this.resolvePaint = resolve })

  constructor(appearance: Appearance, private readonly getWindow: () => BrowserWindow | null, private readonly trustedUrl: (url: string) => boolean) {
    this.state = { phase: 'preparing-database', appearance, message: '正在准备曲库数据库…' }
  }
  snapshot(): StartupState { return this.state }
  setState(patch: Partial<StartupState>): void {
    this.state = { ...this.state, ...patch }
    const window = this.getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.eventStartupChanged, this.state)
  }
  markVisible(): void { this.visible = true; this.completePaint() }
  cancelWait(): void { this.resolvePaint() }
  private completePaint(): void { if (this.visible && this.painted) this.resolvePaint() }
  private assertSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
    const window = this.getWindow()
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !this.trustedUrl(event.senderFrame.url)) throw new Error('UNTRUSTED_STARTUP_SENDER')
  }
  register(): void {
    // This synchronous handler returns memory only. It never opens SQLite or
    // waits for the migration worker, so preload can color the first DOM node.
    ipcMain.on(IPC.startupSnapshot, event => {
      try { this.assertSender(event); event.returnValue = this.state } catch { event.returnValue = null }
    })
    const handle = (channel: string, callback: () => unknown): void => {
      ipcMain.handle(channel, event => { this.assertSender(event); return callback() })
    }
    handle(IPC.startupGet, () => this.state)
    handle(IPC.startupPainted, () => { this.painted = true; this.completePaint() })
    handle(IPC.windowMinimize, () => this.getWindow()?.minimize())
    handle(IPC.windowClose, () => this.getWindow()?.close())
    handle(IPC.windowIsMaximized, () => this.getWindow()?.isMaximized() ?? false)
    handle(IPC.windowToggleMaximize, () => {
      const window = this.getWindow()
      if (!window) return false
      if (window.isMaximized()) window.unmaximize(); else window.maximize()
      return window.isMaximized()
    })
  }
}

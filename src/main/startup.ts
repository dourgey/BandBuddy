import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import Database from 'better-sqlite3'
import { normalizeAppearance, type Appearance } from '@shared/appearance.js'
import { IPC } from '@shared/channels.js'
import type { StartupState } from '@shared/startup.js'
import { stageDatabaseRecovery } from './database-recovery.js'

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

  constructor(appearance: Appearance, private readonly getWindow: () => BrowserWindow | null, private readonly trustedUrl: (url: string) => boolean,
    private readonly recovery?: { safeMode: boolean; success(): void; clear(): void; repairSystem(): Promise<void> }) {
    this.state = { phase: 'preparing-database', appearance, message: '正在准备曲库数据库…', safeMode: recovery?.safeMode }
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
    ipcMain.handle('startup:recover', (event, safe: unknown) => {
      this.assertSender(event)
      if (typeof safe !== 'boolean') throw new Error('INVALID_STARTUP_RECOVERY')
      if (!safe) this.recovery?.clear()
      const args = process.argv.slice(1).filter(arg => arg !== '--safe-mode')
      if (safe) args.push('--safe-mode')
      app.relaunch({ args }); app.quit()
    })
    ipcMain.handle('startup:revealRecovery', event => { this.assertSender(event); return shell.openPath(app.getPath('userData')) })
    let restoring = false
    ipcMain.handle('startup:restoreBackup', async event => {
      this.assertSender(event)
      if (this.state.phase !== 'failed' || restoring) return
      restoring = true
      try {
        const selection = await dialog.showOpenDialog({ title: '选择曲库数据库备份', defaultPath: app.getPath('userData'), properties: ['openFile'], filters: [{ name: 'BandBuddy 数据库备份', extensions: ['db', 'bak'] }] })
        if (selection.canceled || !selection.filePaths[0]) return
        const answer = await dialog.showMessageBox({ type: 'warning', title: '从备份恢复曲库记录', message: '恢复后，曲库记录、设置和任务回到所选备份的时间。', detail: '备份之后添加或修改的曲库记录可能不再显示。原数据库及其日志会完整备份；音频文件不会被删除。恢复完成后需重新打开。', buttons: ['取消', '保留原文件并恢复'], defaultId: 0, cancelId: 0 })
        if (answer.response !== 1) return
        await stageDatabaseRecovery(app.getPath('userData'), selection.filePaths[0])
        this.recovery?.clear(); app.relaunch(); app.quit()
      } finally { restoring = false }
    })
    ipcMain.handle('startup:interactive', event => { this.assertSender(event); if (this.state.phase === 'ready') this.recovery?.success() })
    let repairing: Promise<void> | undefined
    ipcMain.handle('startup:repairSystem', event => {
      this.assertSender(event)
      if (this.state.phase !== 'failed') throw new Error('STARTUP_REPAIR_NOT_NEEDED')
      repairing ??= (this.recovery?.repairSystem() ?? Promise.resolve()).finally(() => { repairing = undefined })
      return repairing
    })
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

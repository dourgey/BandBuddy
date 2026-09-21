import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  protocol,
  Tray,
  type NativeImage
} from 'electron'
import { IPC } from '@shared/channels.js'
import { APP_ICON_DATA_URL } from './app-icon.js'
import { BandBuddyDatabase } from './database.js'
import { ExportService } from './exporter.js'
import { LanService } from './lan.js'
import { ImportService } from './imports.js'
import { registerIpc } from './ipc.js'
import { JobScheduler } from './jobs.js'
import { Logger } from './logger.js'
import { MediaService } from './media.js'
import { AppPaths } from './paths.js'
import { AudioHostClient } from './audio-host.js'
import { RecordingService } from './recording.js'
import { RehearsalService } from './rehearsals.js'
import { RehearsalRecordingService } from './rehearsal-recording.js'
import { DesktopLyricsWindow } from './desktop-lyrics.js'
import { RuntimeManager } from './runtime.js'
import { isTrustedRendererUrl } from './security.js'
import { WindowState, type WindowSize } from './window-state.js'

protocol.registerSchemesAsPrivileged([{
  scheme: 'bandbuddy-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}])

app.setName('BandBuddy')
const smokeMode = process.env.BANDBUDDY_SMOKE === '1'
const developmentTestRoot = smokeMode || !app.isPackaged ? process.env.BANDBUDDY_TEST_ROOT : undefined
app.setPath('userData', developmentTestRoot ? join(developmentTestRoot, 'appdata') : join(app.getPath('appData'), 'BandBuddy'))
if (process.platform === 'win32') app.setAppUserModelId('com.bandbuddy.desktop')

let lan: LanService | null = null
let stoppingLanForQuit = false
const currentDirectory = fileURLToPath(new URL('.', import.meta.url))
const rendererFileUrl = pathToFileURL(join(currentDirectory, '../renderer/index.html')).href
const lyricsRendererFileUrl = pathToFileURL(join(currentDirectory, '../renderer/lyrics.html')).href
const trustedRendererUrl = (url: string): boolean => isTrustedRendererUrl(url, process.env.ELECTRON_RENDERER_URL, rendererFileUrl)
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let database: BandBuddyDatabase | null = null
let logger: Logger | null = null
let scheduler: JobScheduler | null = null
let recording: RecordingService | null = null
let rehearsalRecording: RehearsalRecordingService | null = null
let desktopLyrics: DesktopLyricsWindow | null = null
let quitAfterRecording = false
let applicationIcon: NativeImage | null = null
let windowState: WindowState | null = null

const MIN_WINDOW_SIZE = { width: 1180, height: 760 }
const DEFAULT_WINDOW_SIZE: WindowSize = { width: 1440, height: 960, maximized: false }

function getApplicationIcon(): NativeImage {
  if (applicationIcon) return applicationIcon
  applicationIcon = nativeImage.createFromDataURL(APP_ICON_DATA_URL)
  if (applicationIcon.isEmpty()) throw new Error('EMBEDDED_APP_ICON_INVALID')
  return applicationIcon
}

function emit(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function createWindow(paths: AppPaths): BrowserWindow {
  const state = new WindowState(join(paths.localRoot, 'window-state.json'), MIN_WINDOW_SIZE)
  windowState = state
  const restored = state.restore(DEFAULT_WINDOW_SIZE)
  const window = new BrowserWindow({
    width: restored.width,
    height: restored.height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    frame: false,
    backgroundColor: '#F5F1EA',
    icon: getApplicationIcon(),
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  })
  window.setMenuBarVisibility(false)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!trustedRendererUrl(url)) event.preventDefault()
  })
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const logLevel = level >= 3 ? 'error' : level === 2 ? 'warn' : level === 0 ? 'debug' : 'info'
    logger?.capture(logLevel, 'renderer console', { message, line, sourceId })
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger?.capture('error', 'renderer preload failed', { preloadPath, error })
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    logger?.capture('error', 'renderer process exited', details)
  })
  window.webContents.on('unresponsive', () => logger?.capture('warn', 'renderer became unresponsive'))
  state.track(window)
  window.once('ready-to-show', () => {
    if (restored.maximized) window.maximize()
    window.show()
  })
  window.on('hide', () => emit(IPC.eventWindowHidden))
  window.on('maximize', () => emit(IPC.eventWindowMaximizedChanged, true))
  window.on('unmaximize', () => emit(IPC.eventWindowMaximizedChanged, false))
  window.on('close', (event) => {
    if (quitting) return
    if (recording?.isActive() || rehearsalRecording?.isActive()) {
      event.preventDefault()
      const finish = rehearsalRecording?.isActive()
        ? rehearsalRecording.stop()
        : recording?.finishForTransition()
      void finish?.then(() => window.close()).catch(() => window.show())
      return
    }
    const shouldStay = Boolean(database?.hasActiveJobs() && database.getSettings().closeToTrayWhileWorking)
    if (shouldStay) {
      event.preventDefault()
      window.hide()
      tray?.displayBalloon?.({ title: 'BandBuddy 仍在工作', content: '音频任务会在后台继续运行。' })
    }
  })
  window.on('closed', () => { mainWindow = null })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(currentDirectory, '../renderer/index.html'))
  if (smokeMode) {
    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      process.stderr.write(`BAND_BUDDY_PRELOAD_ERROR ${preloadPath} ${String(error)}\n`)
    })
    window.webContents.on('console-message', (_event, level, message) => {
      process.stderr.write(`BAND_BUDDY_RENDERER_CONSOLE ${level} ${message}\n`)
    })
    window.webContents.once('did-finish-load', () => {
      void window.webContents.executeJavaScript(`(() => {
        if (!window.bandbuddy) return { apiType: typeof window.bandbuddy, body: document.body.innerText.slice(0, 300) }
         return Promise.all([
           window.bandbuddy.library.list(),
           window.bandbuddy.runtime.get(),
           window.bandbuddy.media.capabilities(),
           window.bandbuddy.desktopLyrics.setVisible(true).then(() => {
             window.bandbuddy.desktopLyrics.update({
               title: 'Smoke test', artist: 'BandBuddy', currentLines: ['桌面歌词'], nextLines: ['同步正常'],
               progress: 0.5, playing: true
             })
             return window.bandbuddy.desktopLyrics.setVisible(false)
           }).then(() => true)
         ]).then(([songs, runtime, media, desktopLyrics]) => ({
           apiType: typeof window.bandbuddy,
           namespaces: Object.keys(window.bandbuddy).sort(),
           songs: songs.length,
           runtime: runtime.status,
           ffmpegReady: media.ffmpegReady,
           desktopLyrics
         }))
      })()`).then((result: { apiType?: string }) => {
        process.stdout.write(`BAND_BUDDY_SMOKE ${JSON.stringify(result)}\n`)
        if (result.apiType !== 'object') process.exitCode = 1
        setTimeout(() => app.quit(), 50)
      }).catch((error: unknown) => {
        process.stderr.write(`BAND_BUDDY_SMOKE_FAILED ${String(error)}\n`)
        process.exitCode = 1
        setTimeout(() => app.quit(), 50)
      })
    })
  }
  return window
}

function createTray(paths: AppPaths): void {
  if (tray) return
  tray = new Tray(getApplicationIcon().resize({ width: 20, height: 20 }))
  tray.setToolTip('BandBuddy')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 BandBuddy', click: () => { if (!mainWindow) mainWindow = createWindow(paths); else mainWindow.show() } },
    { label: '查看任务', click: () => { if (!mainWindow) mainWindow = createWindow(paths); mainWindow.show(); emit(IPC.eventTasksChanged) } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } }
  ]))
  tray.on('double-click', () => { if (!mainWindow) mainWindow = createWindow(paths); else mainWindow.show() })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void app.whenReady().then(async () => {
    const paths = new AppPaths()
    paths.ensure()
    database = new BandBuddyDatabase(paths)
    const applicationLogger = new Logger(paths.logsRoot, database.getSettings().debugMode)
    logger = applicationLogger
    const media = new MediaService(paths, database, applicationLogger)
    media.registerProtocol()
    const runtime = new RuntimeManager(paths, database, applicationLogger)
    mainWindow = createWindow(paths)
    const developmentLyricsUrl = process.env.ELECTRON_RENDERER_URL
      ? new URL('lyrics.html', process.env.ELECTRON_RENDERER_URL.endsWith('/') ? process.env.ELECTRON_RENDERER_URL : `${process.env.ELECTRON_RENDERER_URL}/`).href
      : null
    desktopLyrics = new DesktopLyricsWindow({
      preloadPath: join(currentDirectory, '../preload/lyrics.cjs'),
      rendererUrl: developmentLyricsUrl ?? lyricsRendererFileUrl,
      logger: applicationLogger
    })
    createTray(paths)

    const emitLibrary = (): void => emit(IPC.eventLibraryChanged)
    const emitGuitarSplitCompleted = (songId: string): void => emit(IPC.eventGuitarSplitCompleted, songId)
    const emitTasks = (): void => emit(IPC.eventTasksChanged)
    const emitSettings = (): void => emit(IPC.eventSettingsChanged, database?.getSettings())
    const emitMedia = (): void => emit(IPC.eventMediaChanged, media.capabilities())
    const emitRehearsals = (): void => emit(IPC.eventRehearsalsChanged)
    scheduler = new JobScheduler(paths, database, runtime, media, applicationLogger, emitTasks, emitLibrary, emitGuitarSplitCompleted)
    const exporter = new ExportService(paths, database, media, applicationLogger, emitTasks, () => scheduler?.kick())
    scheduler.setExporter(exporter)
    const imports = new ImportService(paths, database, media, runtime, applicationLogger, () => { emitLibrary(); emitTasks() }, () => scheduler?.kick())
    const audioHost = new AudioHostClient(paths, applicationLogger)
    recording = new RecordingService(
      paths,
      database,
      media,
      audioHost,
      applicationLogger,
      (state) => emit(IPC.eventRecordingState, state),
      (meter) => emit(IPC.eventRecordingMeter, meter),
      emitLibrary
    )
    const rehearsals = new RehearsalService(paths, database, emitRehearsals)
    rehearsalRecording = new RehearsalRecordingService(
      paths,
      database,
      media,
      audioHost,
      applicationLogger,
      () => recording?.isActive() ?? false,
      (state) => emit(IPC.eventRehearsalRecordingState, state),
      (meter) => emit(IPC.eventRehearsalRecordingMeter, meter),
      emitRehearsals
    )

    lan = new LanService(database, media, paths, applicationLogger, join(currentDirectory, '../renderer'))
    registerIpc({
      lan,
      getWindow: () => mainWindow,
      database,
      imports,
      jobs: scheduler,
      runtime,
      media,
      exporter,
      recording,
      rehearsals,
      rehearsalRecording,
      desktopLyrics,
      logger: applicationLogger,
      isTrustedUrl: trustedRendererUrl,
      emitSettings,
      emitLibrary,
      emitTasks
    })
    emitMedia()
    runtime.onChange((info) => emit(IPC.eventRuntimeChanged, info))
    void runtime.detect()
    scheduler.kick()
    void recording.recoverInterruptedSessions()
    void rehearsalRecording.recoverInterruptedSessions()
    applicationLogger.info('application ready', { version: app.getVersion(), packaged: app.isPackaged })
  })
}

app.on('activate', () => {
  if (!mainWindow) {
    const paths = new AppPaths()
    mainWindow = createWindow(paths)
  } else mainWindow.show()
})

app.on('window-all-closed', () => {
  if (!database?.hasActiveJobs() || !database.getSettings().closeToTrayWhileWorking) app.quit()
})

app.on('before-quit', (event) => {
  windowState?.flush()
  desktopLyrics?.destroy()
  if (!quitAfterRecording && (recording?.isActive() || rehearsalRecording?.isActive())) {
    event.preventDefault()
    const finish = rehearsalRecording?.isActive()
      ? rehearsalRecording.stop()
      : recording?.finishForTransition()
    void finish?.finally(() => {
      quitAfterRecording = true
      quitting = true
      app.quit()
    })
    return
  }
  if (lan?.status().enabled) {
    event.preventDefault()
    if (!stoppingLanForQuit) {
      stoppingLanForQuit = true
      void lan.setEnabled(false).finally(() => app.quit())
    }
    return
  }
  quitting = true
  scheduler?.interruptForExit()
})

app.on('will-quit', () => {
  void lan?.stop()
  lan = null
  void rehearsalRecording?.shutdown(false)
  rehearsalRecording = null
  void recording?.shutdown(false)
  recording = null
  desktopLyrics?.destroy()
  desktopLyrics = null
  database?.close()
  database = null
  tray?.destroy()
  tray = null
})

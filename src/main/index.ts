import { StartupCoordinator, readStartupAppearance } from './startup.js'
import { databaseNeedsPreparation, startDatabasePreparation } from './database-preparation.js'
import { normalizeAppearance, resolveTheme, themeBackground, type Appearance } from '@shared/appearance.js'
import { ArsenalService } from './arsenal.js'
import { ARSENAL_MONITOR_EVENT } from '@shared/arsenal.js'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
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
import { shutdownProcesses } from './process.js'
import { shutdownMediaAnalysis } from './media-analysis.js'
import { isTrustedRendererUrl } from './security.js'
import { WindowState, type WindowSize } from './window-state.js'

protocol.registerSchemesAsPrivileged([{
  scheme: 'bandbuddy-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}])

app.setName('BandBuddy')
const smokeMode = process.env.BANDBUDDY_SMOKE === '1'
const benchmarkMode = process.env.BANDBUDDY_BENCHMARK === '1' && !app.isPackaged
const benchmarkPhases = new Set<string>()
function benchmarkMetric(phase: string): void {
  if (!benchmarkMode || benchmarkPhases.has(phase)) return
  benchmarkPhases.add(phase)
  process.stdout.write(`BAND_BUDDY_METRIC ${JSON.stringify({ phase })}\n`)
  if (['window-visible', 'library-interactive', 'backend-ready'].every(value => benchmarkPhases.has(value))) setTimeout(() => app.quit(), 50)
}
const developmentTestRoot = smokeMode || !app.isPackaged ? process.env.BANDBUDDY_TEST_ROOT : undefined
app.setPath('userData', developmentTestRoot ? join(developmentTestRoot, 'appdata') : join(app.getPath('appData'), 'BandBuddy'))
if (process.platform === 'win32') app.setAppUserModelId('com.bandbuddy.desktop')

let lan: LanService | null = null
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
let runtimeManager: RuntimeManager | null = null
let recording: RecordingService | null = null
let rehearsalRecording: RehearsalRecordingService | null = null
let desktopLyrics: DesktopLyricsWindow | null = null
let shutdownTask: Promise<void> | null = null
let shutdownComplete = false
let startupRecoveries: Promise<unknown> = Promise.resolve()
let applicationIcon: NativeImage | null = null
let windowState: WindowState | null = null
let startup: StartupCoordinator | null = null
let databasePreparation: ReturnType<typeof startDatabasePreparation> | null = null

const MIN_WINDOW_SIZE = { width: 800, height: 500 }
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
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workAreaSize
  const limits = { width: Math.min(MIN_WINDOW_SIZE.width, workArea.width), height: Math.min(MIN_WINDOW_SIZE.height, workArea.height) }
  const state = new WindowState(join(paths.localRoot, 'window-state.json'), limits, workArea)
  windowState = state
  const restored = state.restore(DEFAULT_WINDOW_SIZE)
  const window = new BrowserWindow({
    width: restored.width,
    height: restored.height,
    minWidth: limits.width,
    minHeight: limits.height,
    show: false,
    frame: false,
    backgroundColor: themeBackground(resolveTheme(startup?.snapshot().appearance ?? normalizeAppearance(database?.getSettings().appearance), nativeTheme.shouldUseDarkColors)),
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
    if (benchmarkMode && message.startsWith('BAND_BUDDY_METRIC ')) {
      try { const metric = JSON.parse(message.slice('BAND_BUDDY_METRIC '.length)); if (metric.phase === 'library-interactive') benchmarkMetric(metric.phase) } catch { /* Ignore unrelated diagnostic output. */ }
    }
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
    startup?.markVisible()
    benchmarkMetric('window-visible')
    if (smokeMode) process.stdout.write(`BAND_BUDDY_METRIC ${JSON.stringify({ phase: 'window-visible' })}\n`)
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
    startup = new StartupCoordinator(readStartupAppearance(paths.databasePath), () => mainWindow, trustedRendererUrl)
    startup.register()
    nativeTheme.on('updated', () => {
      const appearance = startup?.snapshot().appearance ?? normalizeAppearance(null)
      if (appearance.theme !== 'system') return
      mainWindow?.setBackgroundColor(themeBackground(resolveTheme(appearance, nativeTheme.shouldUseDarkColors)))
      startup?.setState({ appearance })
      emit(IPC.eventAppearanceChanged, appearance)
      desktopLyrics?.setAppearance(appearance)
    })
    mainWindow = createWindow(paths)
    // The shell has genuinely rendered and been shown before any migrations,
    // recovery updates or filesystem preparation begin.
    await startup.firstPaint
    if (quitting) return
    paths.ensure()
    if (databaseNeedsPreparation(paths)) {
      databasePreparation = startDatabasePreparation(paths)
      try { await databasePreparation.ready }
      finally { databasePreparation = null }
    }
    if (quitting) return
    database = new BandBuddyDatabase(paths, { prepared: true })
    const appearance = normalizeAppearance(database.getSettings().appearance)
    startup.setState({ phase: 'initializing-services', appearance, message: '曲库已准备好，正在连接本地服务…' })
    mainWindow?.setBackgroundColor(themeBackground(resolveTheme(appearance, nativeTheme.shouldUseDarkColors)))
    const applicationLogger = new Logger(paths.logsRoot, database.getSettings().debugMode)
    logger = applicationLogger
    const media = new MediaService(paths, database, applicationLogger)
    media.registerProtocol()
    const runtime = new RuntimeManager(paths, database, applicationLogger)
    runtimeManager = runtime
    const developmentLyricsUrl = process.env.ELECTRON_RENDERER_URL
      ? new URL('lyrics.html', process.env.ELECTRON_RENDERER_URL.endsWith('/') ? process.env.ELECTRON_RENDERER_URL : `${process.env.ELECTRON_RENDERER_URL}/`).href
      : null
    desktopLyrics = new DesktopLyricsWindow({
      preloadPath: join(currentDirectory, '../preload/lyrics.cjs'),
      rendererUrl: developmentLyricsUrl ?? lyricsRendererFileUrl,
      logger: applicationLogger,
      appearance: () => normalizeAppearance(database?.getSettings().appearance)
    })
    createTray(paths)

    const emitLibrary = (): void => emit(IPC.eventLibraryChanged)
    const emitGuitarSplitCompleted = (songId: string): void => emit(IPC.eventGuitarSplitCompleted, songId)
    const emitTasks = (jobId?: string): void => {
      const row = jobId ? database?.getJob(jobId) : null
      if (row) {
        const { payload: _payload, ...job } = row
        emit(IPC.eventTasksChanged, job)
      } else emit(IPC.eventTasksChanged)
    }
    const emitSettings = (): void => emit(IPC.eventSettingsChanged, database?.getSettings())
    const emitAppearance = (appearance: Appearance): void => {
      startup?.setState({ appearance })
      mainWindow?.setBackgroundColor(themeBackground(resolveTheme(appearance, nativeTheme.shouldUseDarkColors)))
      emit(IPC.eventAppearanceChanged, appearance)
      desktopLyrics?.setAppearance(appearance)
      lan?.appearanceChanged(appearance)
    }
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
    const arsenal = new ArsenalService(paths, database, media, audioHost, recording, state => emit(ARSENAL_MONITOR_EVENT, state), emitLibrary, () => rehearsalRecording?.isActive() ?? false)
    recording.arsenal = arsenal
    exporter.arsenal = arsenal
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
      windowControlsRegistered: true,
      arsenal,
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
      emitAppearance,
      emitLibraryUpdate: (update) => emit(IPC.eventLibraryUpdated, update),
      emitLibrary,
      emitTasks
    })
    startup.setState({ phase: 'ready', message: '正在打开曲库…' })
    const mediaReady = media.ready().then(emitMedia).catch((error) => { applicationLogger.error('media validation failed', error); emitMedia() })
    runtime.onChange((info) => emit(IPC.eventRuntimeChanged, info))
    const runtimeReady = runtime.detect()
    void Promise.allSettled([mediaReady, runtimeReady]).then(() => benchmarkMetric('backend-ready'))
    scheduler.kick()
    startupRecoveries = Promise.allSettled([recording.recoverInterruptedSessions(), rehearsalRecording.recoverInterruptedSessions()])
    applicationLogger.info('application ready', { version: app.getVersion(), packaged: app.isPackaged })
  }).catch(error => {
    if (quitting) return
    const message = error instanceof Error ? error.message : String(error)
    logger?.error('application startup failed', error)
    process.stderr.write(`BAND_BUDDY_STARTUP_FAILED ${message}\n`)
    startup?.setState({ phase: 'failed', message: '曲库准备未完成，请关闭后重试。', error: message })
  })
}

app.on('activate', () => {
  if (quitting) return
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
  if (shutdownComplete) return
  event.preventDefault()
  if (shutdownTask) return
  quitting = true
  startup?.cancelWait()
  scheduler?.interruptForExit()
  runtimeManager?.cancelInstall()
  shutdownTask = (async () => {
    await databasePreparation?.cancel().catch(error => logger?.error('database preparation cancellation failed', error))
    databasePreparation = null
    // Finalize recordings before disabling subprocess creation. Recovery also
    // writes the database, so it must finish before will-quit closes SQLite.
    await startupRecoveries
    // Both recording services share one native host; finish rehearsal captures
    // before RecordingService closes that host.
    for (const stop of [() => rehearsalRecording?.shutdown(true), () => recording?.shutdown(true)]) {
      try { await stop() } catch (error) { logger?.error('recording shutdown failed', error) }
    }
    const workers = await Promise.allSettled([
      lan?.setEnabled(false), runtimeManager?.shutdown(), scheduler?.shutdown(),
      shutdownMediaAnalysis(), shutdownProcesses()
    ])
    for (const result of workers) if (result.status === 'rejected') logger?.error('worker shutdown failed', result.reason)
    await logger?.flush()
  })().finally(() => { shutdownComplete = true; app.quit() })
  void shutdownTask.catch(error => { logger?.error('application shutdown failed', error) })
})

app.on('will-quit', () => {
  lan = null
  rehearsalRecording = null
  recording = null
  runtimeManager = null
  desktopLyrics?.destroy()
  desktopLyrics = null
  database?.close()
  database = null
  tray?.destroy()
  tray = null
})

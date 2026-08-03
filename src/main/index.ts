import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  protocol,
  Tray
} from 'electron'
import { IPC } from '@shared/channels.js'
import { BandBuddyDatabase } from './database.js'
import { ExportService } from './exporter.js'
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

protocol.registerSchemesAsPrivileged([{
  scheme: 'bandbuddy-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}])

app.setName('BandBuddy')
const smokeMode = process.env.BANDBUDDY_SMOKE === '1'
const developmentTestRoot = smokeMode || !app.isPackaged ? process.env.BANDBUDDY_TEST_ROOT : undefined
app.setPath('userData', developmentTestRoot ? join(developmentTestRoot, 'appdata') : join(app.getPath('appData'), 'BandBuddy'))
if (process.platform === 'win32') app.setAppUserModelId('com.bandbuddy.desktop')

const currentDirectory = fileURLToPath(new URL('.', import.meta.url))
const rendererFileUrl = pathToFileURL(join(currentDirectory, '../renderer/index.html')).href
const lyricsRendererFileUrl = pathToFileURL(join(currentDirectory, '../renderer/lyrics.html')).href
const trustedRendererUrl = (url: string): boolean => isTrustedRendererUrl(url, process.env.ELECTRON_RENDERER_URL, rendererFileUrl)
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let database: BandBuddyDatabase | null = null
let scheduler: JobScheduler | null = null
let recording: RecordingService | null = null
let rehearsalRecording: RehearsalRecordingService | null = null
let desktopLyrics: DesktopLyricsWindow | null = null
let quitAfterRecording = false

function emit(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function createWindow(paths: AppPaths): BrowserWindow {
  const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(process.cwd(), 'build', 'icon.png')
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    frame: false,
    backgroundColor: '#F5F1EA',
    icon: iconPath,
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
  window.once('ready-to-show', () => window.show())
  window.on('hide', () => emit(IPC.eventWindowHidden))
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
  const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(process.cwd(), 'build', 'icon.png')
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) icon = nativeImage.createEmpty()
  tray = new Tray(icon.resize({ width: 20, height: 20 }))
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
    const logger = new Logger(paths.logsRoot)
    database = new BandBuddyDatabase(paths)
    const media = new MediaService(paths, database, logger)
    media.registerProtocol()
    const runtime = new RuntimeManager(paths, database, logger)
    mainWindow = createWindow(paths)
    const developmentLyricsUrl = process.env.ELECTRON_RENDERER_URL
      ? new URL('lyrics.html', process.env.ELECTRON_RENDERER_URL.endsWith('/') ? process.env.ELECTRON_RENDERER_URL : `${process.env.ELECTRON_RENDERER_URL}/`).href
      : null
    desktopLyrics = new DesktopLyricsWindow({
      preloadPath: join(currentDirectory, '../preload/lyrics.cjs'),
      rendererUrl: developmentLyricsUrl ?? lyricsRendererFileUrl
    })
    createTray(paths)

    const emitLibrary = (): void => emit(IPC.eventLibraryChanged)
    const emitTasks = (): void => emit(IPC.eventTasksChanged)
    const emitSettings = (): void => emit(IPC.eventSettingsChanged, database?.getSettings())
    const emitMedia = (): void => emit(IPC.eventMediaChanged, media.capabilities())
    const emitRehearsals = (): void => emit(IPC.eventRehearsalsChanged)
    scheduler = new JobScheduler(paths, database, runtime, media, logger, emitTasks, emitLibrary)
    const exporter = new ExportService(paths, database, media, logger, emitTasks, () => scheduler?.kick())
    scheduler.setExporter(exporter)
    const imports = new ImportService(paths, database, media, runtime, logger, () => { emitLibrary(); emitTasks() }, () => scheduler?.kick())
    const audioHost = new AudioHostClient(paths, logger)
    recording = new RecordingService(
      paths,
      database,
      media,
      audioHost,
      logger,
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
      logger,
      () => recording?.isActive() ?? false,
      (state) => emit(IPC.eventRehearsalRecordingState, state),
      (meter) => emit(IPC.eventRehearsalRecordingMeter, meter),
      emitRehearsals
    )

    registerIpc({
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
    logger.info('application ready', { version: app.getVersion(), packaged: app.isPackaged })
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
  quitting = true
  scheduler?.interruptForExit()
})

app.on('will-quit', () => {
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

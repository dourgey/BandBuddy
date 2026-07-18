import { mkdirSync } from 'node:fs'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { dialog, ipcMain } from 'electron'
import path from 'node:path'
import { z } from 'zod'
import {
  IPC,
  appSettingsSchema,
  exportRequestSchema,
  importSourceSchema,
  importStemsSchema,
  listSongsSchema,
  practiceStateSchema,
  updateSongSchema,
  uuidSchema
} from '@shared/ipc.js'
import type { BandBuddyDatabase } from './database.js'
import type { ExportService } from './exporter.js'
import type { ImportService } from './imports.js'
import type { JobScheduler } from './jobs.js'
import type { RuntimeManager } from './runtime.js'
import type { MediaService } from './media.js'

interface IpcServices {
  getWindow: () => BrowserWindow | null
  database: BandBuddyDatabase
  imports: ImportService
  jobs: JobScheduler
  runtime: RuntimeManager
  media: MediaService
  exporter: ExportService
  isTrustedUrl: (url: string) => boolean
  emitSettings: () => void
  emitLibrary: () => void
  emitTasks: () => void
}

export function registerIpc(services: IpcServices): void {
  const handle = <T>(channel: string, callback: (event: IpcMainInvokeEvent, input: T) => unknown | Promise<unknown>): void => {
    ipcMain.handle(channel, async (event, input: T) => {
      assertTrustedSender(event, services.getWindow(), services.isTrustedUrl)
      return await callback(event, input)
    })
  }

  handle(IPC.libraryList, (_event, input) => {
    const parsed = listSongsSchema.parse(input ?? {})
    return services.database.listSongs(parsed.query, parsed.filter)
  })
  handle(IPC.libraryGet, (_event, input) => services.database.getSong(uuidSchema.parse(input)))
  handle(IPC.libraryChooseSource, () => services.imports.chooseSource())
  handle(IPC.libraryChooseStems, (_event, input) => services.imports.chooseStems(z.enum(['files', 'folder']).default('files').parse(input)))
  handle(IPC.libraryImportSource, (_event, input) => services.imports.importSource(importSourceSchema.parse(input)))
  handle(IPC.libraryImportStems, (_event, input) => services.imports.importStems(importStemsSchema.parse(input)))
  handle(IPC.libraryUpdate, (_event, input) => {
    const parsed = updateSongSchema.parse(input)
    const result = services.database.updateSong(parsed.id, parsed.patch)
    services.emitLibrary()
    return result
  })
  handle(IPC.libraryDelete, async (_event, input) => {
    await services.imports.deleteSong(uuidSchema.parse(input), (songId) => services.jobs.cancelSongJobs(songId))
  })
  handle(IPC.libraryOpenLocation, (_event, input) => services.imports.openLocation(uuidSchema.parse(input)))
  handle(IPC.libraryReseparate, (_event, input) => services.imports.reSeparate(uuidSchema.parse(input)))
  handle(IPC.practiceSave, (_event, input) => {
    services.database.savePractice(practiceStateSchema.parse(input))
    services.emitLibrary()
  })

  handle(IPC.tasksList, () => services.database.listJobs())
  handle(IPC.tasksCancel, async (_event, input) => services.jobs.cancel(uuidSchema.parse(input)))
  handle(IPC.tasksRetry, (_event, input) => {
    const parsed = z.object({ jobId: uuidSchema, useCpu: z.boolean().default(false) }).parse(input)
    services.jobs.retry(parsed.jobId, parsed.useCpu)
  })
  handle(IPC.tasksClear, () => {
    services.database.clearFinishedJobs()
    services.emitTasks()
  })

  handle(IPC.runtimeGet, () => services.runtime.getInfo())
  handle(IPC.runtimeDetect, () => services.runtime.detect())
  handle(IPC.runtimeInstall, () => services.runtime.install())
  handle(IPC.runtimeCancel, () => services.runtime.cancelInstall())
  handle(IPC.runtimeRepair, () => services.runtime.repair())
  handle(IPC.runtimeRemove, async (_event, input) => services.runtime.removeEnvironment(z.boolean().default(false).parse(input)))
  handle(IPC.runtimeClearModel, () => services.runtime.clearModelCache())

  handle(IPC.settingsGet, () => services.database.getSettings())
  handle(IPC.settingsChooseDataRoot, async (_event, input) => {
    const currentLibraryRoot = z.string().max(1000).optional().parse(input)
    const defaultPath = currentLibraryRoot && path.basename(currentLibraryRoot).toLowerCase() === 'music'
      ? path.dirname(currentLibraryRoot)
      : currentLibraryRoot
    const selected = await dialog.showOpenDialog({
      title: '选择 BandBuddy 数据目录',
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    if (selected.canceled || !selected.filePaths[0]) return null
    const dataRoot = path.resolve(selected.filePaths[0])
    const runtimeRoot = path.join(dataRoot, 'envs')
    return {
      dataRoot,
      libraryRoot: path.join(dataRoot, 'music'),
      runtimeRoot,
      modelRoot: path.join(runtimeRoot, 'models')
    }
  })
  handle(IPC.settingsUpdate, (_event, input) => {
    const settings = appSettingsSchema.parse(input)
    for (const directory of [settings.libraryRoot, settings.runtimeRoot, settings.modelRoot]) {
      mkdirSync(directory, { recursive: true })
    }
    const saved = services.database.saveSettings(settings)
    services.emitSettings()
    void services.runtime.detect()
    return saved
  })

  handle(IPC.mediaCapabilities, () => services.media.capabilities())
  handle(IPC.mediaDetectBpm, (_event, input) => services.media.detectBpm(uuidSchema.parse(input)))

  handle(IPC.exportChoosePath, async (_event, input) => {
    const parsed = z.object({
      kind: z.enum(['stems', 'mix']),
      format: z.enum(['wav', 'flac', 'mp3']),
      songTitle: z.string().min(1).max(200)
    }).parse(input)
    return await services.exporter.choosePath(parsed.kind, parsed.format, parsed.songTitle)
  })
  handle(IPC.exportStart, (_event, input) => services.exporter.start(exportRequestSchema.parse(input)))

  handle(IPC.windowMinimize, () => services.getWindow()?.minimize())
  handle(IPC.windowToggleMaximize, () => {
    const window = services.getWindow()
    if (!window) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })
  handle(IPC.windowClose, () => services.getWindow()?.close())
}

function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow | null, isTrustedUrl: (url: string) => boolean): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('UNTRUSTED_IPC_SENDER')
  }
  if (!isTrustedUrl(event.senderFrame.url)) throw new Error('UNTRUSTED_IPC_ORIGIN')
}

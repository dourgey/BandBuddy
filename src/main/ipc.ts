import { mkdirSync } from 'node:fs'
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import { z } from 'zod'
import {
  IPC,
  appSettingsSchema,
  desktopLyricsPayloadSchema,
  exportRequestSchema,
  importSourceSchema,
  importStemsSchema,
  listSongsSchema,
  practiceStateSchema,
  rehearsalDuplicateSchema,
  rehearsalRecordingStartSchema,
  rehearsalRecordingTrackUpdateSchema,
  rehearsalSaveSchema,
  recordingStartSchema,
  recordingTakeUpdateSchema,
  recordingTrackUpdateSchema,
  updateSongSchema,
  uuidSchema
} from '@shared/ipc.js'
import type { BandBuddyDatabase } from './database.js'
import type { ExportService } from './exporter.js'
import type { ImportService } from './imports.js'
import type { JobScheduler } from './jobs.js'
import type { RuntimeManager } from './runtime.js'
import type { MediaService } from './media.js'
import type { RecordingService } from './recording.js'
import type { DesktopLyricsWindow } from './desktop-lyrics.js'
import type { RehearsalService } from './rehearsals.js'
import type { RehearsalRecordingService } from './rehearsal-recording.js'
import type { LanService } from './lan.js'
import type { Logger } from './logger.js'

interface IpcServices {
  getWindow: () => BrowserWindow | null
  database: BandBuddyDatabase
  lan: LanService
  imports: ImportService
  jobs: JobScheduler
  runtime: RuntimeManager
  media: MediaService
  exporter: ExportService
  recording: RecordingService
  rehearsals: RehearsalService
  rehearsalRecording: RehearsalRecordingService
  desktopLyrics: DesktopLyricsWindow
  logger: Logger
  isTrustedUrl: (url: string) => boolean
  emitSettings: () => void
  emitLibrary: () => void
  emitTasks: () => void
}

export function registerIpc(services: IpcServices): void {
  const handle = <T>(channel: string, callback: (event: IpcMainInvokeEvent, input: T) => unknown | Promise<unknown>): void => {
    ipcMain.handle(channel, async (event, input: T) => {
      assertTrustedSender(event, services.getWindow(), services.isTrustedUrl)
      const startedAt = Date.now()
      services.logger.capture('debug', 'ipc invoke started', { channel })
      try {
        const result = await callback(event, input)
        services.logger.capture('debug', 'ipc invoke completed', { channel, durationMs: Date.now() - startedAt })
        return result
      } catch (error) {
        services.logger.capture('error', 'ipc invoke failed', { channel, durationMs: Date.now() - startedAt, error })
        throw error
      }
    })
  }

  handle(IPC.libraryList, (_event, input) => {
    const parsed = listSongsSchema.parse(input ?? {})
    return services.database.listSongs(parsed.query, parsed.filter)
  })
  handle(IPC.libraryGet, (_event, input) => services.database.getSong(uuidSchema.parse(input)))
  handle(IPC.lanStatus, () => services.lan.status())
  handle(IPC.lanSetEnabled, (_event, input) => services.lan.setEnabled(z.boolean().parse(input)))
  handle(IPC.libraryChooseStems, (_event, input) => services.imports.chooseStems(z.enum(['files', 'folder']).default('files').parse(input)))
  handle(IPC.libraryImportStems, (_event, input) => services.imports.importStems(importStemsSchema.parse(input)))
  handle(IPC.libraryChooseSource, () => services.imports.chooseSource())
  handle(IPC.libraryImportSource, (_event, input) => services.imports.importSource(importSourceSchema.parse(input)))
  handle(IPC.libraryImportLyrics, (_event, input) => services.imports.importLyrics(uuidSchema.parse(input)))
  handle(IPC.libraryUpdate, (_event, input) => {
    const parsed = updateSongSchema.parse(input)
    const result = services.database.updateSong(parsed.id, parsed.patch)
    services.emitLibrary()
    return result
  })
  handle(IPC.libraryDelete, async (_event, input) => {
    const songId = uuidSchema.parse(input)
    if (services.recording.isActive() && services.recording.getState().songId === songId) throw new Error('RECORDING_SESSION_BUSY')
    await services.imports.deleteSong(songId, (id) => services.jobs.cancelSongJobs(id))
  })
  handle(IPC.libraryOpenLocation, (_event, input) => services.imports.openLocation(uuidSchema.parse(input)))
  handle(IPC.libraryReseparate, (_event, input) => services.imports.reSeparate(uuidSchema.parse(input)))
  handle(IPC.libraryRequestGuitarSplit, (_event, input) => services.imports.requestGuitarSplit(uuidSchema.parse(input)))
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
  handle(IPC.settingsSetDebugMode, (_event, input) => {
    const enabled = z.boolean().parse(input)
    const saved = services.database.saveSettings({ ...services.database.getSettings(), debugMode: enabled })
    services.logger.setDebugMode(enabled)
    services.emitSettings()
    return saved
  })
  handle(IPC.settingsRevealDebugLog, () => {
    shell.showItemInFolder(services.logger.ensureDebugLog())
  })
  handle(IPC.settingsUpdate, (_event, input) => {
    const settings = appSettingsSchema.parse(input)
    for (const directory of [settings.libraryRoot, settings.runtimeRoot, settings.modelRoot]) {
      mkdirSync(directory, { recursive: true })
    }
    const saved = services.database.saveSettings(settings)
    services.desktopLyrics.setFontSize(saved.desktopLyricsFontSize)
    services.logger.setDebugMode(saved.debugMode)
    services.emitSettings()
    void services.runtime.detect()
    return saved
  })

  handle(IPC.mediaCapabilities, () => services.media.capabilities())
  handle(IPC.mediaPrepareOutputDevice, (_event, input) =>
    services.recording.prepareOutputDevice(z.string().min(1).max(500).nullable().parse(input)))
  handle(IPC.mediaDetectBpm, (_event, input) => services.media.detectBpm(uuidSchema.parse(input)))
  handle(IPC.mediaDetectKey, async (_event, input) => {
    const result = await services.media.detectKey(uuidSchema.parse(input))
    services.emitLibrary()
    return result
  })

  handle(IPC.exportChoosePath, async (_event, input) => {
    const parsed = z.object({
      kind: z.enum(['stems', 'mix']),
      format: z.enum(['wav', 'flac', 'mp3']),
      songTitle: z.string().min(1).max(200)
    }).parse(input)
    return await services.exporter.choosePath(parsed.kind, parsed.format, parsed.songTitle)
  })
  handle(IPC.exportStart, (_event, input) => services.exporter.start(exportRequestSchema.parse(input)))

  handle(IPC.recordingGetState, () => services.recording.getState())
  handle(IPC.recordingDevices, () => services.recording.devices())
  handle(IPC.recordingStartTest, () => services.recording.startTest())
  handle(IPC.recordingStopTest, () => services.recording.stopTest())
  handle(IPC.recordingStart, (_event, input) => {
    if (services.rehearsalRecording.isActive()) throw new Error('RECORDING_SESSION_BUSY')
    return services.recording.start(recordingStartSchema.parse(input))
  })
  handle(IPC.recordingStop, () => services.recording.stop())
  handle(IPC.recordingCancel, () => services.recording.cancel())
  handle(IPC.recordingUpdateTake, (_event, input) => services.recording.updateTake(recordingTakeUpdateSchema.parse(input)))
  handle(IPC.recordingDeleteTake, (_event, input) => services.recording.deleteTake(uuidSchema.parse(input)))
  handle(IPC.recordingSelectTake, (_event, input) => {
    const parsed = z.object({ recordingTrackId: uuidSchema, takeId: uuidSchema.nullable() }).parse(input)
    services.recording.selectTake(parsed.recordingTrackId, parsed.takeId)
  })
  handle(IPC.recordingCreateTrack, (_event, input) => services.recording.createTrack(uuidSchema.parse(input)))
  handle(IPC.recordingUpdateTrack, (_event, input) => {
    const parsed = recordingTrackUpdateSchema.parse(input)
    return services.recording.updateTrack(parsed.recordingTrackId, parsed.patch)
  })

  handle(IPC.rehearsalList, () => services.rehearsals.list())
  handle(IPC.rehearsalGet, (_event, input) => services.rehearsals.get(uuidSchema.parse(input)))
  handle(IPC.rehearsalCreate, (_event, input) => {
    const name = z.string().trim().min(1).max(100).optional().parse(input)
    return services.rehearsals.create(name)
  })
  handle(IPC.rehearsalSave, (_event, input) => services.rehearsals.save(rehearsalSaveSchema.parse(input)))
  handle(IPC.rehearsalDuplicate, (_event, input) => {
    const parsed = rehearsalDuplicateSchema.parse(input)
    return services.rehearsals.duplicate(parsed.rehearsalId, parsed.revisionId)
  })
  handle(IPC.rehearsalDelete, async (_event, input) => {
    const rehearsalId = uuidSchema.parse(input)
    if (services.rehearsalRecording.isActive() && services.rehearsalRecording.getState().rehearsalId === rehearsalId) {
      throw new Error('RECORDING_SESSION_BUSY')
    }
    await services.rehearsals.delete(rehearsalId)
  })
  handle(IPC.rehearsalRecordingCreateTrack, (_event, input) => {
    return services.rehearsalRecording.createTrack(uuidSchema.parse(input))
  })
  handle(IPC.rehearsalRecordingUpdateTrack, (_event, input) => {
    const parsed = rehearsalRecordingTrackUpdateSchema.parse(input)
    return services.rehearsalRecording.updateTrack(parsed.recordingTrackId, parsed.patch)
  })
  handle(IPC.rehearsalRecordingSelectTake, (_event, input) => {
    const parsed = z.object({ recordingTrackId: uuidSchema, takeId: uuidSchema.nullable() }).parse(input)
    services.rehearsalRecording.selectTake(parsed.recordingTrackId, parsed.takeId)
  })
  handle(IPC.rehearsalRecordingUpdateTake, (_event, input) => {
    return services.rehearsalRecording.updateTake(recordingTakeUpdateSchema.parse(input))
  })
  handle(IPC.rehearsalRecordingDeleteTake, (_event, input) => {
    return services.rehearsalRecording.deleteTake(uuidSchema.parse(input))
  })
  handle(IPC.rehearsalRecordingGetState, () => services.rehearsalRecording.getState())
  handle(IPC.rehearsalRecordingStart, (_event, input) => {
    return services.rehearsalRecording.start(rehearsalRecordingStartSchema.parse(input))
  })
  handle(IPC.rehearsalRecordingPause, () => services.rehearsalRecording.pause())
  handle(IPC.rehearsalRecordingResume, () => services.rehearsalRecording.resume())
  handle(IPC.rehearsalRecordingStop, () => services.rehearsalRecording.stop())
  handle(IPC.rehearsalRecordingCancel, () => services.rehearsalRecording.cancel())

  handle(IPC.desktopLyricsSetVisible, (_event, input) => {
    const visible = z.boolean().parse(input)
    services.desktopLyrics.setFontSize(services.database.getSettings().desktopLyricsFontSize)
    return services.desktopLyrics.setVisible(visible)
  })
  ipcMain.on(IPC.desktopLyricsUpdate, (event, input) => {
    try {
      assertTrustedSender(event, services.getWindow(), services.isTrustedUrl)
      services.desktopLyrics.update(desktopLyricsPayloadSchema.parse(input))
    } catch {
      // Fire-and-forget updates are ignored if the sender or payload is invalid.
    }
  })

  handle(IPC.windowMinimize, () => services.getWindow()?.minimize())
  handle(IPC.windowToggleMaximize, () => {
    const window = services.getWindow()
    if (!window) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })
  handle(IPC.windowIsMaximized, () => services.getWindow()?.isMaximized() ?? false)
  handle(IPC.windowClose, () => services.getWindow()?.close())
}

function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent, window: BrowserWindow | null, isTrustedUrl: (url: string) => boolean): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('UNTRUSTED_IPC_SENDER')
  }
  if (!isTrustedUrl(event.senderFrame.url)) throw new Error('UNTRUSTED_IPC_ORIGIN')
}

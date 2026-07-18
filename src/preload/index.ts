import { contextBridge, ipcRenderer } from 'electron'
import type { BandBuddyApi } from '@shared/bridge.js'
import { IPC } from '@shared/channels.js'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: BandBuddyApi = {
  library: {
    list: (input = {}) => ipcRenderer.invoke(IPC.libraryList, input),
    get: (songId) => ipcRenderer.invoke(IPC.libraryGet, songId),
    chooseSource: () => ipcRenderer.invoke(IPC.libraryChooseSource),
    chooseStems: (mode = 'files') => ipcRenderer.invoke(IPC.libraryChooseStems, mode),
    importSource: (options) => ipcRenderer.invoke(IPC.libraryImportSource, options),
    importStems: (options) => ipcRenderer.invoke(IPC.libraryImportStems, options),
    update: (input) => ipcRenderer.invoke(IPC.libraryUpdate, input),
    delete: (songId) => ipcRenderer.invoke(IPC.libraryDelete, songId),
    openLocation: (songId) => ipcRenderer.invoke(IPC.libraryOpenLocation, songId),
    reSeparate: (songId) => ipcRenderer.invoke(IPC.libraryReseparate, songId),
    savePractice: (state) => ipcRenderer.invoke(IPC.practiceSave, state),
    onChanged: (callback) => subscribe<void>(IPC.eventLibraryChanged, callback)
  },
  tasks: {
    list: () => ipcRenderer.invoke(IPC.tasksList),
    cancel: (jobId) => ipcRenderer.invoke(IPC.tasksCancel, jobId),
    retry: (jobId, useCpu = false) => ipcRenderer.invoke(IPC.tasksRetry, { jobId, useCpu }),
    clearFinished: () => ipcRenderer.invoke(IPC.tasksClear),
    onChanged: (callback) => subscribe<void>(IPC.eventTasksChanged, callback)
  },
  runtime: {
    get: () => ipcRenderer.invoke(IPC.runtimeGet),
    detect: () => ipcRenderer.invoke(IPC.runtimeDetect),
    install: () => ipcRenderer.invoke(IPC.runtimeInstall),
    cancel: () => ipcRenderer.invoke(IPC.runtimeCancel),
    repair: () => ipcRenderer.invoke(IPC.runtimeRepair),
    remove: (includeModels = false) => ipcRenderer.invoke(IPC.runtimeRemove, includeModels),
    clearModel: () => ipcRenderer.invoke(IPC.runtimeClearModel),
    onChanged: (callback) => subscribe(IPC.eventRuntimeChanged, callback)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    chooseDataRoot: (currentLibraryRoot) => ipcRenderer.invoke(IPC.settingsChooseDataRoot, currentLibraryRoot),
    update: (settings) => ipcRenderer.invoke(IPC.settingsUpdate, settings),
    onChanged: (callback) => subscribe(IPC.eventSettingsChanged, callback)
  },
  media: {
    capabilities: () => ipcRenderer.invoke(IPC.mediaCapabilities),
    detectBpm: (songId) => ipcRenderer.invoke(IPC.mediaDetectBpm, songId),
    onChanged: (callback) => subscribe(IPC.eventMediaChanged, callback)
  },
  export: {
    choosePath: (kind, format, songTitle) => ipcRenderer.invoke(IPC.exportChoosePath, { kind, format, songTitle }),
    start: (request) => ipcRenderer.invoke(IPC.exportStart, request)
  },
  window: {
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
    close: () => ipcRenderer.invoke(IPC.windowClose),
    onHidden: (callback) => subscribe<void>(IPC.eventWindowHidden, callback)
  }
}

contextBridge.exposeInMainWorld('bandbuddy', api)
